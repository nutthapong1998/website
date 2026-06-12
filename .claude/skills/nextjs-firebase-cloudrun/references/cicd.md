# CI/CD — GitHub Actions → Artifact Registry → Cloud Run

Read this when setting up or modifying the deployment pipeline, the GitHub
Actions workflows, Artifact Registry, or when deploys misbehave. The
environment model (local dev → production, no staging — a two-person
human+AI team) is defined in [ai-dev-deploy.md](ai-dev-deploy.md); this
file is the concrete pipeline that implements it.

Why image-based deploys through Artifact Registry instead of
`gcloud run deploy --source .` (which is fine for hand-iteration):

- **Immutable, addressable releases**: every deploy is `image:<git-sha>` —
  "what is running?" and "what do we roll back to?" become exact answers.
- **Rollback = shift traffic to an old revision** — a 10-second operation,
  independent of git state, works even when `main` is broken.
- **Faster, cacheable builds** in CI (BuildKit layer cache) instead of a
  fresh Cloud Build per deploy.

## Topology — no staging, but never blind

Without a staging service, the safety net is Cloud Run's own revision
mechanics: every merge deploys a **candidate revision that receives zero
production traffic**, CI smoke-tests it, and only a human approval flips
traffic to it.

```
PR → CI gate (tsc, lint, build, gitleaks)
merge to main
  → build image :<sha> → push Artifact Registry (prod project)
  → deploy to prod service with --no-traffic --tag candidate   (users see nothing)
  → CI smoke test against the candidate tag URL
  → [GitHub approval gate — the human]
  → update-traffic to the new revision                          (users see it)
```

This preserves the two human checkpoints from ai-dev-deploy.md (PR review,
production promotion) with one service and one workflow. The Firebase
`-dev` project still exists — it's what local development talks to — it
just has no Cloud Run service.

## One-time GCP setup

```bash
PROD=<project-prod>; REGION=asia-southeast1

# 1. Artifact Registry repo
gcloud artifacts repositories create web \
  --project $PROD --location $REGION --repository-format docker

# 2. Deployer service account for CI
gcloud iam service-accounts create deployer --project $PROD
DEPLOYER=deployer@$PROD.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROD --member serviceAccount:$DEPLOYER --role roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $PROD --member serviceAccount:$DEPLOYER --role roles/run.admin
gcloud iam service-accounts add-iam-policy-binding <runtime-sa>@$PROD.iam.gserviceaccount.com \
  --member serviceAccount:$DEPLOYER --role roles/iam.serviceAccountUser
# smoke test needs the origin-lockdown secret to get past middleware
gcloud secrets add-iam-policy-binding origin-auth-secret \
  --project $PROD --member serviceAccount:$DEPLOYER --role roles/secretmanager.secretAccessor

# 3. Workload Identity Federation (keyless auth for GitHub Actions)
gcloud iam workload-identity-pools create github --project $PROD --location global
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project $PROD --location global --workload-identity-pool github \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository == '<owner>/<repo>'"
PROD_NUM=$(gcloud projects describe $PROD --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROD_NUM/locations/global/workloadIdentityPools/github/attribute.repository/<owner>/<repo>"
```

The `attribute-condition` pinning the exact repo is load-bearing: without
it, any GitHub repo could mint tokens against the pool. Store the provider
resource name and `$DEPLOYER` as GitHub repo **variables**
(`WIF_PROVIDER`, `DEPLOYER_SA`) — they are identifiers, not secrets.

In GitHub → Settings → Environments, create `production` with **required
reviewers** (you). That approval click is the promotion gate — enforced by
the platform, not by discipline.

## The workflow

One file: build → candidate deploy → smoke test run automatically on
merge; the traffic flip waits for your approval.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on: { push: { branches: [main] } }

env:
  REGION: asia-southeast1
  PROJECT: <project-prod>
  SERVICE: <name>
  IMAGE: asia-southeast1-docker.pkg.dev/<project-prod>/web/site

