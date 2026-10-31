import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { cleanTerminal, scrubForStorage } from '../core/safety.ts';
import { WebController, type WebControllerOptions } from './controller.ts';
import {
  PromptReplySchema,
  ResumeRequestSchema,
  StartRequestSchema,
  WebError,
} from './contracts.ts';

const MAX_BODY_BYTES = 64 * 1024;
const EmptyBody = z.object({}).strict();
const Identifier = z.string().uuid();
const ASSETS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
} as const;

export interface WebServerOptions extends WebControllerOptions {
  port?: number;
}

export interface WebServer {
  origin: string;
  url: string;
  close(): Promise<void>;
}

/** The listener exposes only local UI assets and the authenticated workflow facade. */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(options.port ?? 0);
  const assets = new Map(
    await Promise.all(
      Object.entries(ASSETS).map(
        async ([path, asset]) =>
          [
            path,
            {
              ...asset,
              content: await readFile(new URL(`./public/${asset.file}`, import.meta.url)),
            },
          ] as const,
      ),
    ),
  );
  await options.store.init();
  const controller = new WebController(options);
  const token = randomBytes(32).toString('base64url');
  let origin = '';
  let authority = '';
  let closing: Promise<void> | undefined;
  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      securityHeaders(response);
      void handle(request, response).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        const status =
          error instanceof WebError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : isMissing(error)
                ? 404
                : 500;
        const message =
          error instanceof z.ZodError
            ? 'Invalid request. Check the supplied fields.'
            : isMissing(error)
              ? 'The requested record was not found.'
              : error instanceof Error
                ? error.message
                : 'The request failed.';
        if (status === 413) response.setHeader('Connection', 'close');
        sendJson(response, status, { error: cleanTerminal(message) });
      });
    },
  );
  server.maxHeadersCount = 50;
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!singleHeader(request, 'host') || request.headers.host !== authority)
      throw new WebError(403, 'Unrecognized local server address.');
    if (
      request.headers.origin !== undefined &&
      (!singleHeader(request, 'origin') || request.headers.origin !== origin)
    )
      throw new WebError(403, 'Requests must come from this local interface.');
    const path = request.url ?? '';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#'))
      throw new WebError(404, 'Unknown route.');
    const asset = assets.get(path);
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new WebError(405, 'Method not allowed.');
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(request.method === 'HEAD' ? undefined : asset.content);
      return;
    }
    if (!path.startsWith('/api/')) throw new WebError(404, 'Unknown route.');
    const supplied = request.headers['x-agentgate-token'];
    if (
      !singleHeader(request, 'x-agentgate-token') ||
      typeof supplied !== 'string' ||
      !equalToken(supplied, token)
    )
      throw new WebError(401, 'Open the current link printed by agentgate web to connect.');
    if (closing) throw new WebError(503, 'The local server is stopping.');
    if (request.method === 'GET') {
      if (path === '/api/state') return sendJson(response, 200, await controller.state());
      const run = path.match(/^\/api\/runs\/([^/]+)$/);
      if (run) return sendJson(response, 200, await controller.getRun(Identifier.parse(run[1])));
      const operation = path.match(/^\/api\/operations\/([^/]+)$/);
      if (operation)
        return sendJson(response, 200, controller.getOperation(Identifier.parse(operation[1])));
      throw new WebError(404, 'Unknown route.');
    }
    if (request.method !== 'POST') throw new WebError(405, 'Method not allowed.');
    if (!singleHeader(request, 'origin') || request.headers.origin !== origin)
      throw new WebError(403, 'A matching Origin is required.');
    if (
      !singleHeader(request, 'content-type') ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
    )
      throw new WebError(415, 'Requests must use application/json.');
    const body = await readJson(request);
    if (path === '/api/runs')
      return sendJson(response, 202, controller.start(StartRequestSchema.parse(body)));
    const resume = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
    if (resume)
      return sendJson(
        response,
        202,
        controller.resume(Identifier.parse(resume[1]), ResumeRequestSchema.parse(body)),
      );
    const cancel = path.match(/^\/api\/operations\/([^/]+)\/cancel$/);
    if (cancel) {
      EmptyBody.parse(body);
      controller.cancel(Identifier.parse(cancel[1]));
      return sendJson(response, 200, { ok: true });
    }
    const prompt = path.match(/^\/api\/prompts\/([^/]+)\/respond$/);
    if (prompt) {
      controller.respond(Identifier.parse(prompt[1]), PromptReplySchema.parse(body));
      return sendJson(response, 200, { ok: true });
    }
    const inspect = path.match(/^\/api\/runs\/([^/]+)\/inspect$/);
    if (inspect) {
      EmptyBody.parse(body);
      return sendJson(response, 200, await controller.inspect(Identifier.parse(inspect[1])));
    }
    throw new WebError(404, 'Unknown route.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local HTTP address was assigned.');
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  return {
    origin,
    url: `${origin}/#token=${token}`,
    close() {
      closing ??= (async () => {
        try {
          await controller.close();
        } finally {
          const stopped = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          server.closeAllConnections();
          await stopped;
        }
      })();
      return closing;
    },
  };
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function singleHeader(request: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  return count === 1;
}

function equalToken(supplied: string, expected: string): boolean {
  const actual = Buffer.from(supplied);
  const known = Buffer.from(expected);
  return actual.length === known.length && timingSafeEqual(actual, known);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(scrubForStorage(value)));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  // Keep the socket usable long enough to return a bounded error response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new WebError(413, 'Request body exceeds 64 KiB.');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WebError(400, 'Request body must contain valid JSON.');
  }
}
