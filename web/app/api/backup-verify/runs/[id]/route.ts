import { fail, guard, json } from "@/lib/server/http";
import { getRun } from "@/lib/server/verify";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = (_req: Request, { params }: Ctx) =>
  guard(async () => {
    const id = Number((await params).id);
    const run = Number.isInteger(id) ? getRun(id) : null;
    return run ? json(run) : fail(404, "unknown run");
  });
