import { guard, json } from "@/lib/server/http";
import { verifyOverview } from "@/lib/server/verify";

export const dynamic = "force-dynamic";

/** Phone backup verification status (read-only). */
export const GET = () => guard(async () => json(verifyOverview()));
