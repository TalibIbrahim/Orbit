import { listAlerts } from "@/lib/server/alerts";
import { guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = () => guard(async () => json(listAlerts()));
