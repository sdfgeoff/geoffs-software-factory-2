import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';

// Opt-in Docker integration. Uses a real container and MCP, with fake Codex inference.
const exec = promisify(execFile);
const docker = args => exec('docker', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-container-test-'));
const suffix = randomUUID().slice(0, 8), container = `commonroom-worker-test-${suffix}`, volume = `${container}-state`;
let app, enrollmentToken = '';
async function waitFor(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const savedHosts = process.env.ALLOWED_HOSTS;
  process.env.ALLOWED_HOSTS = [savedHosts, 'host.docker.internal'].filter(Boolean).join(',');
  try { app = await createApp({ dataDir, agentsEnabled: false }); }
  finally { if (savedHosts === undefined) delete process.env.ALLOWED_HOSTS; else process.env.ALLOWED_HOSTS = savedHosts; }
  const address = await app.listen(0, '0.0.0.0'), base = `http://127.0.0.1:${address.port}`;
  let cookie;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${data.error || ''}`); return data;
  }
  await request('/api/setup', 'POST', { username: 'container-admin', display_name: 'Container admin', password: 'container test password' });
  const enrolled = await request('/api/admin/workers', 'POST', { name: 'Container worker', capacity: 1 });
  enrollmentToken = enrolled.enrollment_token;
  assert.ok(enrollmentToken);
  const workerId = enrolled.worker.id;
  const general = app.store.all('SELECT id FROM channels WHERE name=\'general\'')[0];
  const agentInput = { username: 'container-bot', display_name: 'Container bot', instructions: 'Run the deterministic container integration scenario.', subscriptions: [general.id], model: '', enabled: true, worker_id: workerId };
  const agent = await request('/api/admin/agents', 'POST', agentInput);
  const agentId = agent.user_id;
  const secretFile = join(dataDir, 'enroll.secret');
  await writeFile(secretFile, enrollmentToken, { mode: 0o644 });
  await docker(['volume', 'create', volume]);
  await docker(['run', '--detach', '--name', container, '--init', '--add-host=host.docker.internal:host-gateway',
    '--mount', `type=volume,source=${volume},target=/state`,
    '--mount', `type=bind,source=${secretFile},target=/run/secrets/enrollment,readonly`,
    '--mount', `type=bind,source=${resolve('test/fixtures/fake-worker-codex.mjs')},target=/app/test/fixtures/fake-worker-codex.mjs,readonly`,
    '--env', 'CODEX_BIN=/app/test/fixtures/fake-worker-codex.mjs', '--env', `FAKE_WORKER_CHANNEL_ID=${general.id}`,
    process.env.WORKER_TEST_IMAGE || 'commonroom-worker:local', '--server', `http://host.docker.internal:${address.port}`, '--state', '/state', '--enroll-file', '/run/secrets/enrollment']);
  await waitFor(() => app.store.get("SELECT COUNT(*) n FROM messages WHERE user_id=? AND body='COMMONROOM_CONTAINER_WORKER_OK'", agentId).n === 1, 'container enrollment, lease and MCP post');
  await waitFor(() => app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agentId).n === 0, 'first job acknowledgement');
  const post = app.store.get('SELECT id FROM messages WHERE user_id=?', agentId);
  const attachment = app.store.tickets.messageAttachments(post.id)[0];
  assert.equal(attachment.filename, 'container-proof.txt');
  const proofProgram = `const fs=require('node:fs'),p=require('node:path');let found;function scan(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())scan(f);else if(e.name==='last-turn.json')found={...JSON.parse(fs.readFileSync(f,'utf8')),proof:fs.readFileSync(p.join(d,'container-proof.txt'),'utf8')};}}scan('/state/agents');console.log(JSON.stringify(found));`;
  const firstProof = JSON.parse((await docker(['exec', container, 'node', '-e', proofProgram])).stdout);
  assert.equal(firstProof.proof, 'COMMONROOM_CONTAINER_FILE_OK');
  assert.equal(firstProof.sandbox, 'danger-full-access');
  console.log('Container enrolled, claimed its assigned agent, wrote on worker disk and uploaded a file through MCP.');
  await docker(['stop', '--time', '10', container]);
  await request(`/api/admin/agents/${agentId}`, 'PUT', { ...agentInput, instructions: 'Updated centrally while worker was offline.' });
  app.store.post(1, general.id, 'Check the resumed remote agent.');
  assert.ok(app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agentId).n > 0);
  await docker(['start', container]);
  await waitFor(() => app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agentId).n === 0, 'restart with saved credentials and persisted conversation');
  const resumedProof = JSON.parse((await docker(['exec', container, 'node', '-e', proofProgram])).stdout);
  assert.equal(resumedProof.thread_id, firstProof.thread_id);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM messages WHERE user_id=?', agentId).n, 1, 'silent resume must not duplicate a post');
  await request(`/api/admin/workers/${workerId}`, 'PUT', { revoked: true });
  app.store.post(1, general.id, 'Work remains queued after revocation.');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.ok(app.store.get('SELECT COUNT(*) n FROM notifications WHERE agent_id=?', agentId).n > 0);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM messages WHERE user_id=?', agentId).n, 1);
  console.log('Restart retained credentials/files/conversation; UI configuration applied; revocation stopped dispatch.');
} catch (error) {
  const log = await docker(['logs', '--tail', '20', container]).catch(() => ({ stdout: '', stderr: '' }));
  const redact = value => String(value).replaceAll(enrollmentToken || 'NEVER_A_SECRET', '[redacted]');
  console.error(redact(error.stack || error.message)); console.error(redact(log.stdout + log.stderr)); process.exitCode = 1;
} finally {
  await docker(['rm', '--force', container]).catch(() => {});
  await docker(['volume', 'rm', '--force', volume]).catch(() => {});
  await app?.close(); await rm(dataDir, { recursive: true, force: true });
}
