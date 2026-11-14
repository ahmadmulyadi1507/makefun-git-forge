// app.ts — the forge's HTTP server. Routes:
//   GET  /healthz                  env boot probe: 200 {"ok":true}
//   POST /mcp                      Model Context Protocol (JSON-RPC 2.0)
//   POST /api/graphql              GraphQL v4 (single operation or batch)
//   *    /api/v3/...               GitHub REST v3
//   *    /{owner}/{repo}.git/...   git smart HTTP
// Everything else: JSON 404. Every JSON reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { executeGraphQL, executeGraphQLBatch } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type HttpRequest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { ...headers, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? m[1] : null;
}

function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true;
  return bearerToken(req) === token;
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }

      try {
        // Health probe (no auth).
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP endpoint.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          // Parse first: a non-JSON body is a 400/-32700 even before auth.
          let parsed: unknown = null;
          let parseOk = true;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            parseOk = false;
          }
          if (!parseOk) {
            sendRaw(res, 400, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })), {
              'content-type': JSON_TYPE,
            });
            return;
          }
          if (!authed(req)) {
            const id = (parsed as Record<string, unknown>)?.id ?? null;
            sendRaw(res, 401, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Requires authentication' } })), {
              'content-type': JSON_TYPE,
            });
            return;
          }
          const out = handleMcp(store, body);
          sendRaw(res, out.status, Buffer.from(out.body), out.headers);
          return;
        }

        // GraphQL endpoint.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = executeGraphQLBatch(
              store,
              parsed.map((d) => ({ query: String((d as Record<string, unknown>).query ?? ''), variables: ((d as Record<string, unknown>).variables as Record<string, unknown>) ?? {} })),
            );
            sendRaw(res, 200, Buffer.from(JSON.stringify(results)), {
              'content-type': JSON_TYPE,
              'x-github-request-id': store.nextRequestId(),
            });
            return;
          }
          const doc = parsed as Record<string, unknown>;
          const result = executeGraphQL(store, String(doc.query ?? ''), (doc.variables as Record<string, unknown>) ?? {});
          sendRaw(res, 200, Buffer.from(JSON.stringify(result)), {
            'content-type': JSON_TYPE,
            'x-github-request-id': store.nextRequestId(),
          });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const isRoot = path === '/api/v3' || path === '/api/v3/';
          const isMeta = method === 'GET' && path === '/api/v3/meta';
          if (!isRoot && !isMeta && !authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          const body = await readBody(req);
          const request: HttpRequest = { method, path, query, headers, body, baseUrl };
          const out = handleRest(store, request);
          sendRaw(res, out.status, Buffer.from(out.body), out.headers);
          return;
        }

        // Git smart HTTP.
        if (path.includes('.git/')) {
          const body = await readBody(req);
          const out = handleGit(store, method, path, query, headers, body);
          sendRaw(res, out.status, out.body, out.headers);
          return;
        }

        // Everything else: JSON 404.
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
      } catch (e) {
        // Never crash the server on a bad request: 500 JSON.
        try {
          sendJson(res, 500, { message: `Internal error: ${(e as Error).message}` }, { 'x-github-request-id': store.nextRequestId() });
        } catch {
          // response already gone; nothing to do
        }
      }
    })();
  });
}
