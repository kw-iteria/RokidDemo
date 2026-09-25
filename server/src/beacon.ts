// UDP discovery beacon so the glasses find the server without typing an address.
import dgram from 'node:dgram';
import os from 'node:os';

export const BEACON_PORT = 47474;

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function startBeacon(port: number, name = 'platepress'): () => void {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let ready = false;
  sock.on('error', (e) => console.warn('[beacon] error', e.message));
  sock.bind(() => { sock.setBroadcast(true); ready = true; });
  const timer = setInterval(() => {
    if (!ready) return;
    const hosts = lanAddresses();
    const msg = Buffer.from(JSON.stringify({ t: name, port, hosts, ts: Date.now() }));
    sock.send(msg, 0, msg.length, BEACON_PORT, '255.255.255.255');
    // Also hit each interface's directed broadcast (some APs drop the limited broadcast).
    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number); const nm = a.netmask.split('.').map(Number);
        const bc = ip.map((o, i) => (o & nm[i]) | (~nm[i] & 255)).join('.');
        sock.send(msg, 0, msg.length, BEACON_PORT, bc);
      }
    }
  }, 1000);
  return () => { clearInterval(timer); sock.close(); };
}
