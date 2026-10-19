import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, AppError, text, password, passwordHash, verifyPassword, digest } from './store.js';
import { Agents } from './agents.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const cookie = req => /(?:^|;\s*)commonroom=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
export async function createApp({ dataDir = resolve(process.env.DATA_DIR || 'data'), agentsEnabled = process.env.AGENTS_ENABLED !== 'false', clientFactory } = {}) {
  const store = new Store(resolve(dataDir, 'commonroom.sqlite'));
  const agents = new Agents(store, { dataDir, enabled: agentsEnabled, clientFactory });
  const workers=store.workers; workers.attachRuntime(agents);
  const app = express(); const server = createServer(app); const streams = new Set();
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', hostname(), `${hostname()}.local`, ...(process.env.ALLOWED_HOSTS || '').split(',').filter(Boolean)]);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) hosts.add(address.family === 'IPv6' ? `[${address.address}]` : address.address);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return res.status(400).json({ error: 'Invalid host.' }); }
    if (!hosts.has(host)) return res.status(403).json({ error: 'Host not allowed. Add your local hostname to ALLOWED_HOSTS.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if(req.path.startsWith('/api/workers/')&&(req.headers.origin!==undefined||req.headers['sec-fetch-site']!==undefined))return res.status(403).json({error:'Worker endpoints require machine credentials without browser origin headers.'});
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request rejected.' });
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
        catch { return res.status(403).json({ error: 'Origin rejected.' }); }
      }
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON content type required.' });
    }
    next();
  });
  // File tools accept 256 KiB of text, which can expand when JSON-escaped.
  app.use('/internal/agent/tool', express.json({ limit: '2mb' }));
  app.use('/api/attachments', express.json({ limit: '15mb' }));
  app.use(/^\/api\/workers\/jobs\/[1-9]\d*\/tool$/,express.json({limit:'15mb'}));
  const compositionJson = express.json({ limit: '15mb' });
  app.use((req, res, next) => {
    const composeRoute = req.method === 'POST' && /^\/api\/(?:channels\/[1-9]\d*\/messages|tickets\/[1-9]\d*\/comments)$/.test(req.path);
    const editRoute = req.method === 'PUT' && /^\/api\/(?:messages\/[1-9]\d*|tickets\/[1-9]\d*\/comments\/[1-9]\d*)$/.test(req.path);
    if (composeRoute || editRoute) return compositionJson(req, res, next);
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); req.user = store.session(cookie(req)); next(); });
  const authenticated = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in.' });
  const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });
  const workerAuth=(req,res,next)=>{try{req.worker=workers.authenticate(req.headers.authorization?.replace(/^Bearer /,''));next();}catch(error){next(error);}};
  const setCookie = (res, token, maxAge = 604800) => res.setHeader('Set-Cookie', `commonroom=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  const attempts = new Map();
  const loginLimit = (req, res, next) => {
    const key = req.socket.remoteAddress;
    const current = attempts.get(key);
    if (current && current.until > Date.now() && current.count >= 20) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    if (!current || current.until <= Date.now()) attempts.set(key, { count: 1, until: Date.now() + 900000 });
    else current.count++;
    for (const [k, v] of attempts) if (v.until <= Date.now()) attempts.delete(k);
    next();
  };
  store.onChange = (type, data = null) => {
    for (const stream of streams) {
      if (!store.session(stream.token)) { stream.res.end(); streams.delete(stream); continue; }
      stream.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  app.get('/api/session', (req, res) => res.json({ user: req.user || null, needs_setup: !store.hasUsers(), can_setup: loopback(req.socket.remoteAddress) }));
  app.post('/api/setup', loginLimit, (req, res) => {
    if (!loopback(req.socket.remoteAddress)) throw new AppError('Create the first admin from a browser on the host computer using localhost.', 403);
    const user = store.setup(req.body); setCookie(res, store.createSession(user.id)); res.status(201).json(user);
  });
  app.post('/api/login', loginLimit, (req, res) => {
    const name = text(req.body.username, 'Username', 32).toLowerCase();
    const pass = req.body.password;
    if (typeof pass !== 'string' || !pass.length || pass.length > 256) throw new AppError('Password must be 1–256 characters.');
    const user = store.get('SELECT * FROM users WHERE username=? AND kind=\'human\'', name);
    const valid = verifyPassword(pass, user?.password_hash);
    if (!valid || !user || user.disabled) throw new AppError('Incorrect username or password.', 401);
    attempts.delete(req.socket.remoteAddress); setCookie(res, store.createSession(user.id)); res.json(store.publicUser(user.id));
  });
  app.post('/api/logout', (req, res) => {
    const token = cookie(req); if (token) store.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
    setCookie(res, '', 0); store.onChange('session'); res.json({ ok: true });
  });
  app.get('/api/workspace', authenticated, (req, res) => {
    const agentList = store.agents().map(a => ({ user_id: a.user_id, display_name: a.display_name, username: a.username,
      enabled: a.enabled, status: a.status, subscriptions: a.subscriptions, pending: a.pending,worker_id:a.worker_id,
      ...(a.worker_id?{worker_name:workers.public(workers.row(a.worker_id)).name,worker_status:workers.public(workers.row(a.worker_id)).status,worker_online:workers.public(workers.row(a.worker_id)).online}:{worker_name:'This computer',worker_status:'local',worker_online:true}),
      ...(req.user.role === 'admin' ? { instructions: a.instructions, model: a.model, last_error: a.last_error, last_run_at: a.last_run_at,
        workspace_path: a.worker_id?store.get('SELECT workspace_path FROM worker_agent_state WHERE worker_id=? AND agent_id=?',a.worker_id,a.user_id)?.workspace_path||null:agents.workspacePath(a.user_id) } : {}) }));
    res.json({ user: req.user, users: store.users(), channels: store.channels(req.user.id), agents: agentList,
      runtime_enabled: agentsEnabled });
  });
  app.get('/api/events', authenticated, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.flushHeaders();
    const stream = { res, token: cookie(req) }; streams.add(stream);
    res.write('event: connected\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      if (!store.session(stream.token)) { res.end(); return; }
      res.write(': heartbeat\n\n');
    }, 15000);
    req.on('close', () => { clearInterval(heartbeat); streams.delete(stream); });
  });
  app.post('/api/channels', authenticated, (req, res) => res.status(201).json(store.createChannel(req.body, req.user.id)));
  app.put('/api/channels/:id/subscription', authenticated, (req, res) => {
    store.subscribe(req.user.id, Number(req.params.id), Boolean(req.body.subscribed)); res.json({ ok: true });
  });
  app.put('/api/channels/:id/read', authenticated, (req, res) => {
    const channel = store.channel(req.params.id);
    const latest = store.get('SELECT COALESCE(MAX(id),0) id FROM messages WHERE channel_id=?', channel.id).id;
    // Only advance to the message the browser actually saw; avoid swallowing concurrent arrivals.
    const seen = Math.min(latest, Math.max(0, Number(req.body.message_id) || 0));
    store.run('UPDATE subscriptions SET last_read_id=MAX(last_read_id,?) WHERE user_id=? AND channel_id=?', seen, req.user.id, channel.id);
    res.json({ ok: true });
  });
  app.get('/api/channels/:id/messages', authenticated, (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    if (before !== undefined && !Number.isSafeInteger(before)) throw new AppError('Invalid pagination cursor.');
    res.json(store.messages(Number(req.params.id), { before }));
  });
  app.post('/api/channels/:id/messages', authenticated, (req, res) => {
    res.status(201).json(store.post(req.user.id, Number(req.params.id), req.body.body, req.body.parent_id || null, 0, req.body.attachments));
  });
  app.get('/api/messages/:id', authenticated, (req, res) => {
    const message = store.message(req.params.id);
    if (!message) throw new AppError('Message not found.', 404);
    res.json(message);
  });
  app.get('/api/messages/:id/subscription', authenticated, (req, res) => res.json(store.inbox.threadState(req.user.id, req.params.id)));
  app.put('/api/messages/:id/subscription', authenticated, (req, res) => {
    if (typeof req.body.subscribed !== 'boolean') throw new AppError('Subscribed must be a boolean.');
    res.json(store.inbox.threadSubscribe(req.user.id, req.params.id, req.body.subscribed));
  });
  app.put('/api/messages/:id', authenticated, (req, res) => res.json(store.editMessage(req.user.id, req.params.id, req.body)));
  app.get('/api/messages/:id/thread', authenticated, (req, res) => {
    const message = store.message(req.params.id);
    if (!message || message.parent_id) throw new AppError('Thread not found.', 404);
    const before = req.query.before ? Number(req.query.before) : undefined;
    if (before !== undefined && !Number.isSafeInteger(before)) throw new AppError('Invalid pagination cursor.');
    res.json({ parent: message, messages: store.messages(message.channel_id, { parentId: message.id, before, limit: 100 }),
      subscribed: store.inbox.threadState(req.user.id, message.id).subscribed });
  });
  app.get('/api/search', authenticated, (req, res) => {
    const query = text(req.query.q, 'Search query', 120);
    if (req.query.scope === 'workspace') {
      const type = req.query.type || 'all';
      if (!['all', 'message', 'ticket', 'comment'].includes(type)) throw new AppError('Invalid search type.');
      const results = store.all(`SELECT * FROM (
        SELECT 'message' type,m.id,m.body,m.created_at,m.channel_id,m.parent_id,
          c.name context,u.display_name,NULL ticket_id,NULL title
        FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.user_id
        WHERE instr(lower(m.body),lower(?))>0
        UNION ALL
        SELECT 'ticket',t.id,t.description,t.updated_at,NULL,NULL,'CR-'||t.id,u.display_name,t.id,t.title
        FROM tickets t JOIN users u ON u.id=t.created_by
        WHERE instr(lower(t.title||char(10)||t.description||char(10)||'CR-'||t.id),lower(?))>0
        UNION ALL
        SELECT 'comment',tc.id,tc.body,tc.created_at,NULL,NULL,'CR-'||t.id,u.display_name,t.id,t.title
        FROM ticket_comments tc JOIN tickets t ON t.id=tc.ticket_id JOIN users u ON u.id=tc.user_id
        WHERE instr(lower(tc.body),lower(?))>0
      ) WHERE (?='all' OR type=?) ORDER BY created_at DESC,id DESC LIMIT 60`, query, query, query, type, type);
      return res.json(results.map(row => {
        const index = row.body.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, index-80);
        return {...row, body: (start ? '…' : '') + row.body.slice(start,start+300) + (row.body.length > start+300 ? '…' : '')};
      }));
    }
    res.json(store.all(`SELECT m.*,u.display_name,u.username,u.kind,c.name channel_name FROM messages m
      JOIN users u ON u.id=m.user_id JOIN channels c ON c.id=m.channel_id WHERE instr(lower(m.body),lower(?))>0 ORDER BY m.id DESC LIMIT 60`, query));
  });
  app.put('/api/password', authenticated, (req, res) => {
    const user = store.get('SELECT * FROM users WHERE id=?', req.user.id);
    if (typeof req.body.current_password !== 'string' || !verifyPassword(req.body.current_password, user.password_hash)) throw new AppError('Current password is incorrect.');
    store.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(password(req.body.password)), user.id);
    store.run('DELETE FROM sessions WHERE user_id=?', user.id);
    setCookie(res, store.createSession(user.id)); store.onChange('session'); res.json({ ok: true });
  });
  app.get('/api/admin/codex', authenticated, admin, async (req, res) => res.json(await agents.info(req.query.refresh === '1')));
  app.post('/api/admin/users', authenticated, admin, (req, res) => {
    const user = store.createHuman(req.body, req.body.role === 'admin'); store.onChange('workspace'); res.status(201).json(user);
  });
  app.put('/api/admin/users/:id', authenticated, admin, (req, res) => {
    const id = Number(req.params.id); const user = store.publicUser(id);
    if (!user || user.kind !== 'human') throw new AppError('Human user not found.', 404);
    if (id === req.user.id && req.body.disabled) throw new AppError('You cannot disable your own account.');
    if (req.body.password) {
      store.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(password(req.body.password)), id);
      store.run('DELETE FROM sessions WHERE user_id=?', id);
    }
    if (typeof req.body.disabled === 'boolean') {
      store.run('UPDATE users SET disabled=? WHERE id=?', req.body.disabled ? 1 : 0, id);
      if (req.body.disabled) store.run('DELETE FROM sessions WHERE user_id=?', id);
    }
    store.onChange('workspace'); res.json({ ok: true });
  });
  app.post('/api/admin/agents', authenticated, admin, (req, res) => {
    const agent = store.createAgent(req.body);
    const workspace_path = agent.worker_id?null:agents.ensureWorkspace(agent.user_id);
    res.status(201).json({ ...agent, workspace_path });
  });
  app.put('/api/admin/agents/:id', authenticated, admin, async (req, res) => {
    const id = Number(req.params.id);
    // Validate fully before interrupting the existing agent.
    text(req.body.display_name, 'Display name', 60); text(req.body.instructions, 'Instructions', 12000);
    text(req.body.model || '', 'Model', 100, 0); store.validateChannels(req.body.subscriptions);
    workers.validateAssignment(req.body.worker_id,store.get('SELECT worker_id FROM agents WHERE user_id=?',id)?.worker_id||null);
    await agents.cancel(id); store.updateAgent(id, req.body); res.json({ ok: true });
  });
  app.post('/api/admin/agents/:id/wake', authenticated, admin, (req, res) => {
    const id = Number(req.params.id);
    const agent = store.get('SELECT * FROM agents WHERE user_id=?', id);
    if (!agent) throw new AppError('Agent not found.', 404);
    if (!agent.enabled) throw new AppError('Resume the agent first.');
    store.run('INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,\'check_in\',?)', id, Date.now());
    store.onChange('workspace'); res.json({ ok: true });
  });
  app.post('/internal/agent/tool', (req, res) => {
    if (!loopback(req.socket.remoteAddress)) throw new AppError('Loopback only.', 403);
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    res.json(agents.tool(token, req.body.name, req.body.input));
  });
  app.get('/api/admin/workers',authenticated,admin,(req,res)=>res.json({workers:workers.list()}));
  app.post('/api/admin/workers',authenticated,admin,(req,res)=>res.status(201).json(workers.create(req.body)));
  app.put('/api/admin/workers/:id',authenticated,admin,(req,res)=>res.json(workers.update(req.params.id,req.body)));
  app.post('/api/admin/workers/:id/auth',authenticated,admin,(req,res)=>res.json(workers.auth(req.params.id,req.body)));
  app.post('/api/workers/enroll',loginLimit,(req,res)=>res.json(workers.enroll(req.body)));
  app.post('/api/workers/heartbeat',workerAuth,(req,res)=>res.json(workers.heartbeat(req.worker,req.body)));
  app.post('/api/workers/claim',workerAuth,(req,res)=>res.json(workers.claim(req.worker)));
  app.post('/api/workers/jobs/:id/tool',workerAuth,(req,res)=>res.json(workers.tool(req.worker,req.params.id,req.body)));
  app.post('/api/workers/jobs/:id/complete',workerAuth,(req,res)=>res.json(workers.complete(req.worker,req.params.id,req.body)));
  app.get('/api/board', authenticated, (req, res) => res.json(store.tickets.board(req.user.id)));
  app.post('/api/tickets', authenticated, (req, res) => res.status(201).json(store.tickets.create(req.user.id, req.body)));
  app.get('/api/tickets/:id', authenticated, (req, res) => res.json(store.tickets.detail(req.user.id, req.params.id)));
  app.put('/api/tickets/:id', authenticated, (req, res) => res.json(store.tickets.update(req.user.id, req.params.id, req.body)));
  app.post('/api/tickets/:id/comments', authenticated, (req, res) => res.status(201).json(store.tickets.comment(req.user.id, req.params.id, req.body)));
  app.put('/api/tickets/:id/comments/:commentId', authenticated, (req, res) => res.json(store.tickets.editComment(req.user.id, req.params.id, req.params.commentId, req.body)));
  app.put('/api/tickets/:id/subscription', authenticated, (req, res) => res.json(store.tickets.subscribe(req.user.id, req.params.id, req.body.subscribed)));
  app.post('/api/attachments', authenticated, (req, res) => res.status(201).json(store.tickets.attach(req.user.id, req.body)));
  app.get('/api/attachments/:id/content', authenticated, (req, res) => {
    const attachment = store.tickets.attachment(req.user.id, req.params.id);
    const safeName = attachment.filename.replace(/[^a-zA-Z0-9 ._()-]/g, '_');
    res.set({ 'Content-Type': attachment.mime_type, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
      'Content-Disposition': `${attachment.is_image ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}` });
    res.sendFile(attachment.disk_path);
  });
  app.get('/api/notifications', authenticated, (req, res) => res.json(store.inbox.list(req.user.id)));
  app.put('/api/notifications/read', authenticated, (req, res) => res.json(store.inbox.markRead(req.user.id, req.body.ids)));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.get('/vendor/marked.js', (req, res) => res.type('application/javascript').sendFile(fileURLToPath(new URL('../node_modules/marked/lib/marked.esm.js', import.meta.url))));
  app.get('/vendor/dompurify.js', (req, res) => res.type('application/javascript').sendFile(fileURLToPath(new URL('../node_modules/dompurify/dist/purify.es.mjs', import.meta.url))));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : error.message });
  });
  return { app, store, agents, workers, server,
    async listen(port = 3000, host = '0.0.0.0') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      agents.start(server.address().port); workers.start(); return server.address();
    },
    async close() {
      workers.stop(); await agents.stop(); for (const s of streams) s.res.end();
      await new Promise(resolve => server.close(resolve)); store.close();
    }
  };
}
