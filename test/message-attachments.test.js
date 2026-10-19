import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-chat-files-'));
  const app = await createApp({ dataDir, agentsEnabled: false });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const user = app.store.setup({ username: 'admin', display_name: 'Admin', password: 'chat files password' });
  const cookie = `commonroom=${app.store.createSession(user.id)}`;
  async function request(path, { method = 'GET', body, auth = cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(auth ? { Cookie: auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = Buffer.from(await response.arrayBuffer()); let data; try { data = JSON.parse(content); } catch {}
    return { status: response.status, headers: response.headers, data, content };
  }
  return { ...app, user, cookie, request, channel: app.store.channels(user.id)[0] };
}

test('chat and thread files are authored, authenticated and returned with messages', async t => {
  const { store, user, request, channel } = await fixture(t);
  const top = store.post(user.id, channel.id, 'A file for discussion');
  const reply = store.post(user.id, channel.id, 'A thread file', top.id);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  for (const message of [top, reply]) {
    const uploaded = await request('/api/attachments', { method: 'POST', body: { scope: 'message', message_id: message.id, filename: '../chat.png', content_base64: png.toString('base64'), created_by: 999 } });
    assert.equal(uploaded.status, 201); assert.equal(uploaded.data.scope, 'message'); assert.equal(uploaded.data.message_id, message.id); assert.equal(uploaded.data.created_by, user.id);
    assert.equal(uploaded.data.filename, 'chat.png'); assert.equal(uploaded.data.is_image, true);
    assert.equal((await request(uploaded.data.content_url, { auth: null })).status, 401);
    const bytes = await request(uploaded.data.content_url);
    assert.deepEqual(bytes.content, png); assert.equal(bytes.headers.get('content-type'), 'image/png');
    assert.equal(store.message(message.id).attachments[0].id, uploaded.data.id);
  }
  const messages = await request(`/api/channels/${channel.id}/messages`);
  assert.equal(messages.data[0].attachments.length, 1);
  const thread = await request(`/api/messages/${top.id}/thread`);
  assert.equal(thread.data.parent.attachments.length, 1); assert.equal(thread.data.messages[0].attachments.length, 1);
  const other = store.createHuman({ username: 'other', display_name: 'Other', password: 'other password123' });
  const otherCookie = `commonroom=${store.createSession(other.id)}`;
  assert.equal((await request('/api/attachments', { method: 'POST', auth: otherCookie, body: { scope: 'message', message_id: top.id, filename: 'spoof.txt', content_base64: 'eA==' } })).status, 403);
  for (const input of [
    { scope: 'message' }, { scope: 'message', message_id: top.id, ticket_id: 1 },
    { scope: 'board' }, { scope: 'message', message_id: 99999 },
  ]) assert.ok((await request('/api/attachments', { method: 'POST', body: { ...input, filename: 'x', content_base64: 'eA==' } })).status >= 400);
  assert.equal((await request('/api/board')).data.attachments, undefined);
  // Disabling an old author does not hide their message history or files.
  store.run('UPDATE users SET disabled=1 WHERE id=?', user.id);
  const history = await request(`/api/channels/${channel.id}/messages`, { auth: otherCookie });
  assert.equal(history.status, 200); assert.equal(history.data[0].attachments.length, 1);
});

test('late chat files refresh subscribers and preserve paused peer wakeups at bounded depth', async t => {
  const { store, user, channel } = await fixture(t);
  const make = name => store.createAgent({ username: name, display_name: name, instructions: 'Listen.', subscriptions: [channel.id] });
  const active = make('active'); const paused = make('paused'); const unsubscribed = make('unsubscribed');
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', paused.user_id);
  store.subscribe(unsubscribed.user_id, channel.id, false);
  const message = store.post(user.id, channel.id, 'File arrives later');
  store.run('DELETE FROM notifications'); const changes = []; store.onChange = (type, data) => changes.push({ type, data });
  const upload = { scope: 'message', message_id: message.id, filename: 'notes.txt', content_base64: Buffer.from('Context').toString('base64') };
  store.tickets.attach(user.id, upload);
  const queue = store.all('SELECT agent_id,message_id,kind,depth FROM notifications');
  assert.deepEqual(queue.map(n => [n.agent_id, n.message_id, n.kind, n.depth]), [[active.user_id, message.id, 'message_attachment', 0], [paused.user_id, message.id, 'message_attachment', 0]]);
  const refresh = changes.find(change => change.type === 'message');
  assert.equal(refresh.data.attachments.length, 1);
  const agentMessage = store.post(active.user_id, channel.id, 'Agent output', null, 4);
  store.run('DELETE FROM notifications');
  store.tickets.attach(active.user_id, { ...upload, message_id: agentMessage.id });
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  // Uploads to earlier messages cannot reset an active agent's hop budget.
  store.tickets.attach(user.id, upload, 4);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
});

test('message attachment migration adds a nullable foreign key without changing ticket files', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-chat-migration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'commonroom.sqlite'); let store = new Store(path);
  const user = store.setup({ username: 'admin', display_name: 'Admin', password: 'migration password' });
  const ticket = store.tickets.create(user.id, { title: 'Existing ticket' });
  const file = store.tickets.attach(user.id, { scope: 'ticket', ticket_id: ticket.id, filename: 'notes.txt', content_base64: 'eA==' });
  store.close();
  const old = new DatabaseSync(path); old.exec('DROP INDEX attachments_message; ALTER TABLE ticket_attachments DROP COLUMN message_id'); old.close();
  store = new Store(path);
  try {
    assert.ok(store.all('PRAGMA table_info(ticket_attachments)').some(column => column.name === 'message_id'));
    const persisted = store.tickets.detail(user.id, ticket.id).attachments[0];
    assert.equal(persisted.id, file.id); assert.equal(persisted.message_id, null);
    assert.equal(store.tickets.readAttachment(user.id, file.id).content_base64, 'eA==');
    assert.deepEqual(store.tickets.attachments(user.id), []);
  } finally { store.close(); }
});
