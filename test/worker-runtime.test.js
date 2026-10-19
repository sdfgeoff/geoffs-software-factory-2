import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { WorkerRuntime } from '../worker/runtime.js';
import { createRemoteBridge } from '../worker/bridge.js';

const settle = async runtime => { const deadline = Date.now() + 5000; while (runtime.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(runtime.active.size, 0); };
async function fixture(t, onTurn = async () => {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'commonroom-master-test-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'commonroom-worker-test-'));
  const app = await createApp({ dataDir, agentsEnabled: false }); const address = await app.listen(0, '127.0.0.1');
  const admin = app.store.setup({ username: 'admin', display_name: 'Admin', password: 'safe test password' });
  const channel = app.store.channels(admin.id)[0];
  const enrolled = app.workers.create({ name: 'Worker test', capacity: 1 });
  const agent = app.store.createAgent({ username: 'remote-ai', display_name: 'Remote AI', instructions: 'Respond only when useful.', subscriptions: [channel.id], worker_id: enrolled.worker.id });
  const starts = [];
  const factory = cwd => {
    let params;
    return { async initialize() {}, async request(method, input) {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
      if (method === 'model/list') return { data: [{ model: 'test-model', displayName: 'Test model', isDefault: true }] };
      params = input; starts.push({ method, params }); return { thread: { id: input.threadId || `remote-thread-${starts.length}` }, model: 'test-model' };
    }, async turn(thread, prompt) { await onTurn({ cwd, thread, prompt, params }); }, stop() {} };
  };
  const runtime = new WorkerRuntime({ stateDir, server: `http://127.0.0.1:${address.port}`, clientFactory: factory });
  await runtime.enroll(enrolled.enrollment_token);
  t.after(async () => { await runtime.stop(); await app.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });
  const due = () => app.store.run('UPDATE notifications SET due_at=0');
  return { app, admin, channel, agent, runtime, stateDir, dataDir, starts, factory, due };
}
const bridgeFor = params => { const env = params.config.mcp_servers.commonroom.env; return createRemoteBridge({ server: env.COMMONROOM_URL, token: env.COMMONROOM_WORKER_TOKEN, jobId: env.COMMONROOM_JOB_ID, leaseToken: env.COMMONROOM_LEASE_TOKEN, workspace: env.COMMONROOM_WORKSPACE }); };

test('outbound worker enrolls, runs remote agent tools with local files, and resumes only its own persistent history', async t => {
  let posts = 0;
  const context = await fixture(t, async ({ cwd, params, prompt }) => {
    assert.equal(params.sandbox, 'danger-full-access'); assert.equal(params.approvalPolicy, 'never');
    assert.match(prompt, /responding is always optional/);
    const bridge = bridgeFor(params);
    if (!posts++) {
      assert.deepEqual((await bridge('list_files')).entries, []);
      await bridge('write_file', { path: 'proof.txt', content: 'WORKER_LOCAL_ONLY' });
      const posted = await bridge('post_message', { channel_id: context.channel.id, body: 'Remote file', attachments: [{ path: 'proof.txt' }] });
      assert.equal(posted.attachments.length, 1);
      await bridge('read_attachment', { attachment_id: posted.attachments[0].id, destination: 'copy.txt' });
      assert.equal(readFileSync(join(cwd, 'copy.txt'), 'utf8'), 'WORKER_LOCAL_ONLY');
    }
  });
  const { app, runtime, stateDir, dataDir, agent, due, starts } = context;
  assert.equal(existsSync(join(stateDir, 'codex/auth.json')), false, 'worker never copies host login');
  due(); await app.agents.run(agent); assert.equal(app.agents.running.size, 0, 'master cannot execute worker-assigned agents');
  await runtime.tick(); await settle(runtime);
  assert.equal(app.store.all('SELECT * FROM messages WHERE user_id=?', agent.user_id).length, 1);
  assert.equal(existsSync(join(dataDir, 'agents', String(agent.user_id), 'workspace', 'proof.txt')), false);
  assert.equal(app.store.get('SELECT thread_id FROM agents WHERE user_id=?', agent.user_id).thread_id, null, 'master conversation is independent');
  assert.equal(app.store.get('SELECT model FROM worker_agent_state WHERE worker_id=? AND agent_id=?', runtime.config.worker_id, agent.user_id).model, 'test-model');
  const saved = JSON.parse(readFileSync(join(stateDir, 'worker.json'))); assert.ok(saved.token); assert.equal(saved.server, runtime.server);
  app.store.run("INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,'check_in',0)", agent.user_id);
  runtime.models = [{ id: 'new-worker-default', name: 'New default', default: true }];
  await runtime.tick(); await settle(runtime);
  assert.equal(starts[0].method, 'thread/start'); assert.equal(starts[1].method, 'thread/resume');
  assert.equal(starts[1].params.threadId, starts[0].params.threadId || 'remote-thread-1');
  assert.equal(starts[1].params.model, 'new-worker-default', 'Default follows worker catalog instead of an older conversation model');
  assert.equal(app.store.all('SELECT * FROM messages WHERE user_id=?', agent.user_id).length, 1, 'silent turn stays private');
});

test('remote bridge retries an ambiguous network response with the same idempotency key and never forwards local paths', async t => {
  const { app, runtime, channel, agent, due } = await fixture(t);
  due(); await runtime.heartbeat(); const { job } = await runtime.api('/api/workers/claim', {});
  let ambiguous = true; const requests = [];
  const bridge = createRemoteBridge({ server: runtime.server, token: runtime.config.token, jobId: job.id, leaseToken: job.lease_token, workspace: runtime.stateDir,
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); const result = await fetch(url, options); if (ambiguous) { ambiguous = false; await result.text(); throw new Error('Response lost after server committed.'); } return result; } });
  await bridge('post_message', { channel_id: channel.id, body: 'Exactly once' });
  assert.equal(requests[0].request_id, requests[1].request_id);
  assert.equal(app.store.all('SELECT * FROM messages WHERE user_id=?', agent.user_id).length, 1);
  const before = requests.length; await bridge('write_file', { path: 'local.txt', content: 'Local' }); assert.equal(requests.length, before);
  assert.equal(readFileSync(join(runtime.stateDir, 'local.txt'), 'utf8'), 'Local');
  await runtime.complete(job.id, { lease_token: job.lease_token, cancelled: true });
});

