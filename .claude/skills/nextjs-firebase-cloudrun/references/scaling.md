# Scaling & High Traffic — cache first, autoscale second

Read this when preparing for high traffic, tuning performance under load,
running load tests, or diagnosing slowness/cost spikes in production. It
assumes the architecture from SKILL.md (Cloudflare → Cloud Run → Firestore)
and the static-first patterns from
[content-management.md](content-management.md) and
[design.md](design.md).

The strategy, in priority order — each layer absorbs traffic so the next
one never sees it:

```
1. Cloudflare edge cache   → should serve 90%+ of requests (free, ~50ms)
2. Next.js ISR/data cache  → serves the misses without touching Firestore
3. Cloud Run autoscaling   → absorbs what's left, scales 0→N in seconds
4. Firestore               → should see almost nothing (reads ≈ revalidations)
```

A profile site that "can't handle traffic" is almost always a caching
failure at layer 1–2, not a compute shortage at layer 3. Fix order matters:
adding instances to an uncached site is paying to do the same work a
million times.

## Layer 1 — Cloudflare edge cache

Static assets (`/_next/static/*`) are immutable-cached and Cloudflare
caches them by default — nothing to do. The win worth configuring is
**caching the HTML itself** at the edge:

**Cache Rule** (Cloudflare dashboard → Caching → Cache Rules), for the
`www` host only:

- `www.example.com/*` → Eligible for cache, **Edge TTL 5 minutes**,
  serve stale while revalidating.
- **Bypass cache** when a `__session` cookie is present (logged-in requests
  must never get cached HTML — and cached responses must never have been
  generated for a logged-in user).
- **Never cache** `admin.example.com/*` or `*/api/*` — add an explicit
  bypass rule above the cache rule so a future rule reorder can't expose
  them.

Why a short 5-minute TTL instead of long: `revalidatePath()` (the
content-management flow) purges **Next's** cache, not Cloudflare's. With a
5-min edge TTL, admin edits appear within 5 minutes — acceptable for a
profile site, zero extra machinery. If instant updates ever matter, call
the Cloudflare purge API in the same place as `revalidatePath()`
(`POST /zones/{zone}/purge_cache` with the page URLs) — add that only when
the 5-minute lag actually bothers someone.

Target to verify, not assume: **cache hit ratio > 90%** on the `www` host
(Cloudflare dashboard → Analytics → Cache). If it's low, check
`cf-cache-status` response headers (`HIT`/`MISS`/`BYPASS`/`DYNAMIC`) —
`DYNAMIC` on HTML means the cache rule isn't matching;
unnecessary cookies on the public site are the usual culprit.

## Layer 2 — Next.js rendering & data cache

Already mandated elsewhere, restated here because it's what makes layer 3
cheap:

- Public pages are ISR (`export const revalidate = 3600`) — under load,
  Firestore reads stay constant (~1 per page per hour) no matter the RPS.
- No `firebase` client SDK on the public site; no
  `export const dynamic = "force-dynamic"` on public pages. A single
  accidental `force-dynamic` (or reading `cookies()`/`headers()` in a
  public page) silently turns every request into a full render +
  Firestore round trips — this is the #1 way the architecture degrades.
  Check `npm run build` output: public routes must show as static/ISR
  (`○`/`◐`), not dynamic (`ƒ`).
- Middleware runs on **every** uncached request — keep it to header checks
  and rewrites only. No fetches, no Firestore, no async work in middleware.

## Layer 3 — Cloud Run autoscaling

Settings that matter, with reasoning:

```bash
gcloud run services update <service-name> --region asia-southeast1 \
  --concurrency 80 \
  --cpu 1 --memory 512Mi \
  --min-instances 1 \
  --max-instances 20 \
  --cpu-boost
```

- **`--concurrency 80`** (default): Next.js standalone handles concurrent
  requests on one instance fine because ISR responses are I/O-light. Don't
  drop it to 1–10 "to be safe" — that multiplies instance count (and cost)
  by 8–80x and makes cold starts the common case.
- **`--min-instances 1`**: under a traffic spike, scaling 1→10 is fast;
  0→1 puts a multi-second cold start in front of the first users. The idle
  cost of one small instance is the price of surviving the first second of
  a spike.
