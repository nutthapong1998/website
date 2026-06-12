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

## TLS / domain / cost decision (June 2026)

**Chosen: domain mapping (free TLS) + `min-instances 1`.** Cloud Run
**domain mapping + Google-managed cert** — no load balancer. The owner
first picked `min-instances 0` (~฿0/mo), then explicitly bumped to
**`min-instances 1`** (~$5–10/mo) to avoid cold starts. Request volume
fits the free tier either way.

- A **Cloudflare Origin Certificate + GCP HTTPS LB** design was fully
  specced first and then **rejected**: the LB alone costs ~$18–25/mo,
  unjustifiable for this site. The owner has an Origin cert generated
  (15-year validity) — reusable if an LB/VM project ever appears, but do
  NOT resurrect the LB design here without a new cost conversation.
- `min-instances 1` matches scaling.md's generic advice (absorbs the
  first second of a spike, no cold starts); the cost was accepted
  knowingly after seeing the ~$5–10/mo figure.
- DNS one-time dance: CNAME → `ghs.googlehosted.com`, grey-cloud until the
  managed cert provisions (~15 min), then orange. SSL Full (strict).
- Cloud Run ingress stays **"all"**: the CI smoke test hits the candidate
  tag's `*.run.app` URL with the `X-Origin-Auth` header. Don't "harden"
  ingress without redesigning the pipeline.
- gcloud commands in the README are written-but-not-run (no GCP project
  yet) — verify `gcloud beta run domain-mappings` flags with `--help` on
  first real use.

## Not done yet (don't assume these exist)

GitHub remote · GCP project(s) · Firebase projects (`-dev`/`-prod`) ·
admin app / OAuth / CMS (content is file-based) · Cloudflare zone /
custom domain · `production` GitHub environment. The README runbook and
this skill describe the plan; only the local site, git history, and
workflow files are real so far.
