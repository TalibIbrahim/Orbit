import { agentSend, cachedGet } from "@/lib/server/agents";
import { getDevice } from "@/lib/server/db";
import { fail, guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; path: string[] }> };

const handle = (req: Request, { params }: Ctx) =>
  guard(async () => {
    const { id, path } = await params;
    const device = getDevice(id);
    if (!device) return fail(404, "unknown device");
    const agentPath = `/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`;

    if (req.method === "GET") return json(await cachedGet(device, agentPath));

    let body: unknown;
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return fail(400, "body must be JSON");
      }
    }
    return json(await agentSend(device, req.method, agentPath, body));
  });

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
