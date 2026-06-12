---
name: nextjs-firebase-cloudrun
description: >
  Full-stack website development with Next.js (App Router), Firebase
  (Firestore/Auth) as the database layer, reverse proxy patterns, API/route
  security, a two-subdomain architecture (main site + admin) behind
  Cloudflare, and deployment to Google Cloud Run via Docker. Use this skill
  whenever the user works on this website project — creating pages or API
  routes, structuring the codebase, connecting to Firebase, securing
  endpoints, managing secrets/.env files, configuring Cloudflare/DNS/WAF,
  rewrites/proxying, designing/styling the profile site, committing or
  opening pull requests, writing or updating README/docs, writing the
  Dockerfile, or deploying/debugging on Cloud Run — even if they only
  mention one part of the stack (e.g. "เพิ่มหน้าใหม่", "ต่อ Firestore",
  "ทำหน้า admin", "ทำ login/OAuth", "อัปโหลดรูป", "แก้เนื้อหาเว็บจาก admin",
  "กัน API ให้ปลอดภัย", "รองรับ traffic เยอะ", "เว็บช้า", "load test",
  "จัดการ secret",
  "ตั้งค่า Cloudflare", "แต่งหน้าเว็บ", "เปิด PR", "เขียน README",
  "ทำ CI/CD", "ขึ้น staging", "deploy ขึ้น Cloud Run").
---

# Next.js + Firebase + Cloud Run Website Development

**Start here every session:**
[references/project-notes.md](references/project-notes.md) holds verified,
project-specific facts (Next 16 renames `middleware.ts` → `src/proxy.ts`,
what exists vs what is still planned, verification gotchas, owner
conventions). It is newer than the generic examples below — where they
disagree, project-notes wins.

Stack for this project:

- **Frontend/Backend**: Next.js (App Router, TypeScript) — one codebase serves
  pages, API route handlers, and acts as the reverse proxy.
- **Database**: Firebase — Firestore for data, Firebase Auth for users.
- **Deploy target**: Google Cloud Run (containerized, autoscaling, pay-per-use).

The golden rule that drives most decisions below: **Cloud Run gives the
container a `PORT` env var and expects the server to listen on `0.0.0.0`**,
and **Next.js must be built with `output: "standalone"`** so the Docker image
stays small and self-contained.

## Project setup

New project:

```bash
npx create-next-app@latest <name> --typescript --app --eslint --src-dir
npm i firebase firebase-admin
```

`next.config.ts` must include standalone output (required for the Dockerfile
below to work):

```ts
const nextConfig = {
  output: "standalone",
};
```

## Code structure

One Next.js app serves both subdomains (main site + admin) — host-based
routing in middleware decides which tree responds. Keep this layout so that
security boundaries are visible in the directory tree itself:

```
src/
├── app/
│   ├── (site)/              # main website — www.example.com
│   │   ├── page.tsx
│   │   ├── about/page.tsx
│   │   └── layout.tsx       # public layout (nav, footer)
│   ├── admin/               # admin.example.com is rewritten here
│   │   ├── login/page.tsx   # Google OAuth login — OUTSIDE the guarded group
│   │   └── (protected)/
│   │       ├── layout.tsx   # guard: verifies session + admin claim, else redirect /login
│   │       ├── page.tsx     # dashboard
│   │       └── <feature>/page.tsx
│   ├── api/
│   │   ├── public/...       # no auth (contact form, etc.) — still validated + rate limited
│   │   ├── auth/...         # login/session endpoints
│   │   └── admin/...        # every handler calls requireAdmin() first
│   └── layout.tsx           # root layout only (html/body)
├── components/
│   ├── ui/                  # generic building blocks
│   ├── site/                # main-site-only components
│   └── admin/               # admin-only components — never import into (site)
├── lib/
│   ├── firebase/
│   │   ├── client.ts        # client SDK (browser)
│   │   └── admin.ts         # admin SDK (server only — add "server-only" import)
│   ├── auth/
│   │   ├── session.ts       # session cookie create/verify
│   │   └── guards.ts        # requireUser() / requireAdmin()
│   └── validation/          # zod schemas, shared between client forms and API
├── middleware.ts            # host routing + origin lockdown + auth gate
└── types/
```

