import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { createPublicGateway } from '../scripts/public-gateway.js';

const publicHost = 'commonroom-test.trycloudflare.com';
const publicOrigin = `https://${publicHost}`;
const credentials = { username: 'admin', display_name: 'Admin', password: 'public gateway test password' };

function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ host: '127.0.0.1', port, path, method,
      headers: { Host: publicHost, ...(!['GET', 'HEAD'].includes(method) ? { 'Sec-Fetch-Site': 'same-origin' } : {}), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, text, data }); });
    });
    request.on('error', reject); request.end(encoded);
  });
}

async function fixture(t, setup = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-public-test-'));
  const service = await createApp({ dataDir, agentsEnabled: false });
  const { port: upstreamPort } = await service.listen(0, '127.0.0.1');
  if (setup) service.store.setup(credentials);
  const gateway = createPublicGateway({ targetPort: upstreamPort, publicOrigin });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    await service.close(); await rm(dataDir, { recursive: true, force: true });
  });
  return { service, port: gateway.address().port };
}

test('public gateway rejects host/origin forgery and private or normalized routes', async t => {
  const { port, service } = await fixture(t, false);
  assert.equal((await raw(port, '/api/session', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await raw(port, '/api/session', { headers: { Host: `${publicHost}:443` } })).status, 403);
  assert.equal((await raw(port, '/api/session', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const origin of ['https://attacker.example', `http://${publicHost}`, `${publicOrigin}.attacker.example`, 'null']) {
    assert.equal((await raw(port, '/api/login', { method: 'POST', headers: { Origin: origin }, body: credentials })).status, 403);
  }
  assert.equal((await raw(port, '/api/login', { method: 'POST', headers: { Origin: publicOrigin, 'Sec-Fetch-Site': 'cross-site' }, body: credentials })).status, 403);
  assert.equal((await raw(port, '/api/login', { method: 'POST', body: credentials })).status, 403);
  assert.equal((await raw(port, '/api/login', { method: 'POST', headers: { Origin: publicOrigin, 'Sec-Fetch-Site': 'none' }, body: credentials })).status, 403);
  for (const path of ['/internal/agent/tool', '/internal', '/%69nternal/agent/tool', '/internal%2fagent/tool', '/x/../internal/agent/tool', '//internal/agent/tool', '/api/setup', '/api/%73etup', '/api/setup/', '/api/setup?ignored=1', '/api/x/../setup', '/%61pi/setup']) {
    const result = await raw(port, path, { method: 'POST', headers: { Origin: publicOrigin }, body: credentials });
    assert.ok(result.status >= 400, `${path} unexpectedly returned ${result.status}`);
  }
  assert.equal(service.store.hasUsers(), false);
});

test('public gateway supports login, secure session cookies and authenticated chat', async t => {
  const { port } = await fixture(t);
  const html = await raw(port, '/');
  assert.equal(html.status, 200); assert.match(html.text, /Commonroom/i);
  const login = await raw(port, '/api/login', { method: 'POST', headers: { Origin: publicOrigin }, body: credentials });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /; Secure(?:;|$)/i); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await raw(port, '/api/workspace')).status, 401);
  const workspace = await raw(port, '/api/workspace', { headers: { Cookie: cookie } });
  assert.equal(workspace.status, 200);
  const channelId = workspace.data.channels[0].id;
  const posted = await raw(port, `/api/channels/${channelId}/messages`, { method: 'POST', headers: { Origin: publicOrigin, Cookie: cookie }, body: { body: 'Hello through HTTPS gateway' } });
  assert.equal(posted.status, 201);
  assert.equal((await raw(port, `/api/channels/${channelId}/messages`, { headers: { Cookie: cookie } })).data[0].body, 'Hello through HTTPS gateway');
});

