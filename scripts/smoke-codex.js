import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient } from '../server/codex.js';
import { createApp } from '../server/app.js';

// This opt-in test uses the host ChatGPT subscription, but an entirely separate app DB/workspace.
const dataDir = mkdtempSync(join(tmpdir(), 'commonroom-codex-smoke-'));
const commandEvents = [];
const app = await createApp({ dataDir, clientFactory: options => {
  const client = new CodexClient({ codexHome: join(dataDir, 'codex'), cwd: options?.cwd || dataDir });
  client.on('notification', msg => { if (msg.method === 'item/completed' && msg.params.item?.type === 'commandExecution') commandEvents.push(msg.params.item); });
  if (process.env.SMOKE_TRACE) client.on('notification', msg => {
    if (['item/completed', 'mcpServer/startupStatus', 'error', 'warning'].includes(msg.method)) console.log(JSON.stringify(msg));
  });
  return client;
} });
try {
  const address = await app.listen(0, '127.0.0.1');
  const admin = app.store.setup({ username: 'smoke-admin', display_name: 'Smoke admin', password: 'smoke-test-password-only' });
  const channel = app.store.all('SELECT id FROM channels WHERE name=\'general\'')[0];
  const agent = app.store.createAgent({ username: 'smoke-agent', display_name: 'Smoke Agent', subscriptions: [channel.id],
    instructions: `This is an integration test. On the welcome event, use list_files to confirm your dedicated folder is empty. Use write_file to create proof.txt with exactly COMMONROOM_FILE_OK. Read proof.txt back with read_file. Then use the built-in command execution tool (not MCP write_file) to run python3 in your dedicated folder; make Python create command-proof.txt containing exactly COMMONROOM_COMMAND_OK, then edit it by appending exactly _EDITED. Execute a second shell command to read command-proof.txt back. Use list_channels and read_channel to discover context. If and only if the file round trip succeeds, use post_message to send exactly COMMONROOM_SMOKE_OK to channel ID ${channel.id}. Finish without any other posts. On later message notifications, stay silent and do not change files.` });
  const workspace = app.agents.ensureWorkspace(agent.user_id);
  assert.deepEqual(readdirSync(workspace), []);
  const info = await app.agents.info();
  assert.equal(info.connected, true, info.error);
  console.log('ChatGPT subscription connected; model catalog available.');
  app.store.run('UPDATE notifications SET due_at=0 WHERE agent_id=?', agent.user_id);
  const deadline = Date.now() + 240000;
  let finished = false;
  while (Date.now() < deadline) {
    const state = app.store.get('SELECT * FROM agents WHERE user_id=?', agent.user_id);
    if (state.status === 'error') throw new Error(state.last_error);
    if (state.last_run_at && state.status === 'idle') { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(finished, 'Agent did not complete within four minutes.');
  assert.equal(readFileSync(join(workspace, 'proof.txt'), 'utf8'), 'COMMONROOM_FILE_OK');
  assert.equal(readFileSync(join(workspace, 'command-proof.txt'), 'utf8'), 'COMMONROOM_COMMAND_OK_EDITED');
  assert.ok(commandEvents.some(item => item.exitCode === 0), 'No successful built-in command execution observed.');
  assert.ok(app.store.get('SELECT model FROM agents WHERE user_id=?', agent.user_id).model, 'Resolved model was not persisted.');
  const posts = app.store.all('SELECT body FROM messages WHERE user_id=?', agent.user_id);
  assert.deepEqual(posts.map(p => p.body), ['COMMONROOM_SMOKE_OK']);
  console.log('Real inference discovered MCP, browsed channels, ran a command, created/edited a file in its folder, persisted its model, and explicitly posted once.');
  // A second notification verifies that the runner does not publish final assistant text.
  app.store.post(admin.id, channel.id, 'Acknowledge silently for the smoke test.');
  app.store.run('UPDATE notifications SET due_at=0 WHERE agent_id=?', agent.user_id);
  const previous = app.store.get('SELECT last_run_at FROM agents WHERE user_id=?', agent.user_id).last_run_at;
  const silentDeadline = Date.now() + 240000;
  let silentFinished = false;
  while (Date.now() < silentDeadline) {
    const state = app.store.get('SELECT * FROM agents WHERE user_id=?', agent.user_id);
    if (state.status === 'error') throw new Error(state.last_error);
    if (state.last_run_at !== previous && state.status === 'idle') { silentFinished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(silentFinished, 'Silent turn did not complete.');
  assert.equal(app.store.get('SELECT COUNT(*) count FROM messages WHERE user_id=?', agent.user_id).count, 1);
  console.log('Resumed persistent conversation completed a notification without posting.');
  const sentinel = join(dataDir, 'outside-sentinel.txt');
  writeFileSync(sentinel, 'UNCHANGED');
  const probe = new CodexClient({ codexHome: join(dataDir, 'codex'), cwd: workspace });
  if (process.env.SMOKE_TRACE) probe.on('notification', msg => { if (['item/completed', 'error'].includes(msg.method)) console.log(JSON.stringify(msg)); });
  try {
    await probe.initialize();
    const thread = await probe.request('thread/start', { cwd: workspace, sandbox: 'workspace-write', approvalPolicy: 'never',
      baseInstructions: 'You are testing a sandbox in disposable test directories. Use the built-in command tool to execute the exact Python program requested. Do not ask for elevated permissions. Finish when it has completed.',
      config: { sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true }, features: { shell_tool: true, unified_exec: true } } });
    const program = `from pathlib import Path\np=Path(${JSON.stringify(sentinel)})\ntry:\n p.write_text('UNEXPECTED_WRITE')\nexcept OSError as error:\n if error.errno not in (1,13,30): raise\n Path('sandbox-proof.txt').write_text('OUTSIDE_DENIED')\nelse:\n Path('sandbox-proof.txt').write_text('OUTSIDE_ALLOWED')`;
    await probe.turn(thread.thread.id, `Execute python3 -c with this exact program, inside your current working directory:\n${program}`);
    assert.equal(readFileSync(sentinel, 'utf8'), 'UNCHANGED');
    assert.equal(readFileSync(join(workspace, 'sandbox-proof.txt'), 'utf8'), 'OUTSIDE_DENIED');
    console.log('Built-in shell write to a harmless sibling sentinel was denied by the actual sandbox.');
  } finally { probe.stop(); }
  console.log(`App server reachable on loopback port ${address.port}; smoke test passed.`);
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
