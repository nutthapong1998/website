# websiteprofile

Personal profile website of Nutthapong Kanna (Cloud Engineer, Big Data
Institute). Production URL: not deployed yet.

**Stack**: Next.js 16 (App Router) · Cloud Run · Artifact Registry ·
Cloudflare · GitHub Actions — Firebase (Firestore/Auth) and the admin CMS
are planned, not wired up yet; content currently lives in
[src/content/profile.ts](src/content/profile.ts).

| Environment | URL |
|---|---|
| Production | (pending — Cloud Run + Cloudflare) |
| Local | http://localhost:3000 |

## Quick start

Prerequisites: Node ≥ 20 (`node -v`).

```bash
git clone <repo-url> && cd websiteprofile
npm ci
cp .env.example .env.local   # defaults are fine for local dev
npm run dev                  # → http://localhost:3000
```

## Environment variables

| Variable | Where used | Example / how to get it |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | metadata, sitemap, robots | `https://www.example.com` — leave empty locally (falls back to localhost) |
| `ORIGIN_AUTH_SECRET` | proxy (origin lockdown) | Production only; must equal the Cloudflare Transform Rule header value. Generate: `openssl rand -base64 32` |

Local: values go in `.env.local` (never committed).
Production: secrets via Secret Manager (`--set-secrets`), plain values via `--set-env-vars` / build args.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm run build` | production build — run before every PR |
| `npm run lint` / `npx tsc --noEmit` | lint / typecheck |

## Project structure

```
src/app/(site)/      main website (hero, skills, experience, about, contact)
src/app/             root layout, robots, sitemap
src/content/         site content (moves to Firestore when the admin CMS lands)
src/proxy.ts         origin lockdown + host routing (www vs admin subdomain)
.github/workflows/   CI gate (PR) + deploy pipeline (main)
```

## Editing content

Until the admin CMS exists, edit
[src/content/profile.ts](src/content/profile.ts) — name, tagline, skills,
experience, links.

---

## Deploy architecture

TLS between Cloudflare and GCP uses a **Cloudflare Origin Certificate**.
Cloud Run cannot hold a custom cert, so a global HTTPS Load Balancer
terminates it and fronts the service (~$18–25/month for the LB):

```
Browser ──► Cloudflare (DNS proxy, SSL Full-strict, WAF, rate limit)
                │  injects X-Origin-Auth secret header
                ▼
          GCP HTTPS Load Balancer (Cloudflare Origin CA cert)
                │  serverless NEG
                ▼
          Cloud Run "websiteprofile" (asia-southeast1)
                │  proxy.ts: rejects requests without the header (404)
                ▼
          Next.js standalone (static pages)

CI/CD:  PR → CI gate → merge main
          → GitHub Actions builds image :<sha> → Artifact Registry
          → zero-traffic candidate revision on Cloud Run → smoke test
          → human approves ("production" environment) → traffic flips
```

Direct `*.run.app` access always returns **404** — that is the origin
lockdown working, not a bug. Real traffic must come through Cloudflare.
The Origin CA cert is trusted **only by Cloudflare**, not by browsers —
the site must always be reached through the proxied domain, never the LB
IP directly (that's fine: requests to the bare LB also lack the
`X-Origin-Auth` header and get 404).

## One-time setup

Do these once, in order. Replace `<project-id>`, `<owner>/<repo>`, and the
domain before running.

### 1. GCP

```bash
PROJECT=<project-id>; REGION=asia-southeast1

# Artifact Registry repo for images
gcloud artifacts repositories create web \
  --project $PROJECT --location $REGION --repository-format docker

# Runtime service account (what Cloud Run runs as)
gcloud iam service-accounts create websiteprofile-runtime --project $PROJECT

# Origin-lockdown secret (same value goes into Cloudflare later — keep it)
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create origin-auth-secret \
  --project $PROJECT --data-file=-
gcloud secrets add-iam-policy-binding origin-auth-secret --project $PROJECT \
  --member serviceAccount:websiteprofile-runtime@$PROJECT.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor

