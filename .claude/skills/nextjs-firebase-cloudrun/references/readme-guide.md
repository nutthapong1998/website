# README Guide — Dev Onboarding + Deploy Runbook

Read this when creating or updating `README.md`, or when setup/deploy steps
change (new env var, new gcloud flag, new external dependency). A README has
exactly two jobs in this project:

1. **Dev path**: a developer who has never seen the repo runs the site
   locally within ~5 minutes, copy-pasting commands top to bottom.
2. **Deploy path**: anyone (including future-you at 2am during an incident)
   deploys to production correctly without re-deriving the steps from memory
   or chat history.

Everything that doesn't serve those two readers goes elsewhere (design
rationale → code comments/PRs; security policy → this skill; marketing →
the website itself).

## Principles

- **Commands must be copy-paste runnable, in order, with no hidden steps.**
  The test: `git clone` into a fresh directory and follow the README
  literally. Every place it breaks is a README bug. Re-run this test after
  any setup-affecting change.
- **The README states WHAT to run; it should not duplicate WHY** — link to
  deeper docs instead. Duplicated explanations drift; drifted docs are worse
  than no docs because they're confidently wrong (same reason as the
  hallucination rules in SKILL.md).
- **Every env var the app reads appears in the README table AND
  `.env.example`, in the same commit that introduces it.** An undocumented
  env var is the #1 cause of "works on my machine".
- **Prerequisites come with version + a check command** (`node -v`), not just
  a name. "Install Node" fails people on v16; "Node ≥ 20 (`node -v`)"
  doesn't.
- **The deploy section is a runbook, not an essay**: numbered steps, exact
  commands with real flag values, then a verify step, then a rollback step.
  If deploy is scripted (`npm run deploy`), document the script as the path
  and keep the raw commands in the script file.
- Keep it in one file until it genuinely outgrows that (~300 lines); a
  `docs/` folder for a profile site is premature.

## Template

Use this structure; replace placeholders, delete sections that truly don't
apply (but never delete Quick start, Environment variables, Deploy, or
Troubleshooting):

````markdown
# <Project name>

One sentence: what this is and the production URL.

**Stack**: Next.js (App Router) · Firebase (Firestore/Auth) · Cloud Run · Cloudflare

| Environment | URL |
|---|---|
| Production (site) | https://www.example.com |
| Production (admin) | https://admin.example.com |
| Local | http://localhost:3000 |

## Quick start

Prerequisites: Node ≥ 20 (`node -v`), gcloud CLI (`gcloud -v`), access to
Firebase project `<project-id>`.

```bash
git clone <repo-url> && cd <repo>
npm ci
cp .env.example .env.local        # then fill values — see table below
gcloud auth application-default login   # local Firestore access (Admin SDK)
npm run dev                       # → http://localhost:3000
```

To develop against emulators instead of the real Firestore:

```bash
firebase emulators:start --only firestore,auth
```

## Environment variables

| Variable | Where used | Example / how to get it |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | client | Firebase console → Project settings → Web app |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | client | same place |
| `BACKEND_URL` | server (proxy) | e.g. `https://api.example.com` |
| `BACKEND_API_KEY` | server | Secret Manager: `backend-api-key` |
| `ORIGIN_AUTH_SECRET` | middleware | Secret Manager: `origin-auth-secret` (must match Cloudflare Transform Rule) |

Local: values go in `.env.local` (never committed).
Production: plain values via `--set-env-vars`, secrets via Secret Manager (see Deploy).

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm run build` | production build — run before every PR |
| `npm run lint` / `npx tsc --noEmit` | lint / typecheck |
| `firebase deploy --only firestore:rules` | deploy Firestore rules |

## Project structure

(5–10 lines only — the top-level map, not a full tree)

```
src/app/(site)/   main website (www)
src/app/admin/    admin app (admin subdomain)
src/app/api/      route handlers: public/ auth/ admin/
src/lib/          firebase clients, auth guards, zod schemas
src/middleware.ts host routing + origin lockdown
```

## Deploy

Production deploys go from `main` only, after the PR checks pass.

```bash
# 1. Deploy
gcloud run deploy <service-name> \
  --source . \
  --project <project-id> \
  --region asia-southeast1 \
  --service-account <sa>@<project-id>.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars BACKEND_URL=https://... \
  --set-secrets BACKEND_API_KEY=backend-api-key:latest,ORIGIN_AUTH_SECRET=origin-auth-secret:latest

# 2. Verify
curl -s -o /dev/null -w "%{http_code}\n" https://www.example.com        # expect 200
curl -s -o /dev/null -w "%{http_code}\n" https://<service>.run.app      # expect 404 (origin lockdown)
gcloud run services logs read <service-name> --region asia-southeast1 --limit 30

# 3. Rollback (if verify fails) — route traffic back to the previous revision
gcloud run revisions list --service <service-name> --region asia-southeast1
gcloud run services update-traffic <service-name> \
  --region asia-southeast1 --to-revisions <previous-revision>=100
```

Notes:
- Changing a `NEXT_PUBLIC_*` value requires a rebuild/redeploy — they are
  baked in at build time, not read at runtime.
- After rotating a secret in Secret Manager, deploy a new revision —
  `:latest` is resolved at deploy, not live.
- Firestore rules deploy separately: `firebase deploy --only firestore:rules`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PERMISSION_DENIED` from Firestore locally | `gcloud auth application-default login` with an account that has access |
| Redirect loop on the domain | Cloudflare SSL mode must be **Full (strict)** |
| 404 on www/admin but run.app... | see origin-lockdown notes in `.claude/skills/.../security.md` |
| env var undefined in prod | `NEXT_PUBLIC_*`? → rebuild. Server var? → check `--set-env-vars`/`--set-secrets` on the service |
````

## Maintenance rule (the part everyone skips)

The README is part of the definition of done: a PR that adds an env var,
changes a setup step, alters deploy flags, or renames a script **must update
the README in the same PR** — reviewers should reject it otherwise. Stale
READMEs don't announce themselves; they wait for the next onboarding or the
next incident to fail.

After writing or editing the README, verify it the same way as code: run the
Quick start block in order in a clean shell and confirm each command works
exactly as written. "Looks right" is not verification.
