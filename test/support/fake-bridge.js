/**
 * A tiny HTTP-over-Unix-socket stand-in for `jiezi-bridge` used by the route
 * and tool tests. It records requests and answers from a per-test handler map,
 * so a failure path is deterministic and needs no device.
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Start a fake bridge on a temporary socket.
 * @param handlers - map of `"METHOD /path"` to `(body, url) => {status?, body}`.
 * @param options - optional SSE payload, the request key that triggers it,
 *   whether the stream closes immediately, and a callback that receives the
 *   live stream's emit function for tests that push events on demand.
 * @returns the socket path, recorded requests, and a close function.
 */
export async function startFakeBridge(handlers, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jiezi-dsh-fake-'));
  const socketPath = join(directory, 'bridge.sock');
  const requests = [];
  const streams = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://unix');
    const key = `${request.method ?? 'GET'} ${url.pathname}`;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed = null;
      if (body.length > 0) {
        try { parsed = JSON.parse(body); } catch { parsed = body; }
      }
      requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body: parsed });
      if (key === 'GET /v1/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (options.events !== undefined && options.triggerOn === undefined) {
          response.end(options.events);
          return;
        }
        response.write(': ready\n\n');
        streams.add(response);
        response.on('close', () => { streams.delete(response); });
        options.onStream?.((text) => { response.write(text); });
        return;
      }
      const handler = handlers[key];
      if (handler === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'invalid_request', message: `unknown route: ${key}` } }));
        return;
      }
      const result = handler(parsed, url) ?? {};
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body ?? { ok: true }));
      if (options.events !== undefined && options.triggerOn === key) {
        for (const stream of streams) stream.write(options.events);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    close: async () => {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