Rules that keep the structure safe as it grows:

- Put `import "server-only";` at the top of `lib/firebase/admin.ts` and
  `lib/auth/*` — the build then **fails** if anyone accidentally imports
  server credentials into a client component, instead of leaking them.
- Every `app/api/admin/**` handler starts with the auth guard; every
  `app/admin/**` page is covered by the admin `layout.tsx` check. Two layers,
  so forgetting one is not fatal.
- Validation schemas live in `lib/validation/` and are reused on both sides —
  the client form and the API handler — so they can't drift apart.

## Two-subdomain architecture with Cloudflare

Target topology: `www.example.com` (main site) and `admin.example.com`
(back office), both DNS-proxied through Cloudflare, both landing on **one**
Cloud Run service:

```
Browser ──► Cloudflare (DNS proxy, WAF, rate limit, Access on admin.*)
                 │  + injects X-Origin-Auth secret header
                 ▼
           Cloud Run (Next.js)
                 │  middleware: checks secret, routes by Host header
                 ├─ host = www.*    → app/(site)
                 └─ host = admin.*  → rewrite to app/admin (+ session check)
```

### Host-based routing — `src/proxy.ts`

(Next 16 renamed `middleware.ts` → `proxy.ts` with the export named
`proxy`; on Next ≤15 the same code is `src/middleware.ts` exporting
`middleware`.)

