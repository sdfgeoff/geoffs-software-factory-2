import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startPublicGateway } from './public-gateway.js';

process.umask(0o077);
const targetPort = Number(process.env.TARGET_PORT || process.env.PORT || 3000);
const gatewayPort = Number(process.env.GATEWAY_PORT || 3001);
const dataDir = resolve(process.env.DATA_DIR || 'data');
const urlPath = resolve(dataDir, 'public-url.txt');
const binary = process.env.CLOUDFLARED_BIN || (existsSync(resolve(dataDir, 'bin/cloudflared')) ? resolve(dataDir, 'bin/cloudflared') : 'cloudflared');
let session;
try {
  const response = await fetch(`http://localhost:${targetPort}/api/session`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Workspace returned HTTP ${response.status}.`);
  session = await response.json();
} catch (error) {
  throw new Error(`Start Commonroom with npm start before sharing it. ${error.message}`);
}
if (session.needs_setup) throw new Error('Create the first admin at localhost before sharing the workspace online.');
let gateway = await startPublicGateway({ port: gatewayPort, targetPort });
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${gatewayPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let publicUrl = null;
let stopping = false;
const timeout = setTimeout(() => {
  console.error('No public address received after 60 seconds. Check the network or try npm run share again.');
  stop(1);
}, 60000);
function stop(code = 0) {
  if (stopping) return;
  stopping = true; clearTimeout(timeout);
  tunnel.kill('SIGTERM');
  if (publicUrl) rmSync(urlPath, { force: true });
  gateway.closeAllConnections(); gateway.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}
const onLine = line => {
  if (!publicUrl) {
    const found = line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
    if (found) {
      publicUrl = found; gateway.setPublicOrigin(publicUrl); clearTimeout(timeout);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(urlPath, `${publicUrl}\n`, { mode: 0o600 });
      console.log(`Public workspace: ${publicUrl}`);
      console.log('Use your existing username and password. Keep this process and Commonroom running.');
      console.log('This temporary address changes when the tunnel is restarted.');
    }
  }
  if (/\bERR\b/.test(line)) console.error(line);
};
createInterface({ input: tunnel.stdout }).on('line', onLine);
createInterface({ input: tunnel.stderr }).on('line', onLine);
tunnel.on('error', error => { console.error(`Cannot start cloudflared: ${error.message}. Install cloudflared or set CLOUDFLARED_BIN.`); stop(1); });
tunnel.on('exit', (code, signal) => {
  if (!stopping) { console.error(`Public tunnel stopped (${signal || code}).`); stop(code || 1); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
// Reload browser routes during later updates without restarting the tunnel or changing its URL.
let reloading = false;
process.on('SIGUSR2', async () => {
  if (stopping || reloading) return;
  reloading = true;
  try {
    const fresh = await import(`./public-gateway.js?reload=${Date.now()}`);
    const previous = gateway;
    previous.closeAllConnections();
    await new Promise(resolve => previous.close(resolve));
    if (stopping) return;
    gateway = await fresh.startPublicGateway({ port: gatewayPort, targetPort, publicOrigin: publicUrl || undefined });
    console.log('Public gateway updated; the address is unchanged.');
  } catch (error) {
    console.error(`Cannot reload the public gateway: ${error.message}`);
    stop(1);
  } finally { reloading = false; }
});
console.log('Starting a temporary HTTPS address…');
