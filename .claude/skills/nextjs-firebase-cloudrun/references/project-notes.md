# Project Notes — verified facts from building this site

Knowledge captured while actually building websiteprofile (June 2026).
Everything here was **verified against the real project**, not recalled —
when this file and another reference disagree, this file is newer; when the
installed version disagrees with this file, the installed version wins
(re-verify, then update here).

## Next.js 16 facts (verified on 16.2.9, from node_modules)

- **`middleware.ts` is renamed `proxy.ts`** — this project uses
  `src/proxy.ts` exporting a function named `proxy` (default export also
  works). Verified in `next/dist/esm/build/templates/middleware.js`:
  `(isProxy ? mod.proxy : mod.middleware) || mod.default`. Build output
  lists it as `ƒ Proxy (Middleware)`. Older references in this skill that
  say `src/middleware.ts` mean `src/proxy.ts` on Next 16.
- **Only ONE `next dev` per project dir.** Next 16 takes a lock; a second
  `next dev` exits with "Another next dev server is already running" and
  the owner PID. If the human has a dev server up, do NOT kill it — verify
  with `next build` + `next start` on a different port instead.
- `create-next-app@latest` scaffolds Next 16 with Turbopack; it
  **refuses a non-empty directory** (even one with just `.claude/`).
  Workaround used here: scaffold into a subdir, then
  `cp -R web/. . && rm -rf web` (cp -R `dir/.` copies dotfiles too).
- The scaffold leaves a prebuilt `.next/` whose generated types reference
  the default `src/app/page.tsx`. After deleting/moving scaffold pages,
  `tsc --noEmit` fails on `.next/types/validator.ts` — fix is
  `rm -rf .next`, not editing anything.
- Verified version-sensitive APIs (same as Next 15): route-handler
  `params` is a Promise, `cookies()` is async.

## Verification gotchas (these almost caused wrong reports)

- **Background `next start` from a previous Bash call keeps serving the
  OLD build from memory.** Each Bash tool call is a new shell, so `kill %1`
  does nothing. Kill by port before every verify run:
  `lsof -ti :3100 | xargs kill -9`. Symptom of getting this wrong: grep
  finds stale content and you "verify" the previous build.
- `next start` runs with `NODE_ENV=production`, so the origin lockdown in
  `src/proxy.ts` is ACTIVE locally — curl needs
  `-H "X-Origin-Auth: $ORIGIN_AUTH_SECRET"` (start the server with that
  env var set). A bare curl returning 404 is lockdown working, not a bug.
  This doubles as a free lockdown test: assert 404 without header, 200
  with.
- Chaining `build && nohup start & sleep && curl` in one Bash line
  backgrounds more than intended and curls before the server is up —
  run them as separate statements with an explicit `sleep`.
- `next/font` (Google Fonts) downloads at build time — builds need network.

## Project conventions (state as of June 2026)

- **Content lives in `src/content/profile.ts`** — typed, flat, serializable
  on purpose: the shape maps 1:1 to the future Firestore docs
  (`site/profile`, `experience/*` per content-management.md). All copy
  edits happen there, never in components. The owner also edits this file
  directly between sessions — **read it before editing; don't assume it
  matches what you last wrote.**
- **Theme**: dark is default (`:root` tokens), light is opt-in via
  `[data-theme="light"]` + header toggle (`src/components/site/ThemeToggle.tsx`,
  leaf client component). An inline boot script (first child of `<body>` in
  `src/app/layout.tsx`) applies the saved theme before first paint;
  `<html suppressHydrationWarning>` is required for it. System
  `prefers-color-scheme` is deliberately NOT used — owner wants dark-first.
- **Layout**: 72rem container; every non-hero section is a 2-column grid
  (`.section-head` sticky left, `.section-body` right), stacking under
  768px. Skills render as a card grid (`.skill-groups`). All tokens in
  `globals.css` `:root` — no ad-hoc values in components.
- **All pages must stay static** — check `npm run build` output for `○`
  on every public route after any change (regression guard from
  scaling.md).
- Owner profile facts: BDI start Oct 2025; contact email is the personal
  Gmail (not the bdi.or.th address); GitHub `nutthapong224`; Azure
  intentionally removed from skills.
- `.claude/launch.json` exists for the preview tool (`autoPort: true`,
  because the owner usually occupies :3000 with their own dev server).

## CI/CD state

- Workflows exist and are YAML-validated but **never executed** — no
  GitHub remote yet. First real run will be the actual test.
- `deploy.yml` reads ALL config from GitHub repo Variables and the
  build-candidate job has `if: vars.WIF_PROVIDER != ''` — the pipeline is
  intentionally inert until GCP setup (README "One-time setup") is done.
  Don't "fix" a skipped deploy job by removing that condition.
- The very first Cloud Run deploy must be manual (`--source .`) — CI tags
  candidates on an existing service.
- gcloud commands in README/cicd.md are unverified against a live project;
  verify `gcloud beta run domain-mappings` flags with `--help` before the
  first real run.

## TLS / domain decision (June 2026)

The owner uses a **Cloudflare Origin Certificate**, so the production path
is Cloudflare → **GCP HTTPS Load Balancer** (Origin CA cert, serverless
NEG) → Cloud Run — NOT Cloud Run domain mappings / Google-managed certs.
Consequences:

- DNS is an A record to the LB's static IP, proxied (orange) from day one.
- Cloud Run ingress stays **"all"** on purpose: the CI smoke test hits the
  candidate tag's `*.run.app` URL with the `X-Origin-Auth` header.
  Switching ingress to internal+LB would break that smoke test — don't
  "harden" it without redesigning the pipeline.
- The Origin CA private key is a secret: uploaded once via
  `gcloud compute ssl-certificates create`, local files deleted, never
  committed.
- Runbook commands live in README "One-time setup §3"; LB commands are
  written-but-not-run (no GCP project yet) — verify with `--help` on
  first real use.

## Not done yet (don't assume these exist)

GitHub remote · GCP project(s) · Firebase projects (`-dev`/`-prod`) ·
admin app / OAuth / CMS (content is file-based) · Cloudflare zone /
custom domain · `production` GitHub environment. The README runbook and
this skill describe the plan; only the local site, git history, and
workflow files are real so far.
