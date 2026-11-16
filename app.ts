// The server: one node:http server routing git smart HTTP, REST v3, GraphQL and MCP over
// a single store. Every response carries X-GitHub-Request-Id; every error is JSON, never
// HTML; every route except /healthz requires the trial's bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, jsonError } from './githttp.ts';
import { routeRest, type RestRequest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gh-${String(requestCounter).padStart(8, '0')}`;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers);
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const decoded: string[] = [];
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return decoded;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store(process.env.MAKEFUN_TRIAL_NOW);
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'bad request URL' });
        return;
      }
      const path = url.pathname;

      // The env's boot check calls this twice: 200 {"ok":true}. No token.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else requires the trial's bearer token.
      if (shopToken !== '') {
        const authorization = req.headers.authorization ?? '';
        if (authorization !== `Bearer ${shopToken}`) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
      }

      const segments = decodeSegments(path);
      if (segments === null) {
        sendJson(res, 400, { message: 'bad request path' });
        return;
      }

      try {
        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
        const isInfoRefs = segments.length === 4 && segments[1].endsWith('.git') && segments[2] === 'info' && segments[3] === 'refs';
        const isPackEndpoint = segments.length === 3 && segments[1].endsWith('.git') && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack');
        if (isInfoRefs || isPackEndpoint) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            const missing = jsonError(404, 'Not Found');
            sendBuffer(res, missing.status, missing.contentType, missing.body, {});
            return;
          }
          const gitProtocol = req.headers['git-protocol'] ?? null;
          if (isInfoRefs && method === 'GET') {
            const reply = handleInfoRefs(repo, url.searchParams.get('service'), gitProtocol);
            sendBuffer(res, reply.status, reply.contentType, reply.body, {});
            return;
          }
          if (segments[2] === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = handleUploadPack(repo, body, gitProtocol);
            sendBuffer(res, reply.status, reply.contentType, reply.body, {});
            return;
          }
          if (segments[2] === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = handleReceivePack(repo, body);
            sendBuffer(res, reply.status, reply.contentType, reply.body, {});
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let parsed: unknown;
          let malformed = false;
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString('utf8'));
            } catch {
              malformed = true;
            }
          }
          const host = req.headers.host ?? '127.0.0.1';
          const restReq: RestRequest = {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: parsed,
            bodyMalformed: malformed,
            origin: `http://${host}`,
          };
          const reply = routeRest(store, restReq);
          if (reply.empty === true) {
            sendEmpty(res, reply.status, reply.headers);
            return;
          }
          sendJson(res, reply.status, reply.json, reply.headers);
          return;
        }

        // GraphQL.
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const rawBody = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendJson(res, 200, executeGraphQL(store, parsed));
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const rawBody = await readBody(req);
          const reply = handleMcp(store, rawBody);
          if (reply.empty === true) {
            sendEmpty(res, reply.status);
            return;
          }
          sendJson(res, reply.status, reply.json);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // A handler failure is a JSON 500, never a crash and never HTML.
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : String(error) });
        } else {
          res.end();
        }
      }
    })();
  });
}
