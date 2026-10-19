import http from 'node:http';
import { pathToFileURL } from 'node:url';

const staticPaths = new Set(['/', '/index.html', '/app.js', '/composer.js', '/markdown.js', '/style.css', '/favicon.svg', '/vendor/marked.js', '/vendor/dompurify.js']);
const apiRoutes = [
  ['GET', /^\/api\/(session|workspace|search|board|notifications)$/],
  ['GET', /^\/api\/tickets\/[1-9]\d*$/],
  ['GET', /^\/api\/attachments\/[1-9]\d*\/content$/],
  ['GET', /^\/api\/admin\/codex$/],
  ['GET', /^\/api\/channels\/[1-9]\d*\/messages$/],
  ['GET', /^\/api\/messages\/[1-9]\d*(?:\/(?:thread|subscription))?$/],
  ['POST', /^\/api\/(login|logout|channels|tickets|attachments)$/],
  ['POST', /^\/api\/tickets\/[1-9]\d*\/comments$/],
  ['POST', /^\/api\/channels\/[1-9]\d*\/messages$/],
  ['POST', /^\/api\/admin\/(users|agents)$/],
  ['GET', /^\/api\/admin\/workers$/],
  ['POST', /^\/api\/admin\/workers(?:\/[1-9]\d*\/auth)?$/],
  ['PUT', /^\/api\/admin\/workers\/[1-9]\d*$/],
  ['POST', /^\/api\/workers\/(?:enroll|heartbeat|claim|jobs\/[1-9]\d*\/(?:tool|complete))$/],
  ['POST', /^\/api\/admin\/agents\/[1-9]\d*\/wake$/],
  ['PUT', /^\/api\/password$/],
  ['PUT', /^\/api\/tickets\/[1-9]\d*(?:\/subscription)?$/],
  ['PUT', /^\/api\/tickets\/[1-9]\d*\/comments\/[1-9]\d*$/],
  ['PUT', /^\/api\/messages\/[1-9]\d*(?:\/subscription)?$/],
  ['PUT', /^\/api\/notifications\/read$/],
  ['PUT', /^\/api\/channels\/[1-9]\d*\/(subscription|read)$/],
  ['PUT', /^\/api\/admin\/(users|agents)\/[1-9]\d*$/],
];
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid target port.');
  return port;
}
function parseOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin without a trailing slash or path.');
  }
  return { origin: url.origin, host: url.host };
}
function safeHeaders(headers) {
  const denied = new Set([...hopHeaders, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !denied.has(name) && !/^(forwarded$|x-forwarded-|cf-)/i.test(name)));
}
function reject(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify({ error: message }));
}

// The server must listen on loopback, behind an HTTPS tunnel preserving the public Host.
// Its origin is installed after the tunnel URL is known; until then every request fails closed.
export function createPublicGateway({ targetPort = 3000, publicOrigin } = {}) {
  const upstreamPort = portNumber(targetPort);
  let configured = publicOrigin ? parseOrigin(publicOrigin) : null;
  const server = http.createServer((request, response) => {
    response.setHeader('X-Commonroom-Transport', 'polling');
    if (!configured) return reject(response, 503, 'Public gateway is not configured.');
    if (request.headers.host !== configured.host) return reject(response, 403, 'Unrecognized public host.');
    const rawPath = String(request.url || '').split('?')[0];
    // Validate the raw request target before URL parsing can normalize encoded or dot paths.
    if (!rawPath.startsWith('/') || /[%\\#]/.test(rawPath) || rawPath.includes('//') || rawPath.split('/').some(part => part === '.' || part === '..')) {
      return reject(response, 404, 'Endpoint not found.');
    }
    const method = request.method;
    const allowed = (['GET', 'HEAD'].includes(method) && staticPaths.has(rawPath)) || apiRoutes.some(([verb, path]) => method === verb && path.test(rawPath));
    if (!allowed) return reject(response, 404, 'Endpoint not found.');
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const machine=method==='POST'&&/^\/api\/workers\/(?:enroll|heartbeat|claim|jobs\/[1-9]\d*\/(?:tool|complete))$/.test(rawPath);
    if(machine&&(origin!==undefined||fetchSite!==undefined))return reject(response,403,'Worker endpoints are for authenticated machines.');
    if(machine&&rawPath!=='/api/workers/enroll'&&!/^Bearer [a-f0-9]{64}$/.test(request.headers.authorization||''))return reject(response,401,'Worker bearer credential required.');
    if ((origin !== undefined && origin !== configured.origin) || (fetchSite !== undefined && !['same-origin', 'none'].includes(fetchSite))) {
      return reject(response, 403, 'Request must come from this public origin.');
    }
    if (!machine && !['GET', 'HEAD'].includes(method) && (origin !== configured.origin || fetchSite !== 'same-origin')) {
      return reject(response, 403, 'Same-origin browser request required.');
    }
    const headers = safeHeaders(request.headers);
    headers.host = `localhost:${upstreamPort}`;
    if (origin !== undefined) headers.origin = `http://localhost:${upstreamPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, method, path: request.url, headers }, incoming => {
      const outgoingHeaders = safeHeaders(incoming.headers);
      outgoingHeaders['x-commonroom-transport'] = 'polling';
      if (incoming.headers['set-cookie']) outgoingHeaders['set-cookie'] = incoming.headers['set-cookie'].map(cookie => /;\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
      response.writeHead(incoming.statusCode || 502, outgoingHeaders);
      response.flushHeaders(); // Keep EventSource notifications streaming through the tunnel.
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (!response.headersSent) reject(response, 502, 'Workspace is unavailable.'); else response.destroy(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.setPublicOrigin = value => { configured = parseOrigin(value); return server; };
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}

export async function startPublicGateway({ port = 3001, ...options } = {}) {
  const server = createPublicGateway(options);
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to the exact HTTPS public origin.');
  const server = await startPublicGateway({ port: Number(process.env.PORT || 3001), targetPort: Number(process.env.TARGET_PORT || 3000), publicOrigin: process.env.PUBLIC_ORIGIN });
  console.log(`Commonroom public gateway is listening on 127.0.0.1:${server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