test('pending completion acknowledgement survives worker restart and is included in heartbeat lease renewal', async t => {
  const { runtime, stateDir, factory } = await fixture(t);
  const payload = { lease_token: 'test-lease', thread_id: 'persisted-thread' };
  runtime.completions.set(123, payload); runtime.saveCompletions();
  const resumed = new WorkerRuntime({ stateDir, clientFactory: factory });
  t.after(async () => resumed.stop());
  assert.deepEqual(resumed.completions.get(123), payload);
  const sent = []; resumed.api = async (path, input) => { sent.push({ path, input }); return { commands: [], active_leases: [123] }; };
  await resumed.heartbeat();
  assert.ok(sent.find(entry => entry.path.endsWith('/heartbeat')).input.running.includes(123));
  resumed.completions.clear(); runtime.completions.clear();
});

test('heartbeat fencing and local lease deadline stop the worker Codex process', async t => {
  const { runtime } = await fixture(t);
  let stopped = 0; const state = { client: { stop() { stopped++; } }, cancelled: false, leaseDeadline: Date.now() + 75000 };
  runtime.active.set(55, state); runtime.refreshAt = Date.now() + 60000;
  const original = runtime.api; runtime.api = async () => ({ commands: [], active_leases: [], cancelled: [55] });
  await runtime.heartbeat(); assert.equal(state.cancelled, true); assert.ok(stopped > 0);
  state.cancelled = false; state.leaseDeadline = Date.now() - 1;
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(state.cancelled, true);
  runtime.active.delete(55); runtime.api = original;
});

test('device authentication exposes only the verification link/code and supports cancellation', async t => {
  const { runtime } = await fixture(t);
  runtime.binary = process.execPath;
  writeFileSync(join(runtime.stateDir, 'login'), `process.stdout.write('Go to https://auth.openai.com/codex/device\\nCode ABCD-EFGH\\nSENSITIVE_AUTH_TOKEN=never-report-this\\n'); setTimeout(()=>process.exit(0),400);`);
  runtime.startAuth(); const original = runtime.authProcess; runtime.startAuth(); assert.equal(runtime.authProcess, original);
  const deadline = Date.now() + 3000;
  while (runtime.auth.flow.status === 'starting' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.auth.flow.verification_url, 'https://auth.openai.com/codex/device');
  assert.equal(runtime.auth.flow.user_code, 'ABCD-EFGH');
  assert.equal(runtime.auth.flow.status, 'awaiting_user');
  assert.ok(!JSON.stringify(runtime.status()).includes('SENSITIVE_AUTH_TOKEN'));
  while (runtime.authProcess && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.auth.flow.status, 'completed');
  runtime.startAuth(); runtime.cancelAuth(); assert.equal(runtime.authProcess, null); assert.equal(runtime.auth.flow.status, 'cancelled');
});

test('CLI status and duplicate locks do not mark a live worker offline, and restart does not need the enrollment file', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { hostname } = await import('node:os'); const { unlinkSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { runtime, app } = await fixture(t); await runtime.heartbeat();
  const cli = fileURLToPath(new URL('../worker/index.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [cli, '--state', runtime.stateDir, ...args], { env: { ...process.env, CODEX_BIN: '/does-not-exist-test-only' } });
  const status = await run(['--status']); assert.ok(!status.stdout.includes(runtime.config.token));
  assert.equal(app.workers.row(runtime.config.worker_id).status, 'ready');
  const started = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[19];
  writeFileSync(join(runtime.stateDir, 'worker.lock'), JSON.stringify({ pid: process.pid, started, host: hostname() }));
  await assert.rejects(run(['--once']), error => error.code === 1 && /already locked/.test(error.stderr));
  assert.equal(app.workers.row(runtime.config.worker_id).status, 'ready');
  unlinkSync(join(runtime.stateDir, 'worker.lock'));
  await run(['--once', '--enroll-file', '/missing-enrollment-file-test-only']);
  assert.equal(existsSync(join(runtime.stateDir, 'worker.lock')), false);
});

test('worker concurrency follows admin capacity changes and persists its last known limit', async t => {
  const { runtime, app } = await fixture(t);
  app.workers.update(runtime.config.worker_id, { capacity: 3 });
  await runtime.heartbeat(); assert.equal(runtime.capacity, 3);
  assert.equal(JSON.parse(readFileSync(join(runtime.stateDir, 'worker.json'))).capacity, 3);
  app.workers.update(runtime.config.worker_id, { capacity: 1 });
  await runtime.heartbeat(); assert.equal(runtime.capacity, 1);
});
