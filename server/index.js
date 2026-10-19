import { createApp } from './app.js';
import { networkInterfaces } from 'node:os';
process.umask(0o077);
const service = await createApp();
const address = await service.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
console.log(`Commonroom is ready: http://localhost:${address.port}`);
for (const addresses of Object.values(networkInterfaces())) for (const a of addresses || []) {
  if (a.family === 'IPv4' && !a.internal) console.log(`LAN: http://${a.address}:${address.port}`);
}
if (!service.store.hasUsers()) console.log('Open localhost on this computer to create the first admin.');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true; await service.close(); process.exit(0);
});