jobs:
  build-candidate:
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.DEPLOYER_SA }}
      - uses: google-github-actions/setup-gcloud@v2
      - run: gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
      - uses: docker/setup-buildx-action@v3

      - name: Build & push
        run: |
          docker buildx build --push -t $IMAGE:${{ github.sha }} \
            --cache-from type=registry,ref=$IMAGE:buildcache \
            --cache-to   type=registry,ref=$IMAGE:buildcache,mode=max \
            --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=${{ vars.FB_API_KEY }} \
            --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=${{ vars.FB_PROJECT_ID }} \
            .

      - name: Deploy candidate (zero traffic)
        run: |
          gcloud run deploy $SERVICE \
            --project $PROJECT --region $REGION \
            --image $IMAGE:${{ github.sha }} \
            --no-traffic --tag candidate --quiet

      - name: Smoke test candidate
        run: |
          URL=$(gcloud run services describe $SERVICE --project $PROJECT --region $REGION \
            --format 'value(status.traffic.url)' | tr ';' '\n' | grep candidate)
          AUTH=$(gcloud secrets versions access latest --secret origin-auth-secret --project $PROJECT)
          code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Origin-Auth: $AUTH" "$URL")
          [ "$code" = "200" ] || { echo "candidate smoke test failed: $code"; exit 1; }

  release:
    needs: build-candidate
    runs-on: ubuntu-latest
    environment: production        # ← waits here for your approval
    permissions: { contents: read, id-token: write }
    steps:
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.DEPLOYER_SA }}
      - uses: google-github-actions/setup-gcloud@v2

      - name: Shift traffic to candidate
        run: |
          gcloud run services update-traffic $SERVICE \
            --project $PROJECT --region $REGION --to-latest --quiet

      - name: Verify live
        run: |
          code=$(curl -s -o /dev/null -w '%{http_code}' https://www.example.com)
          [ "$code" = "200" ] || { echo "prod verify failed: $code — roll back"; exit 1; }
          lock=$(curl -s -o /dev/null -w '%{http_code}' \
            $(gcloud run services describe $SERVICE --project $PROJECT --region $REGION --format 'value(status.url)'))
          [ "$lock" = "404" ] || { echo "origin lockdown broken: $lock"; exit 1; }
```

Notes:

- The `NEXT_PUBLIC_*` build-args require matching `ARG`/`ENV` lines in the
  Dockerfile's builder stage. They're GitHub repo **variables**, not
  secrets — public by definition. Local dev uses `.env.local` with the
  `-dev` Firebase project instead.
- Smoke test passes the `X-Origin-Auth` header because the middleware's
  origin lockdown (correctly) 404s anything that didn't come through
  Cloudflare. To eyeball the candidate in a browser before approving, hit
  the candidate URL with that header via curl, or rely on the smoke test +
  your local verification — that's the trade made by skipping staging.
- Want to inspect before approving? The candidate revision stays deployed
  and traffic-less while the `release` job waits — there is no time
  pressure on the approval.

## Rollback

Traffic-based, instant, no rebuild:

```bash
gcloud run revisions list --service $SERVICE --project $PROJECT --region $REGION
gcloud run services update-traffic $SERVICE \
  --project $PROJECT --region $REGION --to-revisions <previous-revision>=100
```

A bad candidate that never got approved needs nothing at all — it never
had traffic. Just merge the fix; the next candidate supersedes it.

## Registry hygiene

Untended registries grow forever (cost + noise). Set a cleanup policy once:

```bash
cat > /tmp/ar-policy.json <<'EOF'
[
  { "name": "keep-recent", "action": { "type": "Keep" },
    "mostRecentVersions": { "keepCount": 20 } },
  { "name": "delete-old", "action": { "type": "Delete" },
    "condition": { "olderThan": "2592000s" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies web \
  --project $PROD --location $REGION --policy /tmp/ar-policy.json --no-dry-run
```

(Keep ≥20 recent so rollback targets survive; the `buildcache` tag is
continuously re-pushed so it stays fresh.)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `auth@v2` fails: `unauthorized_client` / attribute condition | WIF condition doesn't match repo | Provider's `attribute-condition` must equal `'<owner>/<repo>'` exactly |
| Push denied to `pkg.dev` | Missing `configure-docker` or AR role | `gcloud auth configure-docker <region>-docker.pkg.dev`; deployer needs `artifactregistry.writer` |
| Deploy fails: `iam.serviceaccounts.actAs` | Deployer can't impersonate runtime SA | `roles/iam.serviceAccountUser` binding on the runtime SA |
| Smoke test gets 404 | Origin lockdown working as designed | Pass `X-Origin-Auth` header (deployer needs `secretAccessor` on the secret) |
| Candidate URL empty in smoke test | No tagged traffic target yet | First-ever deploy: run once with traffic, or check `--tag candidate` was set |
| Users saw a broken release | Traffic flipped before checking | The `release` job must stay behind the `production` environment gate — don't remove it to "go faster" |
| CI builds slow (~full rebuild) | Layer cache not hitting | `cache-from/to type=registry` refs present; Dockerfile copies `package*.json` before source |
| Release ran without approval | `production` environment has no required reviewers | Add yourself in Settings → Environments |
