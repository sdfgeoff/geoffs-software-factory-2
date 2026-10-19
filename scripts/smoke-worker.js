import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createApp } from '../server/app.js';

// Opt-in real subscription test. All Commonroom data is disposable. Authentication
// is linked locally for this test; deployed workers use their own device login.
const dataDir = mkdtempSync(join(tmpdir(), 'commonroom-real-worker-'));
let app, child, output = '';
async function waitFor(check, label, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child?.exitCode != null) throw new Error(`Worker exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out ${label}. Worker status: ${output}`);
}
try {
  app = await createApp({ dataDir, agentsEnabled: false });
  const address = await app.listen(0, '127.0.0.1');
  const admin = app.store.setup({ username: 'worker-smoke-admin', display_name: 'Worker smoke admin', password: 'worker smoke test password' });
  const base = `http://127.0.0.1:${address.port}`, cookie = `commonroom=${app.store.createSession(admin.id)}`;
  async function request(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, result.error); return result;
  }
  const registration = await request('/api/admin/workers', { name: 'Real disposable worker', capacity: 1 });
  const stateDir = join(dataDir, 'worker-state'), codexDir = join(stateDir, 'codex'); mkdirSync(codexDir, { recursive: true });
  const authSource = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  assert.ok(existsSync(authSource), 'A host ChatGPT auth cache is needed for this opt-in smoke test.');
  symlinkSync(authSource, join(codexDir, 'auth.json'));
  const enrollmentFile = join(dataDir, 'enrollment.secret'); writeFileSync(enrollmentFile, registration.enrollment_token, { mode: 0o600 });
  const general = app.store.all('SELECT id FROM channels WHERE name=\'general\'')[0];
  const agent = await request('/api/admin/agents', { username: 'remote-smoke', display_name: 'Remote smoke', worker_id: registration.worker.id, subscriptions: [general.id],
    instructions: `Integration test: On your first notification, confirm your dedicated folder is empty with list_files. Create proof.txt containing exactly COMMONROOM_REMOTE_FILE_OK with write_file. Read it back. Use a built-in shell command to create ${join(stateDir, 'host-proof.txt')} containing exactly COMMONROOM_REMOTE_HOST_OK (a disposable test file outside your dedicated folder, explicitly authorized). Then post exactly COMMONROOM_REMOTE_SMOKE_OK to channel ${general.id}, attaching proof.txt via attachments:[{path:"proof.txt"}]. Do this once. On all later notifications, finish silently without posts or file changes.` });
  child = spawn(process.execPath, [resolve('worker/index.js'), '--server', base, '--enroll-file', enrollmentFile, '--state', stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-3000); });
  const idle = () => app.store.get('SELECT last_run_at,status,last_error FROM agents WHERE user_id=?', agent.user_id);
  await waitFor(() => { const state = idle(); if (state.status === 'error') throw new Error(state.last_error); return state.last_run_at && state.status === 'idle' && app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agent.user_id).n === 0; }, 'real remote turn');
  const workspace = join(stateDir, 'agents', String(agent.user_id), 'workspace');
  assert.equal(readFileSync(join(workspace, 'proof.txt'), 'utf8'), 'COMMONROOM_REMOTE_FILE_OK');
  assert.equal(readFileSync(join(stateDir, 'host-proof.txt'), 'utf8'), 'COMMONROOM_REMOTE_HOST_OK');
  assert.deepEqual(app.store.all('SELECT body FROM messages WHERE user_id=?', agent.user_id).map(row => row.body), ['COMMONROOM_REMOTE_SMOKE_OK']);
  const post = app.store.get('SELECT id FROM messages WHERE user_id=?', agent.user_id);
  assert.equal(app.store.tickets.messageAttachments(post.id)[0].filename, 'proof.txt');
  const threadFile = join(stateDir, 'agents', String(agent.user_id), 'thread.json'), firstThread = JSON.parse(readFileSync(threadFile)).thread_id;
  const firstRun = idle().last_run_at; app.store.post(admin.id, general.id, 'Remote resume check: remain silent.');
  await waitFor(() => { const state = idle(); if (state.status === 'error') throw new Error(state.last_error); return state.last_run_at !== firstRun && state.status === 'idle' && app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agent.user_id).n === 0; }, 'real remote resume');
  assert.equal(JSON.parse(readFileSync(threadFile)).thread_id, firstThread);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM messages WHERE user_id=?', agent.user_id).n, 1);
  console.log('Real remote worker smoke passed: ChatGPT auth, leases, worker files, host writes, attachment upload, persistent conversation and optional silence.');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 15000))]);
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
  await app?.close(); rmSync(dataDir, { recursive: true, force: true });
}
