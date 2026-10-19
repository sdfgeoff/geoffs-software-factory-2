import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { readdir } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { digest, verifyPassword } from '../server/store.js';

const credentials = { username: 'admin', display_name: 'Admin', password: 'correct horse battery staple' };
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-test-'));
  const service = await createApp({ dataDir, agentsEnabled: false });
  const address = await service.listen(0, '127.0.0.1');
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  return { ...service, request, base };
}

test('first setup, hashed credentials, session invalidation and admin permissions', async t => {
  const { request, store } = await fixture(t);
  assert.equal((await request('/api/session')).data.needs_setup, true);
  assert.equal((await request('/api/workspace')).status, 401);
  const setup = await request('/api/setup', { method: 'POST', body: credentials });
  assert.equal(setup.status, 201);
  assert.equal(setup.data.role, 'admin');
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/setup', { method: 'POST', body: credentials })).status, 409);
  const encoded = store.get('SELECT password_hash FROM users WHERE id=?', setup.data.id).password_hash;
  assert.notEqual(encoded, credentials.password);
  assert.equal(verifyPassword(credentials.password, encoded), true);
  const token = setup.cookie.split('=')[1];
  assert.equal(store.get('SELECT token_hash FROM sessions').token_hash, digest(token));
  const member = await request('/api/admin/users', { method: 'POST', cookie: setup.cookie, body: { username: 'member', display_name: 'Member', password: 'member password 123' } });
  assert.equal(member.status, 201);
  const login = await request('/api/login', { method: 'POST', body: { username: 'MEMBER', password: 'member password 123' } });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/admin/users', { method: 'POST', cookie: login.cookie, body: credentials })).status, 403);
  assert.equal((await request('/api/admin/agents', { method: 'POST', cookie: login.cookie, body: {} })).status, 403);
  assert.equal((await request('/api/admin/users', { method: 'POST', cookie: setup.cookie, body: { username: 'member', display_name: 'Duplicate', password: 'another password 123' } })).status, 400);
  assert.equal((await request(`/api/admin/users/${setup.data.id}`, { method: 'PUT', cookie: setup.cookie, body: { disabled: true } })).status, 400);
  await request(`/api/admin/users/${member.data.id}`, { method: 'PUT', cookie: setup.cookie, body: { disabled: true } });
  assert.equal((await request('/api/workspace', { cookie: login.cookie })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'member', password: 'member password 123' } })).status, 401);
  await request(`/api/admin/users/${member.data.id}`, { method: 'PUT', cookie: setup.cookie, body: { disabled: false, password: 'replacement password' } });
  const reset = await request('/api/login', { method: 'POST', body: { username: 'member', password: 'replacement password' } });
  assert.equal(reset.status, 200);
  const changed = await request('/api/password', { method: 'PUT', cookie: reset.cookie, body: { current_password: 'replacement password', password: 'new password again' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/workspace', { cookie: reset.cookie })).status, 401);
  assert.equal((await request('/api/workspace', { cookie: changed.cookie })).status, 200);
  await request('/api/logout', { method: 'POST', cookie: changed.cookie, body: {} });
  assert.equal((await request('/api/workspace', { cookie: changed.cookie })).status, 401);
});

test('messages, threads, channel discovery, pagination, search and literal content', async t => {
  const { request, store } = await fixture(t);
  const { cookie } = await request('/api/setup', { method: 'POST', body: credentials });
  const workspace = await request('/api/workspace', { cookie });
  const general = workspace.data.channels.find(c => c.name === 'general');
  const custom = await request('/api/channels', { method: 'POST', cookie, body: { name: 'work', description: 'Shared work' } });
  assert.equal(custom.status, 201);
  assert.equal((await request('/api/channels', { method: 'POST', cookie, body: { name: '../outside' } })).status, 400);
  const ids = [];
  for (let index = 0; index < 65; index++) ids.push(store.post(workspace.data.user.id, general.id, `Message ${index}`).id);
  const recent = await request(`/api/channels/${general.id}/messages`, { cookie });
  assert.equal(recent.data.length, 60);
  assert.deepEqual(recent.data.map(m => m.id), ids.slice(5));
  const older = await request(`/api/channels/${general.id}/messages?before=${recent.data[0].id}`, { cookie });
  assert.deepEqual(older.data.map(m => m.id), ids.slice(0, 5));
  assert.equal((await request(`/api/channels/${general.id}/messages?before=oops`, { cookie })).status, 400);
  const root = await request(`/api/channels/${general.id}/messages`, { method: 'POST', cookie, body: { body: '<script>alert("literal")</script> UNIQUE-search' } });
  assert.equal(root.status, 201);
  const reply = await request(`/api/channels/${general.id}/messages`, { method: 'POST', cookie, body: { body: 'A reply', parent_id: root.data.id } });
  assert.equal(reply.status, 201);
  assert.equal((await request(`/api/channels/${custom.data.id}/messages`, { method: 'POST', cookie, body: { body: 'wrong channel', parent_id: root.data.id } })).status, 400);
  assert.equal((await request(`/api/channels/${general.id}/messages`, { method: 'POST', cookie, body: { body: 'nested reply', parent_id: reply.data.id } })).status, 400);
  const thread = await request(`/api/messages/${root.data.id}/thread`, { cookie });
  assert.equal(thread.data.messages[0].body, 'A reply');
  assert.equal(thread.data.parent.body, root.data.body);
  const search = await request('/api/search?q=unique-SEARCH', { cookie });
  assert.equal(search.data.length, 1);
  assert.equal(search.data[0].id, root.data.id);
  await request(`/api/channels/${general.id}/subscription`, { method: 'PUT', cookie, body: { subscribed: false } });
  const unsubscribed = await request('/api/workspace', { cookie });
  assert.equal(unsubscribed.data.channels.find(c => c.id === general.id).subscribed, 0);
  assert.equal((await request(`/api/channels/${general.id}/messages`, { cookie })).status, 200);
});

test('host and browser-origin checks reject cross-site writes', async t => {
  const { request, base } = await fixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/session`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/setup', { method: 'POST', body: credentials, headers: { Origin: 'http://attacker.example' } })).status, 403);
  assert.equal((await request('/api/setup', { method: 'POST', body: credentials, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/setup', { method: 'POST', body: credentials, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/session')).data.needs_setup, true);
});

test('admin creates an empty dedicated agent folder and HTTP MCP carries full-size escaped text', async t => {
  const { request, agents } = await fixture(t);
  const { cookie } = await request('/api/setup', { method: 'POST', body: credentials });
  const created = await request('/api/admin/agents', { method: 'POST', cookie, body: { username: 'files-agent', display_name: 'Files Agent', instructions: 'Write notes when useful.', subscriptions: [] } });
  assert.equal(created.status, 201);
  const id = created.data.user_id;
  assert.deepEqual(await readdir(agents.workspacePath(id)), []);
  const token = 'local-test-token';
  agents.tokens.set(token, { agentId: id, posts: 0, depth: 1, cancelled: false });
  const content = '\"\\\n'.repeat(Math.floor(256 * 1024 / 3));
  const saved = await request('/internal/agent/tool', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { name: 'write_file', input: { path: 'notes.txt', content } } });
  assert.equal(saved.status, 200);
  const read = await request('/internal/agent/tool', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { name: 'read_file', input: { path: 'notes.txt' } } });
  assert.equal(read.status, 200);
  assert.equal(read.data.content, content);
  const invalid = await request('/internal/agent/tool', { method: 'POST', body: { name: 'read_file', input: { path: 'notes.txt' } } });
  assert.equal(invalid.status, 401);
});

test('password whitespace is preserved at setup, login and password change', async t => {
  const { request } = await fixture(t);
  const password = '  spaces are part of my password  ';
  const setup = await request('/api/setup', { method: 'POST', body: { ...credentials, password } });
  assert.equal(setup.status, 201);
  const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password } });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: password.trim() } })).status, 401);
  const changed = await request('/api/password', { method: 'PUT', cookie: login.cookie, body: { current_password: password, password: ' replacement password ' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: ' replacement password ' } })).status, 200);
});
