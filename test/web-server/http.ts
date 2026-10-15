import { request, type IncomingHttpHeaders } from 'node:http';

export interface WebRequestOptions {
  method?: string; headers?: Record<string, string>; body?: unknown; rawBody?: string; chunked?: boolean;
}
/** Real HTTP over the listener's Unix socket, including malformed/chunked body probes. */
export function webRequest(socketPath: string, path: string, options: WebRequestOptions = {}) {
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(Buffer.byteLength(body)) }) }), ...options.headers };
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; json: any }>((accept, reject) => {
    const req = request({ socketPath, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(body); } catch { /* Non-JSON responses are also part of the HTTP contract. */ }
        accept({ status: response.statusCode!, headers: response.headers, body, json });
      });
    });
    req.on('error', reject); req.end(body);
  });
}