test('public gateway advertises polling and updated channel history is available to polling clients', async t => {
  const { port, service } = await fixture(t);
  const token = service.store.createSession(1);
  const cookie = `commonroom=${token}`;
  const workspace = await raw(port, '/api/workspace', { headers: { Cookie: cookie } });
  assert.equal(workspace.headers['x-commonroom-transport'], 'polling');
  const channelId = workspace.data.channels[0].id;
  assert.deepEqual((await raw(port, `/api/channels/${channelId}/messages`, { headers: { Cookie: cookie } })).data, []);
  service.store.post(1, channelId, 'Available on the next poll');
  const refreshed = await raw(port, `/api/channels/${channelId}/messages`, { headers: { Cookie: cookie } });
  assert.equal(refreshed.headers['x-commonroom-transport'], 'polling');
  assert.equal(refreshed.data[0].body, 'Available on the next poll');
  assert.equal((await raw(port, '/api/events', { headers: { Cookie: cookie } })).status, 404);
});

test('unconfigured public gateway fails closed until its exact HTTPS origin is installed', async t => {
  const gateway = createPublicGateway({ targetPort: 3000 });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  assert.equal((await raw(gateway.address().port, '/')).status, 503);
  for (const origin of ['http://example.com', 'https://example.com/', 'https://user:pass@example.com', 'https://example.com/path']) assert.throws(() => gateway.setPublicOrigin(origin));
});

