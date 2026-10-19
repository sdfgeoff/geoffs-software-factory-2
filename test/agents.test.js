import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Agents } from '../server/agents.js';
import { prepareCodexHome } from '../server/codex.js';

async function fixture(t, behavior = async () => {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-agent-test-'));
  const path = join(dataDir, 'commonroom.sqlite');
  const store = new Store(path);
  const admin = store.setup({ username: 'admin', display_name: 'Admin', password: 'test password 123' });
  const channel = store.channels(admin.id)[0];
  const make = (username, subscriptions = [channel.id]) => store.createAgent({ username, display_name: username, instructions: 'Speak when useful. Silence is welcome.', subscriptions });
  const calls = [];
  const clientOptions = [];
  const agents = new Agents(store, { dataDir, enabled: false, clientFactory: options => {
    clientOptions.push(options);
    return {
    async initialize() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      return { thread: { id: 'persistent-test-thread' } };
    },
    async turn(thread, prompt) { await behavior({ agents, store, thread, prompt }); return { status: 'completed' }; },
    stop() {},
    };
  } });
  t.after(async () => { await agents.stop(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  function due() { store.run('UPDATE notifications SET due_at=0'); }
  return { dataDir, path, store, admin, channel, agents, calls, clientOptions, make, due };
}

test('notifications target subscribed peers including paused queues and stop at four agent hops', async t => {
  const { store, admin, channel, make } = await fixture(t);
  const listening = make('listening');
  const other = store.createChannel({ name: 'other' }, admin.id);
  make('elsewhere', [other.id]);
  const paused = make('paused');
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', paused.user_id);
  store.run('DELETE FROM notifications');
  const message = store.post(admin.id, channel.id, 'Human starts the conversation');
  assert.deepEqual(store.all('SELECT agent_id FROM notifications WHERE message_id=?', message.id).map(n => n.agent_id), [listening.user_id, paused.user_id]);
  store.run('DELETE FROM notifications');
  store.post(listening.user_id, channel.id, 'No self notification', null, 1);
  assert.deepEqual(store.all('SELECT agent_id FROM notifications').map(n => n.agent_id), [paused.user_id]);
  store.run('DELETE FROM notifications');
  store.post(admin.id, channel.id, 'Hop four', null, 4);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
});

test('a successful silent turn never posts private final text and resumes its memory', async t => {
  const { store, agents, calls, make, due } = await fixture(t);
  const agent = make('quiet'); due();
  await agents.run(agent);
  assert.equal(store.all('SELECT * FROM messages').length, 0);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  assert.equal(store.get('SELECT status,thread_id FROM agents WHERE user_id=?', agent.user_id).thread_id, 'persistent-test-thread');
  assert.equal(agents.tokens.size, 0);
  store.run("INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,'check_in',0)", agent.user_id);
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', agent.user_id));
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1);
});

test('new and resumed agents have full host access with their own initially empty working folders', async t => {
  const { store, agents, calls, clientOptions, make, due } = await fixture(t, async ({ prompt }) => {
    assert.match(prompt, /Current host access policy: danger-full-access with approvalPolicy never/);
    assert.match(prompt, /replaces any earlier read-only, workspace-only, no-network or shell-unavailable policy/);
  });
  const first = make('first-worker');
  const second = make('second-worker');
  const firstPath = agents.ensureWorkspace(first.user_id);
  const secondPath = agents.ensureWorkspace(second.user_id);
  assert.notEqual(firstPath, secondPath);
  assert.deepEqual(await readdir(firstPath), []);
  assert.deepEqual(await readdir(secondPath), []);
  await writeFile(join(firstPath, 'notes.txt'), 'Persistent private working notes');
  due();
  await agents.run(first);
  store.run("INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,'check_in',0)", first.user_id);
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', first.user_id));
  await agents.run(second);
  const threads = calls.filter(call => ['thread/start', 'thread/resume'].includes(call.method));
  assert.deepEqual(threads.map(call => call.method), ['thread/start', 'thread/resume', 'thread/start']);
  assert.deepEqual(threads.map(call => call.params.cwd), [firstPath, firstPath, secondPath]);
  assert.deepEqual(clientOptions.map(options => options.cwd), [firstPath, firstPath, secondPath]);
  for (const { params } of threads) {
    assert.equal(params.sandbox, 'danger-full-access');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.config.sandbox_workspace_write, undefined);
    assert.match(params.baseInstructions, /host owner has authorized full host access/);
    assert.doesNotMatch(params.baseInstructions, /Disk writes are sandboxed|Do not access other agents/);
    assert.equal(params.config.features.shell_tool, true);
    assert.equal(params.config.features.unified_exec, true);
  }
  assert.equal(await readFile(join(firstPath, 'notes.txt'), 'utf8'), 'Persistent private working notes');
  assert.deepEqual(await readdir(secondPath), []);
});

test('private Codex defaults enable full host access and live web search without approval prompts', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-codex-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const home = prepareCodexHome(dataDir);
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(config, /^shell_tool = true$/m);
  assert.match(config, /^unified_exec = true$/m);
  assert.match(config, /^approval_policy = "never"$/m);
  assert.match(config, /^web_search = "live"$/m);
  assert.doesNotMatch(config, /sandbox_workspace_write|network_access = false|exclude_slash_tmp/);
});

