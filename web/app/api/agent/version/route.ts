import { bundleInfo } from "@/lib/server/bundle";
import { fail, guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = () =>
  guard(async () => {
    const info = bundleInfo();
    return info ? json(info) : fail(404, "agent bundle not available");
  });