test('public gateway supports ticket board, review, subscriptions, comments and attachments', async t => {
  const { port, service } = await fixture(t);
  const cookie = `commonroom=${service.store.createSession(1)}`;
  const headers = { Cookie: cookie, Origin: publicOrigin };
  assert.equal((await raw(port, '/api/board')).status, 401);
  assert.equal((await raw(port, '/api/notifications')).status, 401);
  const board = await raw(port, '/api/board', { headers });
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.data.tickets));
  const created = await raw(port, '/api/tickets', { method: 'POST', headers,
    body: { title: 'Public board ticket', description: 'Check every public route.', status: 'draft' } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.ok(id > 0);
  const updated = await raw(port, `/api/tickets/${id}`, { method: 'PUT', headers, body: { status: 'review' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, 'review');
  const comment = await raw(port, `/api/tickets/${id}/comments`, { method: 'POST', headers, body: { body: 'Ready for a human or agent review.' } });
  assert.equal(comment.status, 201);
  const detail = await raw(port, `/api/tickets/${id}`, { headers });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.comments[0].body, 'Ready for a human or agent review.');
  assert.equal(detail.data.subscribed, true);
  const unsubscribed = await raw(port, `/api/tickets/${id}/subscription`, { method: 'PUT', headers, body: { subscribed: false } });
  assert.equal(unsubscribed.status, 200);
  assert.equal((await raw(port, `/api/tickets/${id}`, { headers })).data.subscribed, false);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const workspace = await raw(port, '/api/workspace', { headers });
  const channelId = workspace.data.channels[0].id;
  const message = await raw(port, `/api/channels/${channelId}/messages`, { method: 'POST', headers, body: { body: 'An image shared in chat.' } });
  assert.equal(message.status, 201);
  assert.equal((await raw(port, '/api/attachments', { method: 'POST', headers,
    body: { scope: 'board', filename: 'not-for-the-board.png', content_base64: image } })).status, 400);
  for (const target of [{ scope: 'message', message_id: message.data.id }, { scope: 'ticket', ticket_id: id }, { scope: 'comment', comment_id: comment.data.id }]) {
    const upload = await raw(port, '/api/attachments', { method: 'POST', headers,
      body: { ...target, filename: 'evidence.png', content_base64: image } });
    assert.equal(upload.status, 201, upload.text);
    const path = `/api/attachments/${upload.data.id}/content`;
    assert.equal((await raw(port, path)).status, 401);
    const content = await raw(port, path, { headers });
    assert.equal(content.status, 200);
    assert.match(content.headers['content-type'], /^image\/png/);
  }
  const channelMessages = await raw(port, `/api/channels/${channelId}/messages`, { headers });
  assert.equal(channelMessages.data[0].attachments[0].filename, 'evidence.png');
  const editedMessage = await raw(port, `/api/messages/${message.data.id}`, { method: 'PUT', headers,
    body: { body: 'Revised image caption.', version: channelMessages.data[0].version } });
  assert.equal(editedMessage.status, 200, editedMessage.text);
  assert.equal(editedMessage.data.body, 'Revised image caption.');
  const currentComment = (await raw(port, `/api/tickets/${id}`, { headers })).data.comments[0];
  const editedComment = await raw(port, `/api/tickets/${id}/comments/${currentComment.id}`, { method: 'PUT', headers,
    body: { body: 'Revised review note.', version: currentComment.version } });
  assert.equal(editedComment.status, 200, editedComment.text);
  assert.equal(editedComment.data.body, 'Revised review note.');
  assert.equal((await raw(port, `/api/tickets/${id}`, { headers })).data.subscribed, true);
  assert.equal((await raw(port, '/api/notifications', { headers })).status, 200);
  assert.equal((await raw(port, '/api/notifications/read', { method: 'PUT', headers, body: {} })).status, 200);
});

test('public gateway serves only the explicit shared editor and renderer dependencies', async t => {
  const { port } = await fixture(t);
  for (const path of ['/composer.js', '/markdown.js', '/vendor/marked.js', '/vendor/dompurify.js']) {
    const response = await raw(port, path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-type'], /javascript/);
  }
  assert.equal((await raw(port, '/node_modules/marked/package.json')).status, 404);
  assert.equal((await raw(port, '/vendor/unknown.js')).status, 404);
});

test('public gateway supports unified inbox and thread subscriptions for signed-in users', async t => {
  const { port, service } = await fixture(t);
  const admin = service.store.publicUser(1);
  const member = service.store.createHuman({ username: 'reader', display_name: 'Reader', password: 'reader test password' });
  const channel = service.store.channels(admin.id)[0];
  const root = service.store.post(admin.id, channel.id, 'A thread to follow');
  const headers = { Cookie: `commonroom=${service.store.createSession(member.id)}`, Origin: publicOrigin };
  const path = `/api/messages/${root.id}`;
  for (const route of [path, `${path}/thread`, `${path}/subscription`]) {
    assert.equal((await raw(port, route)).status, 401);
    assert.equal((await raw(port, route, { headers })).status, 200);
  }
  assert.equal((await raw(port, `${path}/subscription`, { method: 'PUT', headers, body: { subscribed: 'yes' } })).status, 400);
  const follow = await raw(port, `${path}/subscription`, { method: 'PUT', headers, body: { subscribed: true } });
  assert.equal(follow.status, 200, follow.text);
  assert.equal(follow.data.subscribed, true);
  assert.equal((await raw(port, `${path}/thread`, { headers })).data.subscribed, true);
  service.store.post(admin.id, channel.id, 'Hi @READER, please look', root.id);
  const inbox = await raw(port, '/api/notifications', { headers });
  assert.equal(inbox.status, 200);
  const notice = inbox.data.find(n => n.reason === 'mention');
  assert.ok(notice, JSON.stringify(inbox.data));
  assert.equal(notice.parent_id, root.id);
  const read = await raw(port, '/api/notifications/read', { method: 'PUT', headers, body: { ids: [notice.id] } });
  assert.equal(read.status, 200, read.text);
  assert.ok((await raw(port, '/api/notifications', { headers })).data.find(n => n.id === notice.id).read_at);
  const unfollow = await raw(port, `${path}/subscription`, { method: 'PUT', headers, body: { subscribed: false } });
  assert.equal(unfollow.status, 200);
  assert.equal((await raw(port, `${path}/subscription`, { headers })).data.subscribed, false);
  assert.equal((await raw(port, `${path}/thread`, { headers })).data.subscribed, false);
  assert.equal((await raw(port, '/api/messages/999999', { headers })).status, 404);
  assert.equal((await raw(port, '/api/messages/999999/subscription', { method: 'PUT', headers, body: { subscribed: true } })).status, 404);
});
