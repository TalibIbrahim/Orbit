import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ApiError } from "@orbit/shared";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

export interface Req {
  method: string;
  path: string; // without query, e.g. "/v1/folders/abc"
  query: URLSearchParams;
  params: Record<string, string>; // from ":name" segments
  body: unknown; // parsed JSON (POST/PATCH/PUT), undefined otherwise
  raw: IncomingMessage;
}

export type Handler = (req: Req) => unknown | Promise<unknown>; // return value is JSON-encoded with 200

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  auth: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean } = {}): void {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, auth: opts.auth ?? true });
  }
  get(p: string, h: Handler, o?: { auth?: boolean }) { this.add("GET", p, h, o); }
  post(p: string, h: Handler, o?: { auth?: boolean }) { this.add("POST", p, h, o); }
  patch(p: string, h: Handler, o?: { auth?: boolean }) { this.add("PATCH", p, h, o); }
  delete(p: string, h: Handler, o?: { auth?: boolean }) { this.add("DELETE", p, h, o); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(json);
}

export function startServer(router: Router, opts: { host: string; port: number; token: string }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://agent");
    const method = req.method ?? "GET";
    try {
      const m = router.match(method, url.pathname);
      if (!m) throw new HttpError(404, `no route ${method} ${url.pathname}`);
      if (m.route.auth && !tokenOk(req.headers.authorization, opts.token)) throw new HttpError(401, "unauthorized");
      const body = method === "GET" || method === "DELETE" ? undefined : await readJson(req);
      const out = await m.route.handler({ method, path: url.pathname, query: url.searchParams, params: m.params, body, raw: req });
      send(res, 200, out ?? { ok: true });
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "internal error", (e as Error)?.message);
      if (err.status >= 500) console.error(`[http] ${method} ${url.pathname}:`, e);
      send(res, err.status, { error: err.message, detail: err.detail } satisfies ApiError);
    }
  });
  server.listen(opts.port, opts.host, () => console.log(`[http] listening on ${opts.host}:${opts.port}`));
  return server;
}
