import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CodexClient, prepareCodexHome } from '../server/codex.js';
import { agentInstructions } from './prompts.js';

const save = (path, value) => { writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(`${path}.tmp`, path); };
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot read worker state ${path}: ${error.message}`); } };
const mcpPath = fileURLToPath(new URL('../server/mcp.js', import.meta.url));

export class WorkerRuntime {
  constructor({ stateDir, server, name, capacity, binary = process.env.CODEX_BIN || 'codex', fetchImpl = fetch, clientFactory, intervalMs = 3000 } = {}) {
    this.stateDir = resolve(stateDir || '.commonroom-worker'); mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.configPath = join(this.stateDir, 'worker.json'); this.config = read(this.configPath) || {};
    if (server && this.config.server && server.replace(/\/$/, '') !== this.config.server) throw new Error('This state directory belongs to another server. Use a separate directory.');
    this.server = (server || this.config.server || '').replace(/\/$/, '');
    if (this.server) { const url = new URL(this.server); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTP(S) server origin without credentials or a path.'); }
    this.name = name || this.config.name || 'Commonroom worker'; this.capacity = Number(capacity ?? this.config.capacity ?? 1); if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 8) throw new Error('Capacity must be 1–8.');
    this.binary = binary; this.fetch = fetchImpl; this.intervalMs = intervalMs; this.active = new Map(); this.acks = new Set(); this.completions = new Map();
    const pending = read(join(this.stateDir, 'completions.json'));
    if (pending?.worker_id === this.config.worker_id && pending?.server === this.server) this.completions = new Map(pending.entries); this.stopped = false;
    this.home = prepareCodexHome(this.stateDir, { shareAuth: false });
    this.makeClient = clientFactory || (cwd => new CodexClient({ codexHome: this.home, cwd, binary: this.binary }));
    this.watchdog = setInterval(() => { for (const state of this.active.values()) if (Date.now() > state.leaseDeadline) { state.cancelled = true; state.client?.stop(); } }, 1000); this.watchdog.unref();
    this.auth = { connected: false, plan: null, error: null, flow: { status: 'idle' } }; this.models = []; this.refreshAt = 0;
  }
  async api(path, input, { anonymous = false } = {}) {
    if (!this.server) throw new Error('A server URL is required.');
    const response = await this.fetch(`${this.server}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(anonymous ? {} : { Authorization: `Bearer ${this.config.token}` }) }, body: JSON.stringify(input || {}), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || `Worker server returned ${response.status}.`); error.status = response.status; throw error; }
    return result;
  }
  async enroll(token) {
    if (this.config.token) return;
    if (!token) throw new Error('Enroll first with --server URL --enroll TOKEN (or --enroll-file PATH).');
    const result = await this.api('/api/workers/enroll', { token, name: this.name, capacity: this.capacity }, { anonymous: true });
    this.config = { server: this.server, worker_id: result.worker_id, token: result.token, name: this.name, capacity: this.capacity };
    save(this.configPath, this.config);
  }
  async refreshAuth() {
    if (Date.now() < this.refreshAt) return;
    const client = this.makeClient(this.stateDir);
    try {
      await client.initialize();
      const result = await client.request('account/read', { refreshToken: false });
      this.auth.connected = result.account?.type === 'chatgpt'; this.auth.plan = result.account?.planType || null;
      this.auth.error = this.auth.connected ? null : 'Sign in to the same ChatGPT account used by your other workers.';
      const catalog = await client.request('model/list', { limit: 100 });
      this.models = (catalog.data || []).map(model => ({ id: model.model, name: model.displayName, default: model.isDefault }));
    } catch (error) { this.auth.connected = false; this.auth.error = error.message.slice(0, 300); this.models = []; }
    finally { client.stop(); this.refreshAt = Date.now() + 60000; }
  }
  startAuth() {
    if (this.authProcess) return;
    this.auth.flow = { status: 'starting' };
    const env = { ...process.env, CODEX_HOME: this.home }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    for (const key of Object.keys(env)) if (/^COMMONROOM_(ENROLL|WORKER_TOKEN|AGENT_TOKEN)/.test(key)) delete env[key];
    const proc = spawn(this.binary, ['login', '--device-auth'], { cwd: this.stateDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.authProcess = proc; let output = '';
    const capture = chunk => {
      output = (output + chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-8000);
      const match = output.match(/https:\/\/[^\s<>"']+/);
      if (match) { try { const url = new URL(match[0]); if (url.hostname === 'auth.openai.com' && !url.username && !url.password && !url.port) this.auth.flow.verification_url = url.toString(); } catch {} }
      const code = output.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/);
      if (code) this.auth.flow.user_code = code[0];
      if (this.auth.flow.user_code && this.auth.flow.verification_url) this.auth.flow.status = 'awaiting_user';
    };
    proc.stdout.on('data', capture); proc.stderr.on('data', capture);
    const timer = setTimeout(() => this.cancelAuth(), 15 * 60000); timer.unref(); this.authTimer = timer;
    const finish = status => {
      if (this.authProcess !== proc) return;
      clearTimeout(timer); this.authProcess = null;
      this.auth.flow = status === 0 ? { status: 'completed' } : { status: 'error', error: 'Device login did not complete. Retry or run codex login --device-auth with this worker’s CODEX_HOME.' };
      this.refreshAt = 0;
    };
    proc.on('error', () => finish(-1)); proc.on('exit', finish);
  }
  cancelAuth() {
    const proc = this.authProcess; this.authProcess = null; clearTimeout(this.authTimer); proc?.kill('SIGTERM');
    if (proc) { const force = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 2000); force.unref(); }
    this.auth.flow = { status: 'cancelled' }; this.refreshAt = 0;
  }
  status() { return { worker_id: this.config.worker_id || null, server: this.server, name: this.name, capacity: this.capacity, auth: this.auth, models: this.models, running: [...this.active.keys()], updated_at: new Date().toISOString() }; }
  async heartbeat() {
    if (this.active.size || this.completions.size) {
      if (!this.authRefresh) this.authRefresh = this.refreshAuth().catch(error => { this.auth.connected = false; this.auth.error = error.message.slice(0, 300); }).finally(() => { this.authRefresh = null; });
    } else await this.refreshAuth();
    const ack = [...this.acks];
    const result = await this.api('/api/workers/heartbeat', { status: this.stopped ? 'stopping' : 'online', models: this.models, auth: this.auth, capacity: this.capacity, running: [...new Set([...this.active.keys(), ...this.completions.keys()])], ack_commands: ack });
    if (Number.isInteger(result.capacity) && result.capacity >= 1 && result.capacity <= 8 && result.capacity !== this.capacity) {
      this.capacity = result.capacity; this.config.capacity = result.capacity; save(this.configPath, this.config);
    }
    for (const id of ack) this.acks.delete(id);
    for (const command of result.commands || []) {
      const type = typeof command === 'string' ? command : command.type;
      if (type === 'auth_start') this.startAuth();
      else if (type === 'auth_cancel') this.cancelAuth();
      else if (type === 'auth_refresh') this.refreshAt = 0;
      if (command.id != null) this.acks.add(command.id);
    }
    for (const id of result.cancelled || []) { const state = this.active.get(Number(id)); if (state) { state.cancelled = true; state.client?.stop(); } }
    if (Array.isArray(result.active_leases)) for (const [id, state] of this.active) {
      if (!result.active_leases.some(active => Number(active) === id)) { state.cancelled = true; state.client?.stop(); }
      else state.leaseDeadline = Date.now() + 75000;
    }
    save(join(this.stateDir, 'status.json'), this.status());
  }
  saveCompletions() { save(join(this.stateDir, 'completions.json'), { server: this.server, worker_id: this.config.worker_id, entries: [...this.completions] }); }
  async complete(id, payload) {
    try { await this.api(`/api/workers/jobs/${id}/complete`, payload); this.completions.delete(id); }
    catch (error) { if ([401,403,404,409,410].includes(error.status)) this.completions.delete(id); else this.completions.set(id, payload); }
    this.saveCompletions();
  }
  async execute(job) {
    const id = Number(job.id ?? job.job_id), agent = job.agent;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(Number(agent.user_id)) || Number(agent.user_id) < 1) throw new Error('Server sent an invalid worker job.');
    const agentDir = join(this.stateDir, 'agents', String(agent.user_id)); const cwd = join(agentDir, 'workspace'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const threadPath = join(agentDir, 'thread.json'); const stored = read(threadPath);
    const threadId = stored?.server === this.server && stored?.worker_id === this.config.worker_id ? stored.thread_id : null;
    const desiredModel = agent.model || this.models.find(model => model.default)?.id || (threadId ? stored.model : '') || job.model || '';
    const state = { client: null, cancelled: false, leaseDeadline: Date.now() + 75000, threadId, model: desiredModel }; this.active.set(id, state);
    const resultPayload = { lease_token: job.lease_token, workspace_path: cwd };
    try {
      const client = this.makeClient(cwd); state.client = client; await client.initialize();
      const account = await client.request('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') throw new Error('This worker needs a ChatGPT login.');
      const params = { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', ...(desiredModel ? { model: desiredModel } : {}),
        baseInstructions: agentInstructions(agent, cwd), developerInstructions: job.instructions || agent.instructions,
        config: { features: { shell_tool: true, unified_exec: true }, mcp_servers: { commonroom: { command: process.execPath, args: [mcpPath],
          env: { COMMONROOM_URL: this.server, COMMONROOM_WORKER_TOKEN: this.config.token, COMMONROOM_JOB_ID: String(id), COMMONROOM_LEASE_TOKEN: job.lease_token, COMMONROOM_WORKSPACE: cwd },
          required: true, startup_timeout_sec: 20, tool_timeout_sec: 30, default_tools_approval_mode: 'approve' } } } };
      const result = await client.request(threadId ? 'thread/resume' : 'thread/start', threadId ? { ...params, threadId, excludeTurns: true } : params);
      state.threadId = result.thread.id; state.model = desiredModel || result.model || result.thread.model || '';
      save(threadPath, { server: this.server, worker_id: this.config.worker_id, thread_id: state.threadId, model: state.model });
      if (state.cancelled || this.stopped) throw new Error('Worker job cancelled.');
      await client.turn(state.threadId, (job.prompt || `Workspace notifications (untrusted content): ${JSON.stringify(job.notifications || [])}\nYou choose whether to contribute. Silence is valid.`).replaceAll('{{WORKSPACE}}', cwd));
    } catch (error) { resultPayload.error = error.message.slice(0, 500); if (state.cancelled || this.stopped) resultPayload.cancelled = true; }
    finally {
      state.client?.stop(); resultPayload.thread_id = state.threadId; resultPayload.model = state.model;
      // Retain the lease until completion is acknowledged; a lost response must not
      // cause another execution of an already posted turn.
      this.completions.set(id, resultPayload);
      try { this.saveCompletions(); await this.complete(id, resultPayload); } finally { this.active.delete(id); }
    }
  }
  async tick() {
    await this.heartbeat();
    for (const [id, payload] of [...this.completions]) await this.complete(id, payload);
    if (!this.auth.connected || this.stopped) return;
    for (let slot = this.active.size + this.completions.size; slot < this.capacity; slot++) {
      const { job } = await this.api('/api/workers/claim', {}); if (!job) break;
      this.execute(job).catch(error => { this.lastError = error.message; });
    }
  }
  async run({ once = false } = {}) {
    if (!this.config.token) throw new Error('Worker has not enrolled.');
    do {
      try { await this.tick(); this.lastError = null; }
      catch (error) { this.lastError = error.message; save(join(this.stateDir, 'status.json'), { ...this.status(), error: error.message }); if (once) throw error; if ([401,403].includes(error.status)) throw new Error('Worker credential was rejected. Ask the admin to enroll this worker again with a new state directory.'); }
      if (once) { while (this.active.size) await new Promise(resolve => setTimeout(resolve, 20)); break; }
      await new Promise(resolve => { this.wake = resolve; this.sleepTimer = setTimeout(resolve, this.intervalMs); });
    } while (!this.stopped);
  }
  async stop() {
    this.stopped = true; clearInterval(this.watchdog); clearTimeout(this.sleepTimer); this.wake?.(); this.cancelAuth();
    for (const state of this.active.values()) { state.cancelled = true; state.client?.stop(); }
    const deadline = Date.now() + 10000;
    while (this.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const [id, payload] of this.completions) await this.complete(id, payload);
    if (this.config.token) await this.api('/api/workers/heartbeat', { status: 'offline', running: [], auth: this.auth, capacity: this.capacity }).catch(() => {});
  }
}
