import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

// Only authentication is shared with the host. Personal plugins, MCPs, and shell settings are not.
export function prepareCodexHome(dataDir, { shareAuth = true } = {}) {
  const target = resolve(dataDir, 'codex');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const source = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const auth = join(target, 'auth.json');
  if (shareAuth && existsSync(source) && !existsSync(auth) && resolve(source) !== resolve(auth)) symlinkSync(source, auth);
  writeFileSync(join(target, 'config.toml'), `approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "live"
project_doc_max_bytes = 0
[features]
shell_tool = true
unified_exec = true
apps = false
plugins = false
multi_agent = false
memories = false
browser_use = false
computer_use = false
image_generation = false
view_image = false
workspace_dependencies = false
skill_search = false
request_permissions_tool = false
sleep_tool = false
skip_host_skill_discovery = true
[skills.bundled]
enabled = false
`, { mode: 0o600 });
  return target;
}

export class CodexClient extends EventEmitter {
  constructor({ codexHome, cwd, binary = process.env.CODEX_BIN || 'codex' }) {
    super();
    this.pending = new Map(); this.seq = 0; this.closed = false;
    // Do not inherit API keys: this app explicitly uses the computer's ChatGPT login.
    const env = { ...process.env, CODEX_HOME: codexHome };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    for (const key of Object.keys(env)) if (/^COMMONROOM_(ENROLL|WORKER_TOKEN|AGENT_TOKEN)/.test(key)) delete env[key];
    this.proc = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.stderr = '';
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.id !== undefined) {
        // Full-access commands and edits run without approval prompts. Unexpected interactive requests have no human responder.
        const results = {
          'item/commandExecution/requestApproval': { decision: 'decline' },
          'item/fileChange/requestApproval': { decision: 'decline' },
          'execCommandApproval': { decision: 'denied' },
          'applyPatchApproval': { decision: 'denied' },
          'tool/requestUserInput': { answers: {} },
          'mcpServer/elicitation/request': { action: 'decline', content: null },
          'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
        };
        if (results[message.method]) this.send({ id: message.id, result: results[message.method] });
        else this.send({ id: message.id, error: { code: -32601, message: 'Unsupported request in Commonroom.' } });
      } else this.emit('notification', message);
    });
    const close = error => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.emit('disconnected', error);
    };
    this.proc.on('error', error => close(new Error(`Cannot start Codex: ${error.message}`)));
    this.proc.on('exit', code => close(new Error(`Codex exited (${code ?? 'signal'}).`)));
  }
  send(message) { if (!this.closed) this.proc.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('Codex is disconnected.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out during ${method}.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'commonroom', title: 'Commonroom', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  async turn(threadId, prompt, timeout = 180000) {
    let finish;
    let started = false;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent turn exceeded three minutes.')), timeout);
      const notification = msg => {
        if (msg.method === 'turn/completed' && msg.params.threadId === threadId) {
          const turn = msg.params.turn;
          if (turn.status === 'completed') resolve(turn);
          else reject(new Error(turn.error?.message || `Agent turn ${turn.status}.`));
        }
      };
      const disconnected = error => reject(error);
      this.on('notification', notification); this.once('disconnected', disconnected);
      finish = () => { clearTimeout(timer); this.off('notification', notification); this.off('disconnected', disconnected); };
    });
    // Attach the completion rejection handler before starting a turn.
    completed.catch(() => {});
    try {
      const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      this.activeTurn = result.turn; started = true;
      const resultTurn = await completed;
      this.activeTurn = null;
      return resultTurn;
    } finally {
      finish();
      if (started && this.activeTurn && !this.closed) await this.request('turn/interrupt', { threadId, turnId: this.activeTurn.id }, 2000).catch(() => {});
      this.activeTurn = null;
    }
  }
  stop() {
    if (this.closed || this.stopping) return;
    this.stopping = true; this.proc.kill('SIGTERM');
    const force = setTimeout(() => { if (!this.closed) this.proc.kill('SIGKILL'); }, 2000); force.unref();
  }
}
