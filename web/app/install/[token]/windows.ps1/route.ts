import { serveInstall } from "@/lib/server/install";

export const dynamic = "force-dynamic";

export const GET = async (req: Request, { params }: { params: Promise<{ token: string }> }) =>
  serveInstall(req, (await params).token, "ps");
