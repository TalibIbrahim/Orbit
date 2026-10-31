import { AUTH_COOKIE, authToken, safeEqual } from "@/lib/server/auth";
import { fail, guard, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = (req: Request) =>
  guard(async () => {
    const password = process.env.ORBIT_PASSWORD;
    if (!password) return json({ ok: true });
    const body = await readJson<{ password?: string }>(req);
    if (typeof body.password !== "string" || !safeEqual(body.password, password)) return fail(401, "wrong password");
    const res = json({ ok: true });
    res.cookies.set(AUTH_COOKIE, authToken(password), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 400 * 24 * 3600,
      secure: req.url.startsWith("https:") || req.headers.get("x-forwarded-proto") === "https",
    });
    return res;
  });
