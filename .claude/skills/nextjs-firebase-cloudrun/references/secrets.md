# Secrets & Env-file Management

Read this whenever creating, editing, or wiring any `.env*` file, adding a new
secret, or before any commit/deploy that touched configuration. The core
principle: **a secret that has ever existed in a commit, an image layer, or a
log is leaked — deleting it later does not un-leak it.** Prevention is cheap;
rotation after a leak is not.

## File layout

The project keeps exactly these env files:

| File | Committed? | Purpose |
|---|---|---|
| `.env.example` | ✅ yes | Template: every var name the app needs, **no real values** |
| `.env.local` | ❌ never | Real values for local dev |
| `.env.production`, `.env.*.local`, etc. | — | **Do not create.** Production values live in Cloud Run env vars / Secret Manager, not files |

`.env.example` is documentation that can't go stale silently — when adding a
new env var to the code, add it here in the same commit:

```bash
# .env.example — copy to .env.local and fill in
# ── Public (compiled into the JS bundle — safe to expose) ──
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# ── Server-only (NEVER prefix these with NEXT_PUBLIC_) ──
BACKEND_URL=
BACKEND_API_KEY=
ORIGIN_AUTH_SECRET=
# Local dev only — on Cloud Run use the attached service account (ADC) instead
# FIREBASE_SERVICE_ACCOUNT_JSON=
```

## Ignore files — both of them

A secret kept out of git but baked into a Docker layer is still leaked
(`docker history` / pulling the image reveals it). Both files must cover env
files and key material:

```gitignore
# .gitignore
.env
.env.*
!.env.example
*-service-account*.json
*.pem
*.key
```

```dockerignore
# .dockerignore
.env*
*.json.key
*-service-account*.json
.git
node_modules
.next
```

When reviewing a Dockerfile, also check no `COPY . .` happens **before**
`.dockerignore` exists in the build context, and no `ARG`/`ENV` carries a
server secret — `ARG` values are visible in `docker history`.

## Naming rule: the NEXT_PUBLIC_ boundary

- `NEXT_PUBLIC_*` → inlined into the client bundle at build time. Treat as
  **public**, because it is. Firebase client config belongs here.
- Everything else → server-only, readable at runtime. API keys, the origin
  auth secret, backend URLs you don't want advertised.
- Catching mistakes: if a var holds something you would not paste into a
  public GitHub issue, it must not have the prefix. If server code needs a
  `NEXT_PUBLIC_` var, that's fine; the reverse (client code "needing" a
  secret) means the design is wrong — move that logic into a route handler.

## Secret Manager workflow (production)

```bash
# create + first version (printf avoids trailing-newline bugs in secrets)
printf '%s' "the-secret-value" | gcloud secrets create backend-api-key \
  --project <project-id> --data-file=-

# new version when rotating
printf '%s' "the-new-value" | gcloud secrets versions add backend-api-key --data-file=-

# allow the Cloud Run runtime SA to read it
gcloud secrets add-iam-policy-binding backend-api-key \
  --member serviceAccount:<sa>@<project-id>.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor

# wire to the service (then redeploy or update)
gcloud run services update <service-name> --region asia-southeast1 \
  --set-secrets BACKEND_API_KEY=backend-api-key:latest,ORIGIN_AUTH_SECRET=origin-auth-secret:latest
```

Notes:
- `:latest` picks up new versions on the **next deployment/revision**, not
  live — after rotating, deploy a new revision.
- Plain `--set-env-vars` values are visible to anyone with `run.viewer` on
  the project; use it for non-secrets only (`BACKEND_URL` is fine,
  `BACKEND_API_KEY` is not).
- Generate strong secrets with `openssl rand -base64 32`.

## Leak scanning

Run before pushing anything that touched config, and periodically over
history:

```bash
# scan working tree + full git history
gitleaks detect --source . -v

# pre-commit guard (one-time setup)
gitleaks protect --staged
```

If `gitleaks` is not installed: `brew install gitleaks`.

Also do a quick manual sweep when suspicious:

```bash
git log -p --all -S 'PRIVATE KEY' -- '*.json' '*.env*'
grep -rn "AIza\|BEGIN PRIVATE KEY" --include='*.ts' --include='*.json' src/
```

(`AIza...` keys in client code are expected — that's the public Firebase API
key. A `BEGIN PRIVATE KEY` block anywhere in the repo is an incident.)

## If a secret leaks (committed, logged, or pasted)

Order matters — rotate first, clean up second:

1. **Rotate immediately**: new version in Secret Manager → deploy new
   revision. For a service-account key file: IAM → delete the key (and
   prefer never creating keys again — ADC needs none).
2. Check access logs (Cloud Audit Logs) for use of the old credential.
3. Only then consider history rewriting (`git filter-repo`) — and treat it as
   cosmetic: forks, clones, and caches still have the old value. Rotation is
   the fix; rewriting is tidying.

## Checklist for any config change

- [ ] New var added to `.env.example` (name only) in the same commit
- [ ] Server secret has **no** `NEXT_PUBLIC_` prefix
- [ ] Real value exists only in `.env.local` (dev) and Secret Manager (prod)
- [ ] `.gitignore` and `.dockerignore` still cover `.env*` and key files
- [ ] `gitleaks detect` clean before push
- [ ] After rotation: new Cloud Run revision deployed (`:latest` isn't live-reloaded)
