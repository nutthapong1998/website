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
- **Region is `asia-southeast1` (Singapore) — forced by GCP.** The owner
  first deployed to `asia-southeast3`, but the domain-mapping API returned
  501 "Creating domain mappings is not allowed in asia-southeast3"
  (verified live, June 2026). Domain mappings only work in a subset of
  regions; asia-southeast1 is in it. Don't move the service to another
  region without checking this constraint first. The old asia-southeast3
  service must be deleted to avoid double min-instances cost.
- Cloud Run ingress stays **"all"**: the CI smoke test hits the candidate
  tag's `*.run.app` URL with the `X-Origin-Auth` header. Don't "harden"
  ingress without redesigning the pipeline.
- gcloud commands in the README are written-but-not-run (no GCP project
  yet) — verify `gcloud beta run domain-mappings` flags with `--help` on
  first real use.

## LIVE since June 13, 2026 — launch facts (all verified)

https://www.nutthapongkanna.com is in production: HTTP 200 via
Cloudflare (`server: cloudflare`, SIN edge), security headers served,
origin lockdown confirmed (direct run.app → 404). Verified by curl from
outside, not assumed. Facts learned during the actual launch:

- **Cert provisioning took ~15 min** once (a) the domain mapping existed
  AND (b) the CNAME was grey-cloud. Fastest check is
  `curl -s -o /dev/null -w '%{http_code}' https://<domain>` — `000` means
  cert not issued (TLS handshake fails), any real code means issued.
  A background poll loop on this works well as a "cert ready" notifier.
- **Cloudflare Transform Rule warns "This rule may not apply to your
  traffic" when the record is grey-cloud** — correct answer is "Ignore
  and deploy rule anyway". NEVER pick "Create a new proxied DNS record":
  it flips orange early and blocks cert issuance. The rule sits dormant
  and activates when the cloud goes orange.
- **Managed Transforms ≠ Transform Rules.** The toggle page
  (Rules → Settings) cannot set custom headers; the custom rule lives at
  Rules → Overview → Create rule → Request Header Transform Rule. The
  owner got lost there once — point precisely.
- Right after launch, domain (grey) returning 404 is CORRECT: traffic
  reaches Cloud Run without the header, lockdown fires. 404-before-orange
  + 200-after-orange is the expected sequence.

## Known gaps

1. ~~Metadata/sitemap localhost~~ **FIXED & verified in prod** — code
   fallback is now the real domain (`||`, commit 73b3fe8); live
   sitemap/robots/og:url all show https://www.nutthapongkanna.com.
2. ~~cf-cache-status DYNAMIC~~ **FIXED & verified** — Cache Rule active:
   hostname match + `not http.cookie contains "__session"`, Edge TTL
   **2 minutes** with "Ignore cache-control header" (the respect-header
   options keep HTML DYNAMIC because of Next's cache-control). Verified
   MISS→HIT, 0.38s→0.058s. Note: free plan's TTL dropdown does offer
   2 minutes.
3. **CI/CD still dormant** — GitHub Variables (incl. `WIF_PROVIDER`) and
   the `production` environment not set; deploys are manual gcloud runs.
   WIF/AR/deployer-SA setup from cicd.md not yet executed. Cloudflare
   purge step is NOT needed in the release job (2-min TTL self-heals).

Also live-verified: Cloudflare auto-injects "Managed content" into
robots.txt that blocks AI crawlers (GPTBot, ClaudeBot, CCBot, …) and
signals `ai-train=no`. For a personal-profile site the owner may prefer
AI visibility — toggle lives in Cloudflare AI Crawl Control. Owner aware,
undecided.

## Not done yet (don't assume these exist)

Firebase projects (`-dev`/`-prod`) · admin app / OAuth / CMS (content is
file-based in `src/content/profile.ts`) · the CI/CD GCP plumbing in gap
3 above. GitHub remote (`nutthapong1998/website`), GCP project, Cloud Run
service (asia-southeast1), domain mapping, and Cloudflare zone are all
real and live.
