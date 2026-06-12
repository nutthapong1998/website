# Security Playbook — API routes, Auth, Firestore, Cloudflare

Read this before writing or modifying anything under `app/api/`, `app/admin/`,
auth code, or Firestore rules. The threat model: the `*.run.app` URL is
publicly reachable, every API route is callable by anyone with curl, and the
admin subdomain is a high-value target. Each layer below assumes the layer in
front of it has already failed.

## Table of contents

1. [Auth guards (requireUser / requireAdmin)](#1-auth-guards)
2. [Session cookies for the admin subdomain](#2-session-cookies)
3. [Roles via custom claims](#3-roles-via-custom-claims)
4. [Input validation with zod](#4-input-validation)
5. [Firestore security rules](#5-firestore-security-rules)
6. [Security headers](#6-security-headers)
7. [Rate limiting](#7-rate-limiting)
8. [Cloudflare hardening checklist](#8-cloudflare-hardening-checklist)
9. [Secrets handling](#9-secrets-handling)
10. [Pre-deploy security checklist](#10-pre-deploy-security-checklist)

---

## 1. Auth guards

One small module, used by every protected handler. Throwing a `Response` lets
handlers stay flat — no nested try/catch per route.

```ts
// src/lib/auth/guards.ts
import "server-only";
import { cookies } from "next/headers";
import { getAuth, DecodedIdToken } from "firebase-admin/auth";
import "@/lib/firebase/admin"; // ensure app is initialized

export async function requireUser(): Promise<DecodedIdToken> {
  const session = (await cookies()).get("__session")?.value;
  if (!session) throw unauthorized();
  try {
    // checkRevoked: true → logout/disable takes effect immediately,
    // at the cost of one extra Firestore-side lookup per call
    return await getAuth().verifySessionCookie(session, true);
  } catch {
    throw unauthorized();
  }
}

export async function requireAdmin(): Promise<DecodedIdToken> {
  const user = await requireUser();
  if (user.role !== "admin") throw forbidden();
  return user;
}

const unauthorized = () => new Response("Unauthorized", { status: 401 });
const forbidden = () => new Response("Forbidden", { status: 403 });
```

Usage in a route handler — guard first, validate second, act third:

```ts
// src/app/api/admin/posts/route.ts
import { requireAdmin } from "@/lib/auth/guards";
import { postSchema } from "@/lib/validation/post";
import { adminDb } from "@/lib/firebase/admin";

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = postSchema.parse(await req.json());
    const ref = await adminDb.collection("posts").add({
      ...body,
      createdBy: admin.uid,          // identity comes from the token,
      createdAt: new Date(),         // NEVER from the request body
    });
    return Response.json({ id: ref.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;   // guard threw 401/403
    if (e instanceof Error && e.name === "ZodError")
      return Response.json({ error: "Invalid input" }, { status: 400 });
    console.error(e);                       // log details server-side…
    return new Response("Internal error", { status: 500 }); // …never to client
  }
}
```

For client-side fetches that send an **ID token** instead of a cookie
(e.g. from the public site), verify with
`getAuth().verifyIdToken(bearerToken)` — same guard shape, different source.

## 2. Session cookies

Admin pages are server-rendered, so they need auth that travels with normal
navigation — that's a session cookie, not a bearer token in JS memory.

Flow: client signs in with Firebase Auth (client SDK) → POSTs the short-lived
ID token to `/api/auth/session` → server mints a long-lived session cookie.

```ts
// src/app/api/auth/session/route.ts
import { getAuth } from "firebase-admin/auth";
import { cookies } from "next/headers";
import "@/lib/firebase/admin";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const { idToken } = await req.json();
  const decoded = await getAuth().verifyIdToken(idToken);

  // Only freshly-authenticated tokens may become sessions (blocks replay
  // of an old stolen token into a week-long cookie)
  if (Date.now() / 1000 - decoded.auth_time > 5 * 60)
    return new Response("Recent sign-in required", { status: 401 });

  const cookie = await getAuth().createSessionCookie(idToken, { expiresIn: WEEK });
  (await cookies()).set("__session", cookie, {
    httpOnly: true,     // JS cannot read it → XSS can't steal it
    secure: true,
    sameSite: "strict", // CSRF protection for free
    path: "/",
    maxAge: WEEK / 1000,
  });
  return new Response(null, { status: 204 });
}

export async function DELETE() {
  (await cookies()).delete("__session");
  return new Response(null, { status: 204 });
}
```

The admin layout enforces auth for every admin page in one place:

```ts
// src/app/admin/layout.tsx
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch {
    redirect("/login");
  }
  return <>{children}</>;
}
```

Cookie name note: `__session` is the only cookie Firebase Hosting forwards —
irrelevant on Cloud Run, but keeping the convention costs nothing and keeps a
future migration open.

## 3. Roles via custom claims

The role must live where the client cannot write it: in the Firebase token's
**custom claims**, settable only by the Admin SDK.

```ts
// scripts/set-admin.ts — run manually: npx tsx scripts/set-admin.ts <email>
import { getAuth } from "firebase-admin/auth";
import "../src/lib/firebase/admin";

const email = process.argv[2];
const user = await getAuth().getUserByEmail(email);
await getAuth().setCustomUserClaims(user.uid, { role: "admin" });
console.log(`✅ ${email} is now admin (takes effect on next token refresh)`);
```

- Claims appear in the token only after the user re-authenticates or the
  token refreshes (≤1 hour). Force it client-side with `getIdToken(true)`.
- Never store the role in Firestore as the source of truth for authz — a
  compromised rule or admin-SDK write path then becomes privilege escalation.
  Firestore may *mirror* the role for display, but checks read the claim.

## 4. Input validation

Every external input — body, query string, route params — goes through a zod
schema before it touches Firestore or business logic.

```ts
// src/lib/validation/post.ts
import { z } from "zod";

export const postSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000),
    tags: z.array(z.string().max(30)).max(10).default([]),
    published: z.boolean().default(false),
  })
  .strict(); // unknown fields are rejected, not silently passed to Firestore

export type PostInput = z.infer<typeof postSchema>;
```

Why `.strict()` matters: without it, an attacker can append
`{"role": "admin"}` or `{"createdBy": "someone-else"}` to a request and a
careless `...body` spread writes it straight into the document. `.strict()`
turns that class of mass-assignment bug into a 400.

Reuse the same schema in the client form (react-hook-form + zodResolver or
manual `safeParse`) so client and server never disagree about what's valid.

## 5. Firestore security rules

Rules protect the **client SDK** path only (Admin SDK bypasses them — that's
why API handlers need guards). Default-deny, then open specific paths:

```js
// firestore.rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function isAdmin()    { return isSignedIn() && request.auth.token.role == 'admin'; }
    function isOwner(uid) { return isSignedIn() && request.auth.uid == uid; }

    // Public content: world-readable, writable only via Admin SDK (API)
    match /posts/{id} {
      allow read: if resource.data.published == true || isAdmin();
      allow write: if false;   // all writes go through the API
    }

    // Per-user data
    match /users/{uid} {
      allow read, update: if isOwner(uid);
      allow create, delete: if false;
      // block users from granting themselves fields they shouldn't touch
      allow update: if isOwner(uid)
        && !request.resource.data.diff(resource.data).affectedKeys()
            .hasAny(['role', 'plan']);
    }

    // Everything else: denied
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Deploy with `firebase deploy --only firestore:rules`. Test rules against the
emulator (`firebase emulators:start --only firestore`) before deploying —
a rules typo fails open more often than you'd expect.

Pragmatic default for this architecture: **route all writes through API
handlers** (Admin SDK + guards + zod) and let the client SDK do reads only.
Fewer rules to get wrong.

## 6. Security headers

Set once in `next.config.ts` — applies to every response:

```ts
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com",
      "frame-src https://*.firebaseapp.com",   // Firebase Auth popup/redirect
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig = {
  output: "standalone",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
```

The CSP above is a working starting point for Firebase Auth + Firestore;
tighten `unsafe-inline` later with nonces if the project warrants it. When
something breaks (auth popup, fonts), fix the CSP — don't delete it.

## 7. Rate limiting

Cloud Run autoscales across instances, so an in-memory counter resets per
instance and is trivially bypassed. Layer it:

1. **Cloudflare rate limiting rules (primary)** — enforced at the edge before
   traffic costs you anything:
   - `/api/*` → 60 req/min per IP
   - `/api/auth/*` → 10 req/min per IP (brute-force)
   - `admin.example.com/*` → 30 req/min per IP
2. **App-level (for the few endpoints that need per-user limits)** — store
   counters in Firestore with a TTL field, or keep it simple: sensitive
   actions (password change, claim changes) already require recent
   authentication (see session section), which is itself a throttle.
3. **Cloud Run `--max-instances`** — your billing-protection backstop against
   a flood that gets past the edge.

## 8. Cloudflare hardening checklist

Work through this once per environment:

- [ ] SSL/TLS mode = **Full (strict)** (Flexible = plaintext to origin + loops)
- [ ] **Always Use HTTPS** + **HSTS** enabled
- [ ] Transform Rule injecting `X-Origin-Auth: <secret>` on both hostnames;
      middleware rejects requests without it (closes the `*.run.app` bypass)
- [ ] Rotate `ORIGIN_AUTH_SECRET` if it ever lands in a log or commit
- [ ] **Cloudflare Access** policy on `admin.example.com` (email allowlist or
      IdP; free ≤50 users). Admin is then invisible to the public internet.
- [ ] WAF managed ruleset ON; review events after a week, tune false positives
- [ ] Rate limiting rules from section 7
- [ ] **Bot Fight Mode** ON (free tier)
- [ ] DNS records for `www`/`admin` are **Proxied** (orange) — a grey-cloud
      record leaks the origin and skips every protection above
- [ ] Security Level ≥ Medium; consider "Under Attack" mode as an emergency
      lever you know how to flip

## 9. Secrets handling

(Env-file layout, leak scanning, and rotation procedure live in
[secrets.md](secrets.md) — this section covers only the IAM/runtime side.)

- Server secrets → **Secret Manager**, wired with
  `gcloud run deploy --set-secrets NAME=secret-name:latest`. Grant the runtime
  service account `roles/secretmanager.secretAccessor`.
- `NEXT_PUBLIC_*` is **public by definition** — it's compiled into the JS
  bundle anyone can read. Firebase client config (apiKey etc.) is *designed*
  to be public; real protection is security rules + App Check, not hiding it.
- `.env.local` and `.env*` stay in `.gitignore` AND `.dockerignore` — check
  both, an env file baked into an image layer is a leak even if deleted later.
- No service-account JSON files in the repo, ever. Local dev uses
  `gcloud auth application-default login`; Cloud Run uses the attached
  service account. If a key file was ever committed, revoke the key in IAM —
  deleting the file does not un-leak it.
- Grant the Cloud Run service account only what it uses: typically
  `roles/datastore.user` + `roles/secretmanager.secretAccessor`. Not Editor.

## 10. Pre-deploy security checklist

Run through before every production deploy that touched auth/API/rules:

- [ ] Every `app/api/admin/**` handler calls `requireAdmin()` before any work
- [ ] No handler reads `uid`/`role`/identity from the request body
- [ ] All write endpoints validate with a `.strict()` zod schema
- [ ] `firestore.rules` still default-denies (`match /{document=**}` block intact)
- [ ] `import "server-only"` present in `lib/firebase/admin.ts`, `lib/auth/*`
- [ ] Error responses are generic; stack traces only in server logs
- [ ] `curl https://<service>.run.app/` returns 404 (origin lockdown working)
- [ ] `curl https://www.example.com/admin` returns 404 (host isolation working)
- [ ] Opening `https://admin.example.com` in an incognito window hits
      Cloudflare Access *before* anything else renders
