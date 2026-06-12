# AI-Primary Development & Deployment Lifecycle

Read this when planning a feature, setting up CI/CD, deploying to staging or
production, or deciding "is this safe for the AI to do alone?". It is the
umbrella over [git-pr-workflow.md](git-pr-workflow.md) (PR mechanics) and the
deploy runbook in [readme-guide.md](readme-guide.md) — those say *how*, this
says *when, in what order, and who*.

The operating principle when AI writes most of the code: **the human's
scarce resource is attention, so the pipeline's job is to spend machine time
(checks, gates, staging) to make each human checkpoint small and
decisive.** Two checkpoints are non-negotiable: PR review, and the
production promotion. Everything else can and should be automated.

## Environments

Two environments only — this is a two-person team (one human, one AI), so
a staging service would be ceremony without a second audience:

```
local       .env.local → Firebase project `<name>-dev` (or emulators)
production  Cloud Run service `<name>` → Firebase project `<name>-prod`
```

- **Two Firebase projects, not one.** The reason is AI-specific: an agent
  iterating on seed scripts, rules, or admin CRUD will create/delete data
  freely — that must be structurally unable to touch production data, not
  just "be careful". The `-dev` project is local development's database;
  it has no Cloud Run service.
- What replaces staging is Cloud Run's revision mechanics: every merge to
  `main` deploys a **candidate revision with zero traffic**, CI
  smoke-tests it, and traffic flips only on the human's approval click
  (pipeline in [cicd.md](cicd.md)). Users never see an unapproved build.
- The corollary of having no staging: the local verification ladder below
  IS the test environment. Skipping a rung locally isn't "moving fast", it
  is shipping the skipped rung to the candidate — keep the ladder strict.

## The development loop (repeat per task)

1. **Scope a task that fits one PR** (< ~400 lines, one concern). With AI
   speed, the temptation is giant tasks; resist it — review quality, not
   typing, is the bottleneck, and review quality collapses with diff size.
2. **State the acceptance check before writing code** — the command or
   observation that will prove this task done (a curl + expected status, a
   build-output symbol, a screenshot of the page). If the acceptance check
   can't be stated, the task isn't scoped yet. This is the agent-loop
   version of test-first: it prevents "looks done" from substituting for
   "is done".
3. **Implement smallest-verifiable-increment first**: schema → handler →
   page, verifying each layer before stacking the next. When an AI builds
   all three layers blind and the result fails, the debugging session costs
   more than the incremental checks would have.
4. **Verify up the ladder** (each rung only after the previous passes):
   - `npx tsc --noEmit` — seconds, catches most AI slips
   - `npm run build` — catches RSC/client boundaries, route symbols
     (public pages must stay `○`/`◐`, per scaling.md)
   - run it: `npm run dev` + real `curl`/browser against the acceptance
     check from step 2, emulators for data flows
   - the pre-PR gate from git-pr-workflow.md (lint, gitleaks, diff scan)
5. **PR with verified/not-verified split** (template in git-pr-workflow.md),
   self-review with `/code-review` and — when auth/API/middleware/rules/
   Dockerfile changed — `/security-review`, fix findings, then hand to the
   human. The human merges; merge auto-builds the zero-traffic candidate.

Session hygiene for AI sessions: end every session with committed-or-
discarded state (`git status` clean) and the acceptance check's result
stated honestly in the PR or handoff note. A session that ends "mostly
working, will fix tomorrow" with a dirty tree is where regressions hide.

## CI/CD pipeline

GitHub Actions, two workflows. The PR gate (must pass before merge):

```yaml
# .github/workflows/ci.yml
name: CI
on: { pull_request: { branches: [main] } }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # gitleaks needs history
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run lint
      - run: npm run build
      - uses: gitleaks/gitleaks-action@v2
```

The deployment workflow (merge → build image → push to Artifact Registry →
zero-traffic candidate revision → smoke test → human approval → traffic
flip) lives in [cicd.md](cicd.md), including WIF setup, the workflow file,
registry hygiene, and troubleshooting. Auth is Workload Identity
Federation — no service-account key JSON in GitHub secrets, same "no key
files" rule as everywhere else in this stack.

The traffic flip is deliberately gated behind a GitHub `production`
environment with required reviewers — merging does NOT put code in front
of users by itself. Keeping a human hand on this lever is the point, not a
missing automation.

Enable branch protection on `main`: require the CI check, require one
review, no force pushes — these settings are what turn "the AI should open
a PR" from a convention into a guarantee.

## Production deploy & post-deploy

Follow the README runbook (deploy → verify → rollback commands). Additions
that matter in the AI-primary context:

- **Releases come from `main` at a CI-green commit only** — never deploy a
  feature branch or a dirty tree "just to test something in prod"; the
  zero-traffic candidate exists precisely so there's nothing to test in
  prod by hand.
- **Verify against the acceptance checks of what shipped**, not just
  generic 200s: if the release changed the contact form, submit the
  contact form after the traffic flip.
- **First failure response is `update-traffic` back to the previous
  revision** (rollback commands in cicd.md and the README), *then* debug
  locally with prod logs. Cloud Run revisions make rollback a 10-second
  operation — use that instead of debugging live while users see errors.
- Migration-like changes (Firestore rules, indexes, restructured docs)
  deploy in compatibility order: additive change → deploy code that
  handles both shapes → backfill → remove old handling. Rules deploy
  separately (`firebase deploy --only firestore:rules`) — sequence them
  consciously with the code deploy, and rehearse the sequence against the
  `-dev` Firebase project first.

## Division of labor — AI vs human

AI does freely (reversible, gated later anyway):
local code, tests, dev-project/emulator data, branches, PRs, the
zero-traffic candidate deploys that CI performs on merge, read-only prod
inspection (`logs read`, `services describe`, metrics).

AI does only with explicit human go-ahead in that conversation:
flipping production traffic (approving the release gate is the human's
click by definition) and any manual `update-traffic`, prod Firestore rules
or index changes, secret creation/rotation, IAM/service-account changes,
Cloudflare config changes (WAF, cache rules, Access policies, DNS),
deleting anything in a prod project, force-push or history rewrites.

Standing rule for the AI, stated because agents under pressure rationalize:
**when a gate fails, the fix is never to remove the gate.** Disabling a
lint rule, skipping a failing build step, loosening a Firestore rule,
commenting out a guard, or adding `--force` to get unstuck converts a
visible failure into an invisible one. Surface the failure to the human
instead.

## Project memory (CLAUDE.md)

CI gates catch what's wrong; `CLAUDE.md` at the repo root prevents
re-litigating what's already decided. Keep it short and current: the
commands (dev/build/test/deploy), the env/promotion model above, project
conventions that aren't obvious from code, and pointers to this skill's
references. When a convention changes, updating CLAUDE.md is part of the
same PR — an AI session that starts from stale instructions reproduces
stale decisions, which is this stack's equivalent of a flaky test.
