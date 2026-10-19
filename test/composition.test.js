import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { DatabaseSync } from 'node:sqlite';

const upload = (filename = 'notes.txt', content = 'Some notes') => ({ filename, content_base64: Buffer.from(content).toString('base64') });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-compose-'));
  const app = await createApp({ dataDir, agentsEnabled: false }); const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const user = app.store.setup({ username: 'admin', display_name: 'Admin', password: 'compose test password' });
  const cookie = `commonroom=${app.store.createSession(user.id)}`;
  async function request(path, { method = 'GET', body, auth = cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(auth ? { Cookie: auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = await response.text(); let data; try { data = JSON.parse(content); } catch {}
    return { status: response.status, data, content };
  }
  const channel = app.store.channels(user.id)[0];
  const ticket = app.store.tickets.create(user.id, { title: 'Compose' });
  return { ...app, dataDir, user, cookie, request, channel, ticket };
}

test('message, reply and ticket comment compose text and staged files in one save, including file-only posts', async t => {
  const { request, store, user, channel, ticket } = await fixture(t);
  const agent = store.createAgent({ username: 'watcher', display_name: 'Watcher', instructions: 'Listen.', subscriptions: [channel.id] });
  store.tickets.subscribe(agent.user_id, ticket.id, true); store.run('DELETE FROM notifications');
  const message = await request(`/api/channels/${channel.id}/messages`, { method: 'POST', body: { attachments: [upload()] } });
  assert.equal(message.status, 201); assert.equal(message.data.body, '');
  assert.equal(message.data.attachments.length, 1); assert.equal(message.data.version, 1); assert.equal(message.data.edited_at, null);
  const reply = await request(`/api/channels/${channel.id}/messages`, { method: 'POST', body: { body: '**Thread note**', parent_id: message.data.id, attachments: [upload('thread.txt')] } });
  assert.equal(reply.status, 201); assert.equal(reply.data.attachments.length, 1);
  const comment = await request(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { body: '', attachments: [upload('comment.txt')] } });
  assert.equal(comment.status, 201); assert.equal(comment.data.body, ''); assert.equal(comment.data.version, 1); assert.equal(comment.data.edited_at, null);
  assert.equal(comment.data.ticket_version, ticket.version + 1);
  assert.equal(store.get('SELECT COUNT(*) n FROM notifications').n, 3);
  assert.equal(store.tickets.detail(user.id, ticket.id).activity.length, 2);
  for (const path of [`/api/channels/${channel.id}/messages`, `/api/tickets/${ticket.id}/comments`]) {
    assert.equal((await request(path, { method: 'POST', body: { body: '' } })).status, 400);
    assert.equal((await request(path, { method: 'POST', body: { body: 'Should not save', attachments: [upload(), { filename: 'broken.txt', content_base64: 'invalid' }] } })).status, 400);
  }
  assert.equal(store.get('SELECT COUNT(*) n FROM messages').n, 2);
  assert.equal(store.get('SELECT COUNT(*) n FROM ticket_comments').n, 1);
});

test('only authors can atomically edit text, add/remove context files and resolve version conflicts', async t => {
  const { request, store, user, channel, ticket, dataDir } = await fixture(t);
  const message = store.post(user.id, channel.id, 'Original message', null, 0, [upload('old.txt')]);
  const comment = store.tickets.comment(user.id, ticket.id, { body: 'Original comment', attachments: [upload('old.txt')] });
  const other = store.createHuman({ username: 'other', display_name: 'Other', password: 'other password123' });
  const otherCookie = `commonroom=${store.createSession(other.id)}`;
  const contexts = [
    { path: `/api/messages/${message.id}`, original: message, current: () => store.message(message.id) },
    { path: `/api/tickets/${ticket.id}/comments/${comment.id}`, original: comment, current: () => store.tickets.detail(user.id, ticket.id).comments[0] },
  ];
  for (const context of contexts) {
    const oldAttachment = context.original.attachments[0];
    assert.equal((await request(context.path, { method: 'PUT', auth: null, body: { body: 'No', version: 1 } })).status, 401);
    assert.equal((await request(context.path, { method: 'PUT', auth: otherCookie, body: { body: 'No', version: 1 } })).status, 403);
    assert.equal((await request(context.path, { method: 'PUT', body: { body: 'Missing version' } })).status, 400);
    const wrongContextFile = context === contexts[0] ? comment.attachments[0].id : message.attachments[0].id;
    assert.equal((await request(context.path, { method: 'PUT', body: { body: 'Wrong file', version: 1, remove_attachment_ids: [wrongContextFile] } })).status, 403);
    const edited = await request(context.path, { method: 'PUT', body: { body: 'Edited **Markdown**', version: 1, remove_attachment_ids: [oldAttachment.id], attachments: [upload('replacement.txt')] } });
    assert.equal(edited.status, 200); assert.equal(edited.data.version, 2); assert.ok(edited.data.edited_at);
    assert.equal(edited.data.attachments[0].filename, 'replacement.txt'); assert.notEqual(edited.data.attachments[0].id, oldAttachment.id);
    assert.equal((await request(oldAttachment.content_url)).status, 404);
    assert.equal((await request(context.path, { method: 'PUT', body: { body: 'Stale', version: 1 } })).status, 409);
    assert.equal(context.current().body, 'Edited **Markdown**');
    assert.equal((await request(context.path, { method: 'PUT', body: { version: 2, attachments: [upload('more.txt')] } })).data.body, 'Edited **Markdown**');
    const current = context.current();
    assert.equal((await request(context.path, { method: 'PUT', body: { body: '', version: current.version, remove_attachment_ids: current.attachments.map(file => file.id) } })).status, 400);
    assert.equal(context.current().version, current.version);
  }
  assert.equal((await readdir(join(dataDir, 'uploads'))).length, 4);
  assert.equal(store.tickets.detail(user.id, ticket.id).activity.filter(event => event.kind === 'comment_edited').length, 2);
});

test('late direct attachment imports invalidate existing message and comment editors', async t => {
  const { store, user, channel, ticket } = await fixture(t);
  const message = store.post(user.id, channel.id, 'Message');
  const comment = store.tickets.comment(user.id, ticket.id, { body: 'Comment' });
  store.tickets.attach(user.id, { scope: 'message', message_id: message.id, ...upload() });
  store.tickets.attach(user.id, { scope: 'comment', comment_id: comment.id, ...upload() });
  assert.equal(store.message(message.id).version, 2); assert.ok(store.message(message.id).edited_at);
  const updated = store.tickets.detail(user.id, ticket.id).comments[0];
  assert.equal(updated.version, 2); assert.ok(updated.edited_at);
  assert.throws(() => store.editMessage(user.id, message.id, { body: 'Stale', version: 1 }), error => error.status === 409);
  assert.throws(() => store.tickets.editComment(user.id, ticket.id, comment.id, { body: 'Stale', version: 1 }), error => error.status === 409);
});

test('failed database saves roll back text, removals, activity and newly written files', async t => {
  const { store, user, channel, ticket, dataDir } = await fixture(t);
  const contexts = [
    { create: () => store.post(user.id, channel.id, 'Original', null, 0, [upload('retained.txt')]), edit: (id, input) => store.editMessage(user.id, id, input), get: id => store.message(id) },
    { create: () => store.tickets.comment(user.id, ticket.id, { body: 'Original', attachments: [upload('retained.txt')] }), edit: (id, input) => store.tickets.editComment(user.id, ticket.id, id, input), get: id => store.tickets.detail(user.id, ticket.id).comments.find(row => row.id === id) },
  ];
  for (const context of contexts) {
    const original = context.create(); const filesBefore = await readdir(join(dataDir, 'uploads'));
    const activityBefore = store.get('SELECT COUNT(*) n FROM ticket_activity').n;
    const noticesBefore = store.get('SELECT COUNT(*) n FROM notifications').n;
    const run = store.run.bind(store); let additions = 0;
    store.run = (sql, ...args) => {
      if (sql.startsWith('INSERT INTO ticket_attachments') && ++additions === 2) throw new Error('Injected storage failure');
      return run(sql, ...args);
    };
    try { assert.throws(() => context.edit(original.id, { body: 'Must roll back', version: original.version, remove_attachment_ids: [original.attachments[0].id], attachments: [upload('one'), upload('two')] }), /Injected storage failure/); }
    finally { store.run = run; }
    assert.equal(context.get(original.id).body, 'Original'); assert.equal(context.get(original.id).version, 1);
    assert.equal(context.get(original.id).attachments[0].id, original.attachments[0].id);
    assert.deepEqual((await readdir(join(dataDir, 'uploads'))).sort(), filesBefore.sort());
    assert.equal(store.get('SELECT COUNT(*) n FROM ticket_activity').n, activityBefore);
    assert.equal(store.get('SELECT COUNT(*) n FROM notifications').n, noticesBefore);
  }
});

test('save caps apply to new uploads, preserve legacy attachments, and large composer JSON is scoped', async t => {
  const { request, store, user, channel, ticket } = await fixture(t);
  const half = Buffer.alloc(5 * 1024 * 1024, 120);
  const files = [upload('first.bin', half), upload('second.bin', half)];
  const posted = await request(`/api/channels/${channel.id}/messages`, { method: 'POST', body: { attachments: files } });
  assert.equal(posted.status, 201); assert.equal(posted.data.attachments.length, 2);
  const excessive = [files[0], upload('too-big.bin', Buffer.alloc(half.length + 1))];
  assert.equal((await request(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { body: 'No partial save', attachments: excessive } })).status, 413);
  assert.equal((await request(`/api/messages/${posted.data.id}`, { method: 'PUT', body: { version: 1, attachments: Array.from({ length: 11 }, () => upload()) } })).status, 400);
  // Existing files can exceed a new-save cap without forcing a text editor to remove them.
  store.tickets.attach(user.id, { scope: 'message', message_id: posted.data.id, ...upload('legacy-extra.txt') });
  const edited = store.editMessage(user.id, posted.data.id, { version: 2, body: 'Text edit with existing files' });
  assert.equal(edited.attachments.length, 3);
  const notComposer = await request('/api/channels', { method: 'POST', body: { name: 'small-only', description: 'x'.repeat(100000) } });
  assert.equal(notComposer.status, 413);
});

test('editing migration gives old messages and comments stable initial versions without edited markers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-edit-migration-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'commonroom.sqlite'); let store = new Store(path);
  const user = store.setup({ username: 'admin', display_name: 'Admin', password: 'migration password' });
  const message = store.post(user.id, store.channels(user.id)[0].id, 'Old message');
  const ticket = store.tickets.create(user.id, { title: 'Old ticket' }); const comment = store.tickets.comment(user.id, ticket.id, 'Old comment'); store.close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE messages DROP COLUMN version; ALTER TABLE messages DROP COLUMN edited_at; ALTER TABLE ticket_comments DROP COLUMN version; ALTER TABLE ticket_comments DROP COLUMN edited_at;'); old.close();
  store = new Store(path);
  try {
    assert.equal(store.message(message.id).version, 1); assert.equal(store.message(message.id).edited_at, null);
    const migrated = store.tickets.detail(user.id, ticket.id).comments[0]; assert.equal(migrated.version, 1); assert.equal(migrated.edited_at, null);
    assert.equal(store.tickets.editComment(user.id, ticket.id, comment.id, { version: 1, body: 'Now edited' }).version, 2);
  } finally { store.close(); }
});
