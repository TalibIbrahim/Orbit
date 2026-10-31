import { guard, json } from "@/lib/server/http";
import { startVerification } from "@/lib/server/verify";

export const dynamic = "force-dynamic";

/** "Verify now": starts a read-only verification run in the background. */
export const POST = () => guard(async () => json({ started: startVerification("manual") }));