```ts
import { NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  // 1. Origin lockdown: only accept traffic that came through Cloudflare.
  //    The *.run.app URL is public — without this check anyone can bypass
  //    the WAF, rate limits, and Cloudflare Access entirely.
  if (
    process.env.NODE_ENV === "production" &&
    req.headers.get("x-origin-auth") !== process.env.ORIGIN_AUTH_SECRET
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;
  const isAdminHost = host.startsWith("admin.");

  // 2. Admin subdomain serves only the admin tree
  if (isAdminHost && !pathname.startsWith("/admin") && !pathname.startsWith("/api")) {
    return NextResponse.rewrite(new URL(`/admin${pathname === "/" ? "" : pathname}`, req.url));
  }

  // 3. Admin paths must not be reachable from the main domain
  if (!isAdminHost && (pathname.startsWith("/admin") || pathname.startsWith("/api/admin"))) {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

### Cloudflare setup (order matters)

1. **DNS**: CNAME `www` and `admin` → the Cloud Run domain-mapping target
   (`ghs.googlehosted.com`). Keep records **DNS-only (grey cloud)** until the
   Google-managed cert finishes provisioning, then switch to **Proxied
   (orange cloud)**.
2. **SSL/TLS mode = Full (strict)** — anything less (Flexible) causes
   redirect loops with Cloud Run and silently downgrades security.
3. **Transform Rule** (both hostnames): set request header `X-Origin-Auth` to
   a long random secret; store the same value in Secret Manager and wire it
   to Cloud Run as `ORIGIN_AUTH_SECRET`. This is what makes the middleware
   lockdown above work.
4. **Cloudflare Access (Zero Trust)** on `admin.example.com`: require login
   with your email/IdP before a request even reaches the app. Free tier
   covers 50 users. This is defense-in-depth *in front of* Firebase Auth,
   not a replacement for it.
5. **WAF + Rate limiting rules**: enable managed ruleset; add a rate limit on
   `/api/*` (e.g. 60 req/min per IP) and a stricter one on `/api/auth/*`
   (e.g. 10 req/min) — brute-force protection at the edge costs nothing in
   your app.

For the full API security playbook (auth guards, session cookies, custom
claims, Firestore rules, validation, headers), read
[references/security.md](references/security.md) — consult it whenever
touching anything under `app/api/`, `app/admin/`, auth, or Firestore rules.

## Admin login — Google OAuth

Admin sign-in is Google OAuth via Firebase Auth: `signInWithPopup` →
POST the ID token to `/api/auth/session` → server checks the
`role === "admin"` custom claim **before** minting the session cookie.
The non-negotiable rule: OAuth proves identity, the claim grants access —
any Gmail account can complete the Google step, so a session endpoint that
skips the claim check is an open door. When building or touching the login
page, logout, or `app/api/auth/**`, read
[references/admin-oauth.md](references/admin-oauth.md) (flow, login-page
code, Firebase console setup, popup-vs-redirect reasoning, bootstrap of the
first admin, troubleshooting).

## API security baseline

Minimum bar for every route handler — details and copy-paste code in
`references/security.md`:

1. **Authenticate**: verify the Firebase **session cookie** (admin pages/API)
   or **ID token** (client fetches). Never trust a uid/role sent in the body.
2. **Authorize**: role lives in Firebase **custom claims**
   (`request.auth.token.role`), set server-side only. Check it in the guard
   AND in Firestore rules.
3. **Validate**: parse every body/query with a zod schema before touching
   Firestore. Reject unknown fields (`.strict()`).
4. **Rate limit**: primary limit at Cloudflare edge; sensitive endpoints get
   an app-level check too.
5. **Security headers**: set once in `next.config.ts` `headers()` (HSTS,
   X-Frame-Options, CSP, nosniff — template in the reference file).
6. **Secrets**: only via Secret Manager → env. Anything prefixed
   `NEXT_PUBLIC_` is public by definition — never put keys/URLs you want
   hidden there.

## Secrets & env files

Whenever creating or editing any `.env*` file, adding a secret, or reviewing
a Dockerfile/commit that touches configuration, read
[references/secrets.md](references/secrets.md) first. The short version:

- Only two env files exist: `.env.example` (committed, names only) and
  `.env.local` (gitignored, real dev values). Production values live in
  Secret Manager → Cloud Run, never in files.
- A secret that ever landed in a commit, image layer, or log is **leaked** —
  rotation is the fix, deleting the file is not.
- `.gitignore` AND `.dockerignore` must both cover `.env*` and key files —
  a secret baked into a Docker layer leaks via `docker history` even if git
  is clean.
- Run `gitleaks detect` before pushing config changes.

## AI-primary dev → deploy lifecycle

When planning a feature, setting up CI/CD, deploying staging/production, or
deciding whether an action is safe for the AI to take alone, read
[references/ai-dev-deploy.md](references/ai-dev-deploy.md). The shape of it:
two environments only (local dev → production; a two-person human+AI team
needs no staging service), but two Firebase projects (`-dev`/`-prod`) so AI
iteration is structurally unable to touch prod data. Merge to `main` passes
the CI gate (tsc, lint, build, gitleaks), then the pipeline in
[references/cicd.md](references/cicd.md) builds an image per commit, pushes
to **Artifact Registry**, and deploys a **zero-traffic candidate revision**
on the prod Cloud Run service; traffic flips only when the human approves
the GitHub `production` environment gate, and rollback is shifting traffic
back to the previous revision. Read cicd.md when touching workflows,
WIF/IAM for CI, or the registry. Per task: state the acceptance check before
writing code, build in smallest-verifiable-increments, verify up the ladder
(tsc → build → run+curl → pre-PR gate). Two rules that always hold: prod
deploys, secrets, IAM, and Cloudflare config need explicit human go-ahead
in-conversation; and when a gate fails, the fix is never to remove the gate.

## Git & pull requests (AI-authored)

`main` is always deployable; every change — including one-liners — goes
through a branch and a PR, because the PR is the human's checkpoint over
AI-written code. Before any commit, branch, or `gh pr create`, read
[references/git-pr-workflow.md](references/git-pr-workflow.md). Core rules:

- Conventional commits (`feat(admin): ...`), one branch = one concern,
  PRs under ~400 lines.
- Pre-PR gate: `tsc --noEmit` + `lint` + `build` + `gitleaks detect` +
  review `git diff main --stat` for out-of-scope edits.
- PR body must separate **verified** claims from **not-verified** ones, and
  include a security note whenever the diff touches `app/api/`, middleware,
  auth, rules, or Dockerfile.

## Design — profile/portfolio site

Before creating or restyling pages under `app/(site)/`, read
[references/design.md](references/design.md). It defines the page
architecture (hero → highlights → experience → about → contact), the token
system (one accent color, 1.25 type scale, 4px spacing grid, Thai-capable
fonts via `next/font`), the performance budget (static pages, no Firebase
client SDK on the public site, <150KB JS, LCP <2s), SEO (Metadata API,
JSON-LD Person, noindex on admin host), and the accessibility minimum.

## Content management — admin edits the public site

The admin app is a tiny private CMS: it writes profile text, projects, and
images into Firestore/Cloud Storage, and the public site renders them from
Server Components (Admin SDK + ISR — never the client SDK). When building
admin CRUD features, image upload, or wiring public pages to admin-managed
content, read
[references/content-management.md](references/content-management.md). The
rules that must survive any implementation:

- Every handler: guard → zod → write → **`revalidatePath()`** — skipping the
  last step makes the admin think saves are failing.
- Images upload through `/api/admin/upload` (UUID filenames — never the
  client's filename), URL stored in Firestore, host allowed in
  `images.remotePatterns`.
- Public queries filter `published == true`; listable content carries an
  `order` field; pages render with placeholders when docs don't exist yet.

## High traffic & scaling

The scaling model is layered absorption: Cloudflare edge cache serves 90%+
of requests, Next.js ISR serves the misses without touching Firestore, Cloud
Run autoscaling absorbs the rest, and Firestore sees almost nothing. A site
that "can't handle traffic" is almost always a caching failure at the first
two layers — never solve it by adding instances first. When preparing for
load, tuning Cloud Run (`--concurrency`/`--min-instances`/`--max-instances`/
`--cpu-boost`), setting Cloudflare cache rules, load testing (`hey`/k6), or
diagnosing latency/cost spikes, read
[references/scaling.md](references/scaling.md). Two regressions to watch in
every PR: a public page going dynamic (`force-dynamic`, `cookies()` — check
build output shows `○`/`◐` not `ƒ`), and middleware gaining async work (it
runs on every uncached request).

## README — dev onboarding + deploy runbook

When creating or updating `README.md` — and in any PR that adds an env var,
changes setup steps, or alters deploy flags — read
[references/readme-guide.md](references/readme-guide.md) and use its
template. The contract: a fresh developer runs the site locally in ~5
minutes by copy-pasting top to bottom, and the Deploy section is a numbered
runbook (deploy → verify → rollback commands), not prose. Every env var the
code reads must appear in the README table and `.env.example` in the same
commit. After editing, verify the Quick start block by actually running it
in order — a README that "looks right" but breaks on step 3 is worse than
none.

## Hallucination check — verify before you claim

This stack is version-sensitive (Next.js APIs, Firebase SDK shapes, gcloud
flags change between releases) and a confidently wrong answer costs the user
a debugging session. Treat anything recalled from memory as a hypothesis
until checked against the actual project or tool:

- **Package names/versions**: before adding a dependency, confirm it exists
  and pick the real version — `npm view <pkg> version`. Never write a
  package.json entry from memory; typosquatted names are a supply-chain
  attack vector, not just a typo.
- **Framework APIs**: check `package.json` for the installed Next.js /
  firebase / firebase-admin versions before writing version-sensitive code
  (e.g. route-handler `params` is a `Promise` in Next 15+, sync in 14;
  `cookies()` is async in 15+). If the version contradicts this skill's
  examples, the installed version wins.
- **CLI commands**: verify non-trivial `gcloud` / `firebase` invocations with
  `--help` before presenting them as fact, especially flags written from
  memory. If a command can't be verified locally, say so instead of
  asserting it works.
- **"It works" claims**: only after evidence. Minimum bar: `npx tsc --noEmit`
  or `npm run build` passes for code changes; a real `curl` for endpoint
  behavior; `gcloud run services logs read` for deploy claims. If something
  was not run, report it as "written but not verified" — never as done.
- **URLs, console paths, env var names**: cite only ones that appear in this
  skill, in the project, or that were verified this session. When unsure,
  search the official docs rather than guessing — an invented Cloudflare
  setting name sends the user hunting through dashboards for something that
  doesn't exist.
- **Uncertainty is information**: when docs and memory conflict, or the
  installed version is newer than the knowledge cutoff, state the uncertainty
  explicitly and check (WebSearch/WebFetch on official docs) instead of
  picking the more confident-sounding answer.

## Firebase: two SDKs, two worlds

Never mix these up — it is the most common source of bugs in this stack:

| | Client SDK (`firebase`) | Admin SDK (`firebase-admin`) |
|---|---|---|
| Runs in | Browser, `"use client"` components | Route handlers, Server Components, server actions |
| Auth | End-user login (Firebase Auth) | Service account / ADC, bypasses security rules |
| Config | Public `NEXT_PUBLIC_*` env vars | Credentials — never shipped to the browser |

### Client SDK — `src/lib/firebase/client.ts`

```ts
import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
```

The `getApps()` guard prevents "Firebase app already exists" errors during
hot-reload.

### Admin SDK — `src/lib/firebase/admin.ts`

```ts
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app =
  getApps()[0] ??
  initializeApp({
    credential: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
      : applicationDefault(),
  });

export const adminDb = getFirestore(app);
```

Why this shape: **on Cloud Run, do not ship a service-account JSON at all** —
attach a service account to the Cloud Run service and `applicationDefault()`
(ADC) picks it up automatically. The JSON env var path exists only for local
dev (or use `gcloud auth application-default login` locally and skip the JSON
entirely).

### Data access pattern

- Reads for page rendering → Admin SDK in Server Components (fast, no
  client-side waterfall, not limited by security rules).
- User-interactive reads/writes (live updates, forms) → Client SDK, protected
  by Firestore security rules.
- Mutations that need trust (payments, role changes) → route handler or server
  action using Admin SDK, after verifying the caller's Firebase ID token with
  `getAuth().verifyIdToken(token)`.

## Reverse proxy patterns

Pick the lightest tool that does the job — in this stack you almost never need
nginx, because Next.js itself proxies and Cloud Run/Load Balancer handle TLS.

### 1. `next.config.ts` rewrites — static proxying (default choice)

Best for: routing `/api/external/*` or `/backend/*` to another service while
keeping a single public domain (avoids CORS entirely).

```ts
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: `${process.env.BACKEND_URL}/:path*`,
      },
    ];
  },
};
```

Note: `rewrites()` is evaluated at **build time** for static values, but env
vars are read at runtime on the server — still, if `BACKEND_URL` differs per
environment, set it as a Cloud Run env var and it works.

### 2. Route handler proxy — when you need logic

Best for: injecting auth headers/API keys (keeping secrets server-side),
response transformation, rate limiting.

```ts
// src/app/api/proxy/[...path]/route.ts
import { NextRequest } from "next/server";

const TARGET = process.env.BACKEND_URL!;

async function proxy(req: NextRequest, path: string[]) {
  const url = `${TARGET}/${path.join("/")}${req.nextUrl.search}`;
  const res = await fetch(url, {
    method: req.method,
    headers: {
      "content-type": req.headers.get("content-type") ?? "application/json",
      authorization: `Bearer ${process.env.BACKEND_API_KEY}`,
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // @ts-expect-error - required by Node fetch when streaming a body
    duplex: "half",
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
```

### 3. Middleware rewrite — conditional routing

Best for: A/B routing, locale/tenant-based proxying, auth gates before the
proxy. Use `NextResponse.rewrite(new URL(...))` in `src/middleware.ts`.

### 4. Service-to-service on Cloud Run

When proxying to another **private** Cloud Run service, the proxy must attach
an identity token:

```ts
import { GoogleAuth } from "google-auth-library";
const auth = new GoogleAuth();
const client = await auth.getIdTokenClient(TARGET);
const headers = await client.getRequestHeaders(); // contains Authorization
```

Grant the caller's service account `roles/run.invoker` on the target service.

## Dockerfile (Cloud Run-ready)

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* vars are inlined at build time — pass them here if needed
# ARG NEXT_PUBLIC_FIREBASE_API_KEY
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
ENV HOSTNAME=0.0.0.0
# Cloud Run injects PORT; Next standalone server.js respects it
CMD ["node", "server.js"]
```

Add `.dockerignore`: `node_modules`, `.next`, `.git`, `.env*`.

Key facts baked into this Dockerfile:
- `standalone` output → image is ~150MB instead of >1GB.
- No `EXPOSE`/hardcoded port — `server.js` reads `PORT` from Cloud Run.
- `HOSTNAME=0.0.0.0` — without it Next binds to localhost and Cloud Run
  health checks fail with "container failed to start".
- `NEXT_PUBLIC_*` values are **frozen into the JS bundle at `npm run build`**.
  Changing them as Cloud Run env vars later does nothing — rebuild instead,
  or pass them as `--build-arg` / substitutions in Cloud Build.

## Deploy to Cloud Run

Simplest path — build remotely from source (no local Docker needed):

```bash
gcloud run deploy <service-name> \
  --source . \
  --project <project-id> \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --service-account <sa-name>@<project-id>.iam.gserviceaccount.com \
  --set-env-vars BACKEND_URL=https://... \
  --set-secrets BACKEND_API_KEY=backend-api-key:latest \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 10
```

- Region: `asia-southeast1` (Singapore) is closest for Thailand-based users.
- Secrets go in **Secret Manager** (`gcloud secrets create`), wired with
  `--set-secrets` — never in plain env vars or the image.
- The service account needs `roles/datastore.user` for Firestore access via
  ADC.
- `--min-instances 1` if cold starts hurt UX (costs a small idle fee).
- For CI/CD, connect the repo in Cloud Build triggers or use a
  `cloudbuild.yaml`; the manual command above is fine while iterating.

After deploy, verify before declaring success:

```bash
gcloud run services describe <service-name> --region asia-southeast1 --format='value(status.url)'
curl -s -o /dev/null -w "%{http_code}" <url>
gcloud run services logs read <service-name> --region asia-southeast1 --limit 50
```

## Local development

```bash
npm run dev                          # Next.js on :3000
firebase emulators:start --only firestore,auth   # optional, avoids touching prod data
```

`.env.local` (gitignored) holds `NEXT_PUBLIC_FIREBASE_*` plus server-side
vars. When using emulators, point the SDKs at them with
`connectFirestoreEmulator(db, "localhost", 8080)` guarded by
`process.env.NODE_ENV === "development"`.

## Troubleshooting quick table

| Symptom | Likely cause | Fix |
|---|---|---|
| Cloud Run: "container failed to start / listen on PORT" | Bound to localhost or wrong port | `HOSTNAME=0.0.0.0`, don't hardcode port, use standalone `server.js` |
| `NEXT_PUBLIC_*` value is `undefined` in prod | Set as runtime env var, but it's inlined at build | Pass at build time (`--build-arg` / Cloud Build substitution) and rebuild |
| Firestore `PERMISSION_DENIED` from server code | Service account missing role | Grant `roles/datastore.user` to the Cloud Run service account |
| Firestore `PERMISSION_DENIED` from browser | Security rules | Fix rules in `firestore.rules`, deploy with `firebase deploy --only firestore:rules` |
| "Firebase app already exists" in dev | Re-init on hot reload | Use the `getApps()[0] ?? initializeApp(...)` pattern |
| 403 when proxying to another Cloud Run service | Missing identity token | Use `getIdTokenClient()` + grant `roles/run.invoker` |
| Proxy POST body empty/hangs | Node fetch streaming | Add `duplex: "half"` to the fetch options |
| Slow first request after idle | Cold start | `--min-instances 1`, keep image small (standalone) |
| Infinite redirect loop via Cloudflare | SSL mode = Flexible | Set SSL/TLS mode to **Full (strict)** |
| Site works via `*.run.app` but 404 via domain (or vice versa) | Origin-lockdown header / Transform Rule mismatch | `ORIGIN_AUTH_SECRET` on Cloud Run must equal the Transform Rule value; run.app returning 404 is **correct** behavior |
| Custom-domain cert stuck "provisioning" | DNS record is proxied (orange) during provisioning | Switch to DNS-only (grey) until cert issues, then re-enable proxy |
| Admin role not taking effect after `setCustomUserClaims` | Old token cached | Client must refresh: `getIdToken(true)` or re-login |
