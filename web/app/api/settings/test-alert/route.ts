import { guard, json } from "@/lib/server/http";
import { COLORS, notify } from "@/lib/server/notify";

export const dynamic = "force-dynamic";

export const POST = () =>
  guard(async () => json(await notify("Orbit test alert", "If you can read this, notifications work.", COLORS.info)));
