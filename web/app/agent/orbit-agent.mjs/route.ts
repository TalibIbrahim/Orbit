import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { agentDistDir } from "@/lib/server/bundle";
import { fail, guard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = () =>
  guard(async () => {
    const file = path.join(agentDistDir(), "orbit-agent.mjs");
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return fail(404, "agent bundle not available");
    }
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { "content-type": "application/javascript; charset=utf-8", "content-length": String(size), "cache-control": "no-store" },
    });
  });
