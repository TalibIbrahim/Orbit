import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authToken, safeEqual } from "@/lib/server/auth";

const OPEN = [
  /^\/login$/, /^\/api\/login$/, /^\/api\/enroll$/, /^\/api\/agent\/version$/, /^\/agent\//, /^\/install\//,
  /^\/manifest\.webmanifest$/, /^\/icons\//, /^\/sw\.js$/, /^\/_next\//, /^\/favicon\.ico$/, /^\/icon\.svg$/, /^\/offline/,
];

export function proxy(req: NextRequest) {
  const password = process.env.ORBIT_PASSWORD;
  if (!password) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (OPEN.some((r) => r.test(pathname))) return NextResponse.next();

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (cookie && safeEqual(cookie, authToken(password))) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
