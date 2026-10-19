#!/usr/bin/env node
import { readFileSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntime } from './runtime.js';

const args = process.argv.slice(2), options = {};
const flags = new Set(['once','status','auth','help']);
for (let index = 0; index < args.length; index++) {
  const flag = args[index].replace(/^--/, '');
  if (!args[index].startsWith('--') || !['server','enroll','enroll-file','state','name','capacity',...flags].includes(flag)) throw new Error(`Unknown worker option ${args[index]}.`);
  if (flags.has(flag)) options[flag] = true;
  else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`--${flag} requires a value.`); options[flag] = value; }
}
if (options.help) {
  console.log('Commonroom worker\nnode worker/index.js --server URL --enroll TOKEN --state DIR [--name NAME] [--capacity 1]\nUse --enroll-file PATH instead of putting a token on the command line.\nAfter enrollment: node worker/index.js --state DIR\n--status: show local diagnostics without secrets. --auth: sign in with a local device flow. --once: one scheduling poll.\nEach worker must sign in to the same ChatGPT account. OpenAI credentials stay in DIR/codex.');
} else {
  const runtime = new WorkerRuntime({ stateDir: options.state || process.env.COMMONROOM_WORKER_STATE || '.commonroom-worker', server: options.server || process.env.COMMONROOM_SERVER, name: options.name || process.env.COMMONROOM_WORKER_NAME, capacity: options.capacity || process.env.COMMONROOM_WORKER_CAPACITY });
  let closing, ownsState = false, releaseLock = () => {};
  const acquireLock = () => {
    const path = join(runtime.stateDir, 'worker.lock');
    const startTime = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; } };
    try { const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (previous.host !== hostname() || (startTime(previous.pid) && startTime(previous.pid) === previous.started)) throw new Error('State directory is already locked by a worker. Stop it first; remove worker.lock only after confirming the old worker has stopped.');
      unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: startTime(process.pid), host: hostname() })); } finally { closeSync(fd); }
    ownsState = true;
    releaseLock = () => { try { unlinkSync(path); } catch {} };
  };
  const stop = () => { if (ownsState) closing ||= runtime.stop(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (options.status) { try { console.log(readFileSync(`${runtime.stateDir}/status.json`, 'utf8')); } catch { await runtime.refreshAuth(); console.log(JSON.stringify(runtime.status(), null, 2)); } }
    else if (options.auth) {
      acquireLock(); runtime.startAuth(); let displayed = '';
      while (runtime.authProcess) { const value = JSON.stringify(runtime.auth.flow); if (value !== displayed) { console.log(value); displayed = value; } await new Promise(resolve => setTimeout(resolve, 500)); }
      await runtime.refreshAuth(); console.log(JSON.stringify(runtime.auth));
      if (!runtime.auth.connected) process.exitCode = 1;
    } else {
      acquireLock();
      const tokenFile = options['enroll-file'] || process.env.COMMONROOM_ENROLL_FILE;
      const enrollment = runtime.config.token ? null : options.enroll || process.env.COMMONROOM_ENROLL_TOKEN || (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null);
      await runtime.enroll(enrollment);
      console.log(`Worker ${runtime.config.worker_id} connected to ${runtime.server}. ChatGPT credentials stay on this worker.`);
      await runtime.run({ once: Boolean(options.once) });
    }
  } catch (error) { console.error(`Worker: ${error.message}`); process.exitCode = 1; }
  finally { if (ownsState) await (closing || runtime.stop()); else clearInterval(runtime.watchdog); releaseLock(); }
}