# Deployer service account (what GitHub Actions runs as)
gcloud iam service-accounts create deployer --project $PROJECT
DEPLOYER=deployer@$PROJECT.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$DEPLOYER --role roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$DEPLOYER --role roles/run.admin
gcloud iam service-accounts add-iam-policy-binding \
  websiteprofile-runtime@$PROJECT.iam.gserviceaccount.com \
  --member serviceAccount:$DEPLOYER --role roles/iam.serviceAccountUser
gcloud secrets add-iam-policy-binding origin-auth-secret --project $PROJECT \
  --member serviceAccount:$DEPLOYER --role roles/secretmanager.secretAccessor

# Workload Identity Federation — keyless auth for GitHub Actions
gcloud iam workload-identity-pools create github --project $PROJECT --location global
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project $PROJECT --location global --workload-identity-pool github \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository == '<owner>/<repo>'"
PROJECT_NUM=$(gcloud projects describe $PROJECT --format 'value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUM/locations/global/workloadIdentityPools/github/attribute.repository/<owner>/<repo>"
```

### 2. GitHub

1. Push the repo: `gh repo create websiteprofile --private --source . --push`
2. Settings → Environments → create **`production`** → add yourself as
   **required reviewer** (this is the deploy approval gate).
3. Settings → Branches → protect `main`: require the CI check + 1 review.
4. Settings → Secrets and variables → Actions → **Variables** — set:

| Variable | Value |
|---|---|
| `GCP_PROJECT` | `<project-id>` |
| `GCP_REGION` | `asia-southeast1` |
| `SERVICE` | `websiteprofile` |
| `AR_IMAGE` | `asia-southeast1-docker.pkg.dev/<project-id>/web/site` |
| `WIF_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/github/providers/github-provider` |
| `DEPLOYER_SA` | `deployer@<project-id>.iam.gserviceaccount.com` |
| `SITE_URL` | `https://www.<domain>` (set after step 4) |

The deploy workflow stays skipped until `WIF_PROVIDER` is set, so steps can
be done in any order without red ✗ runs.

### 3. First deploy + Load Balancer with the Cloudflare Origin cert

The very first deploy is manual (CI needs an existing service to tag
candidates on):

```bash
gcloud run deploy websiteprofile \
  --source . \
  --project $PROJECT --region $REGION \
  --allow-unauthenticated \
  --service-account websiteprofile-runtime@$PROJECT.iam.gserviceaccount.com \
  --set-secrets ORIGIN_AUTH_SECRET=origin-auth-secret:latest \
  --memory 512Mi --cpu 1 --min-instances 1 --max-instances 10 --cpu-boost
```

Create the Origin Certificate in Cloudflare: **SSL/TLS → Origin Server →
Create Certificate** (hostnames `<domain>`, `*.<domain>`; 15-year validity
is fine). Save the certificate and private key to temp files, then:

```bash
# upload the cert to GCP, then DELETE the local key file — it's a secret
gcloud compute ssl-certificates create cf-origin \
  --project $PROJECT --certificate origin.pem --private-key origin-key.pem
shred -u origin-key.pem origin.pem 2>/dev/null || rm -P origin-key.pem origin.pem

# serverless NEG → backend → URL map → HTTPS proxy → static IP → forwarding rule
gcloud compute network-endpoint-groups create websiteprofile-neg \
  --project $PROJECT --region $REGION \
  --network-endpoint-type serverless --cloud-run-service websiteprofile
gcloud compute backend-services create websiteprofile-backend \
  --project $PROJECT --global --load-balancing-scheme EXTERNAL_MANAGED
gcloud compute backend-services add-backend websiteprofile-backend \
  --project $PROJECT --global \
  --network-endpoint-group websiteprofile-neg \
  --network-endpoint-group-region $REGION
gcloud compute url-maps create websiteprofile-lb \
  --project $PROJECT --default-service websiteprofile-backend
gcloud compute target-https-proxies create websiteprofile-https-proxy \
  --project $PROJECT --url-map websiteprofile-lb --ssl-certificates cf-origin
gcloud compute addresses create websiteprofile-ip --project $PROJECT --global
gcloud compute forwarding-rules create websiteprofile-fr \
  --project $PROJECT --global --load-balancing-scheme EXTERNAL_MANAGED \
  --address websiteprofile-ip --target-https-proxy websiteprofile-https-proxy \
  --ports 443

# the IP for the Cloudflare DNS record:
gcloud compute addresses describe websiteprofile-ip --project $PROJECT \
  --global --format 'value(address)'
```

### 4. Cloudflare (order matters)

1. **DNS**: **A record** `www` → the LB IP from above, **Proxied (orange
   cloud) from the start** — no grey-cloud waiting; the Origin cert is
   already on the LB.
2. **SSL/TLS → Full (strict)** — Cloudflare trusts its own Origin CA, so
   strict works immediately. Anything less causes redirect loops.
3. **Rules → Transform Rules → Modify Request Header**: on hostname
   `www.<domain>`, set header `X-Origin-Auth` = the value of
   `origin-auth-secret` (read it:
   `gcloud secrets versions access latest --secret origin-auth-secret`).
   Without this rule every request gets 404 from the origin lockdown.
4. **Security → WAF**: enable managed ruleset; add rate limiting
   (e.g. `/api/*` 60 req/min per IP). **Bot Fight Mode** on.
5. **Caching → Cache Rules**: cache `www.<domain>/*` with Edge TTL 5 min,
   bypass when a `__session` cookie is present; never cache `/api/*`.
6. Set the `SITE_URL` GitHub variable and redeploy so metadata/sitemap use
   the real domain.

## CI/CD — everyday deploys

After setup, shipping a change is:

1. Branch → PR. **CI** runs typecheck, lint, build, gitleaks — must pass.
2. Merge to `main`. **Deploy** workflow builds the image, pushes to
   Artifact Registry, deploys a **zero-traffic candidate** revision, and
   smoke-tests it. Users still see the old version.
3. GitHub → Actions → the waiting **release** job → **Review deployments**
   → approve. Traffic flips to the new revision and the workflow verifies
   the live site (200 via Cloudflare, 404 direct to run.app).

Nothing reaches users without the approval click in step 3.

## Verify & rollback

```bash
# what is live right now
gcloud run services describe websiteprofile --project $PROJECT --region $REGION \
  --format 'value(status.traffic.list(format="{0}={1}%".format(revisionName,percent)))'

# verify
curl -s -o /dev/null -w "%{http_code}\n" https://www.<domain>     # expect 200
curl -s -o /dev/null -w "%{http_code}\n" \
  $(gcloud run services describe websiteprofile --project $PROJECT --region $REGION \
    --format 'value(status.url)')                                  # expect 404 (lockdown)

# rollback — instant, no rebuild
gcloud run revisions list --service websiteprofile --project $PROJECT --region $REGION
gcloud run services update-traffic websiteprofile \
  --project $PROJECT --region $REGION --to-revisions <previous-revision>=100
```

A bad candidate that was never approved needs nothing — it never had
traffic; just merge the fix.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pages show as `ƒ` (dynamic) in build output | Public pages must stay static — find and remove `force-dynamic` / `cookies()` usage |
| `*.run.app` URL returns 404 | Expected — origin lockdown. Real traffic comes via Cloudflare with the `X-Origin-Auth` header |
| Site 404s through the domain too | Cloudflare Transform Rule header value ≠ `origin-auth-secret` — make them match, redeploy |
| Infinite redirect loop via Cloudflare | SSL/TLS mode must be **Full (strict)**, not Flexible |
| Cloudflare error **526** (invalid SSL cert) | LB is not serving the Origin cert — check `gcloud compute ssl-certificates list` and the target-https-proxy binding |
| Cloudflare error **525** (handshake failed) | DNS A record points to the wrong IP, or the forwarding rule isn't on :443 |
| Google-branded 404 from the domain | LB routing broken (NEG/url-map), traffic never reached Cloud Run — `gcloud compute backend-services describe websiteprofile-backend --global` |
| Deploy job skipped on push to main | `WIF_PROVIDER` variable not set yet — intended until GCP setup is done |
| `auth@v2` fails in Actions | WIF `attribute-condition` must equal `'<owner>/<repo>'` exactly |
| Release ran without approval | `production` environment is missing required reviewers |
| Fonts fail to load during build | `next/font` fetches Google Fonts at build time — needs network access |