test('MCP tools act as the authenticated agent, manage subscriptions and cap posts', async t => {
  const { store, agents, admin, channel, make } = await fixture(t);
  const agent = make('writer');
  const other = store.createChannel({ name: 'other' }, admin.id);
  const token = 'test-only-token';
  agents.tokens.set(token, { agentId: agent.user_id, posts: 0, depth: 4, cancelled: false });
  assert.throws(() => agents.tool('wrong-token', 'list_channels'), /Invalid agent credential/);
  assert.equal(agents.tool(token, 'get_me').id, agent.user_id);
  agents.tool(token, 'subscribe', { channel_id: other.id });
  assert.ok(agents.tool(token, 'get_me').subscriptions.some(c => c.id === other.id));
  agents.tool(token, 'unsubscribe', { channel_id: other.id });
  assert.ok(!agents.tool(token, 'get_me').subscriptions.some(c => c.id === other.id));
  store.run('DELETE FROM notifications');
  for (let index = 0; index < 3; index++) {
    const posted = agents.tool(token, 'post_message', { channel_id: channel.id, body: `Helpful ${index}` });
    assert.equal(posted.user_id, agent.user_id);
    assert.equal(posted.depth, 4);
  }
  assert.throws(() => agents.tool(token, 'post_message', { channel_id: channel.id, body: 'Fourth' }), /Three-message limit/);
  assert.equal(agents.tool(token, 'search_messages', { query: 'Helpful' }).length, 3);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', agent.user_id);
  assert.throws(() => agents.tool(token, 'list_channels'), /paused/);
});

test('failed turns retry with backoff, stop after five failures and admin saves retry them', async t => {
  const { store, agents, make, due } = await fixture(t, async () => { throw new Error('Temporary runtime failure'); });
  const agent = make('retry');
  for (let attempt = 1; attempt <= 5; attempt++) {
    due(); const before = Date.now();
    await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', agent.user_id));
    const n = store.get('SELECT * FROM notifications WHERE agent_id=?', agent.user_id);
    assert.equal(n.attempts, attempt);
    assert.equal(n.status, attempt === 5 ? 'failed' : 'pending');
    assert.ok(n.due_at >= before + Math.min(300000, 30000 * 2 ** (attempt - 1)));
  }
  assert.equal(store.get('SELECT status FROM agents WHERE user_id=?', agent.user_id).status, 'error');
  store.updateAgent(agent.user_id, { ...agent, enabled: false });
  const n = store.get('SELECT * FROM notifications WHERE agent_id=?', agent.user_id);
  assert.equal(n.status, 'pending');
  assert.equal(n.attempts, 0);
  assert.equal(store.get('SELECT enabled FROM agents WHERE user_id=?', agent.user_id).enabled, 0);
});

test('reopening persisted storage recovers interrupted queues and retains accounts and subscriptions', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-restart-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'db.sqlite');
  let store = new Store(path);
  const admin = store.setup({ username: 'admin', display_name: 'Admin', password: 'test password 123' });
  const channel = store.channels(admin.id)[0];
  const agent = store.createAgent({ username: 'agent', display_name: 'Agent', instructions: 'Listen.', subscriptions: [channel.id] });
  const message = store.post(admin.id, channel.id, 'Persist me');
  store.run("UPDATE notifications SET status='processing'");
  store.run("UPDATE agents SET status='thinking',enabled=0,thread_id='remember' WHERE user_id=?", agent.user_id);
  store.close();
  store = new Store(path);
  try {
    assert.equal(store.message(message.id).body, 'Persist me');
    assert.ok(store.all('SELECT * FROM notifications').every(n => n.status === 'pending'));
    const persisted = store.agents()[0];
    assert.equal(persisted.status, 'idle');
    assert.equal(persisted.enabled, 0);
    assert.equal(persisted.thread_id, 'remember');
    assert.deepEqual(persisted.subscriptions, [channel.id]);
  } finally { store.close(); }
});

test('pausing an active turn revokes tools and preserves queued retry attempts', async t => {
  const { store, agents, make, due } = await fixture(t);
  const agent = make('pausable'); due();
  store.run('UPDATE notifications SET attempts=4 WHERE agent_id=?', agent.user_id);
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let rejectTurn;
  agents.makeClient = () => ({
    async initialize() {},
    async request(method) { return method === 'account/read' ? { account: { type: 'chatgpt' } } : { thread: { id: 'cancel-test-thread' } }; },
    turn() { entered(); return new Promise((resolve, reject) => { rejectTurn = reject; }); },
    stop() { rejectTurn?.(new Error('Stopped')); },
  });
  const running = agents.run(agent);
  await started;
  assert.equal(agents.tokens.size, 1);
  await agents.cancel(agent.user_id);
  await running;
  assert.equal(agents.tokens.size, 0);
  const notification = store.get('SELECT * FROM notifications WHERE agent_id=?', agent.user_id);
  assert.equal(notification.status, 'pending');
  assert.equal(notification.attempts, 4);
  assert.equal(notification.due_at, 0);
  assert.equal(store.get('SELECT status FROM agents WHERE user_id=?', agent.user_id).status, 'idle');
});
