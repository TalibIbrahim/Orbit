import { guard, json } from "@/lib/server/http";
import { computeReplication } from "@/lib/server/replication";

export const dynamic = "force-dynamic";

export const GET = () => guard(async () => json(computeReplication()));