- **`--max-instances 20`**: the billing circuit breaker. Size it from load
  test results (instances observed at target RPS × 3), not optimism. If a
  flood exceeds it, requests queue/shed at the edge — which is the correct
  failure mode; an unbounded bill is not.
- **`--cpu-boost`**: extra CPU during container startup roughly halves
  Next.js cold start time. No downside.
- Keep the image small (standalone build, per the Dockerfile section) —
  image size is a direct term in cold start latency.

## Layer 4 — Firestore

With ISR doing its job, the public site barely touches Firestore. The
remaining rules:

- Firestore reads scale horizontally — the risk is **cost**, not capacity.
  A budget alert (below) catches a caching regression faster than staring
  at dashboards.
- Avoid hot-document writes: a single doc sustains ~1 write/sec. A naive
  "view counter" `increment()` on `site/profile` will fail under exactly
  the traffic you're preparing for. Don't build counters/analytics in
  Firestore — Cloudflare Analytics already counts traffic for free.
- Batch admin-side multi-doc updates (`adminDb.batch()`) — atomic and
  fewer round trips.

## Load testing — verify before the real spike

Never claim "handles high traffic" without numbers. Two cheap tools:

```bash
# quick origin test (bypasses Cloudflare to test YOUR stack)
hey -z 60s -c 100 https://<service>.run.app/   # note: needs origin-lockdown
                                               # temporarily off, or test the
                                               # staging service instead

# realistic test (through Cloudflare — what users experience)
hey -z 60s -c 200 https://www.example.com/
```

(`brew install hey`; for scripted multi-step scenarios use k6 instead.)

Read the results against these acceptance bars:

- p95 latency < 500ms through Cloudflare, < 1s at origin
- error rate ~0% (a few 429s from your own rate limits are fine — that's
  rate limiting working; mind the limits from security.md §7 when choosing
  test concurrency, or test from an allowlisted IP)
- During the origin test, watch instances:
  `gcloud run services describe <name> --region asia-southeast1` and the
  metrics page — instance count at target RPS calibrates `--max-instances`.
- Through-Cloudflare test should show `cf-cache-status: HIT` on the
  overwhelming majority — if origin instance count climbs during this
  test, the edge cache isn't absorbing (fix layer 1 before touching
  layer 3).

Re-run the through-Cloudflare test after any change to caching config,
middleware, or `next.config.ts` — those are the files that break the
cache silently.

## Monitoring & guardrails (set once)

- **Uptime check + alert**: Cloud Monitoring uptime check on
  `https://www.example.com` (60s interval), alerting policy on failure and
  on 5xx ratio > 1%.
- **Billing budget alert** on the GCP project (e.g. alert at 50%/90% of a
  monthly budget) — the fastest detector of a caching regression or abuse
  that slipped past rate limits.
- **Cloudflare analytics weekly glance**: cache hit ratio, top paths,
  threats blocked. Hit ratio dropping is the early warning.
- Logs are structured by default on Cloud Run — when debugging load
  issues, filter `severity>=WARNING` plus latency on the request log
  rather than tailing everything.

## Failure-mode quick table

| Symptom under load | Likely layer | Fix |
|---|---|---|
| Latency fine then sudden spike, instances climbing | Edge cache stopped hitting | Check `cf-cache-status`, cookie leakage on www, cache rule match |
| Every request slow, instances high, Firestore reads high | A public page went dynamic | Find `force-dynamic`/`cookies()` usage; check build output symbols |
| First requests after idle are slow | Cold starts | `--min-instances 1`, `--cpu-boost`, smaller image |
| 429s for real users | Own rate limits too tight for cached-miss bursts | Raise Cloudflare rate-limit thresholds for `www` HTML, keep strict on `/api/auth` |
| 500s only at high concurrency | Per-instance resource exhaustion | Raise memory to 1Gi or lower concurrency to ~40, re-test |
| Firestore bill spike, traffic flat | ISR regression or counter writes | Build output check; remove hot-doc writes |
| Requests shed at peak | `--max-instances` ceiling | Raise it consciously (cost) or accept shedding (correct under attack) |
