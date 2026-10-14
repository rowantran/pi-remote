import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { createConnection } from 'node:net';
import { join } from 'node:path';

/** TEST ONLY. The product has no TCP listener. This stands in for tailscaled's trusted
 * HTTPS reverse proxy, overwrites identity headers, and forwards to the private socket. */
export async function testProxy(socketPath: string) {
  const dir = await mkdtemp('/tmp/pi-web-tls-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
    '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const options = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
  let login: string | undefined = 'rowan@example.test';
  const server = createServer(options, (req, res) => {
    const headers = { ...req.headers };
    delete headers['tailscale-user-login'];
    if (login) headers['tailscale-user-login'] = login;
    headers['x-forwarded-host'] = req.headers.host;
    headers.host = 'localhost';
    headers['x-forwarded-proto'] = 'https';
    const upstream = request({ socketPath, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('Test proxy upstream unavailable'); });
    req.pipe(upstream);
  });
  const sockets = new Set<ReturnType<typeof createConnection>>();
  server.on('upgrade', (req, downstream, head) => {
    const upstream = createConnection(socketPath);
    sockets.add(upstream);
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
    upstream.once('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (['tailscale-user-login', 'x-forwarded-proto', 'x-forwarded-host', 'host'].includes(name) || value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
      }
      if (login) lines.push(`Tailscale-User-Login: ${login}`);
      lines.push('Host: localhost', `X-Forwarded-Host: ${req.headers.host}`, 'X-Forwarded-Proto: https', '', '');
      upstream.write(lines.join('\r\n'));
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test proxy did not bind');
  return {
    origin: `https://localhost:${address.port}`,
    setLogin(value: string | undefined) { login = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
