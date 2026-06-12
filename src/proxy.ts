import { NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  // Origin lockdown: only accept traffic that came through Cloudflare.
  // The *.run.app URL is public — without this check anyone can bypass
  // the WAF, rate limits, and Cloudflare Access entirely.
  if (
    process.env.NODE_ENV === "production" &&
    req.headers.get("x-origin-auth") !== process.env.ORIGIN_AUTH_SECRET
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;
  const isAdminHost = host.startsWith("admin.");

  // Admin subdomain serves only the admin tree
  if (
    isAdminHost &&
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/api")
  ) {
    return NextResponse.rewrite(
      new URL(`/admin${pathname === "/" ? "" : pathname}`, req.url),
    );
  }

  // Admin paths must not be reachable from the main domain
  if (
    !isAdminHost &&
    (pathname.startsWith("/admin") || pathname.startsWith("/api/admin"))
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
