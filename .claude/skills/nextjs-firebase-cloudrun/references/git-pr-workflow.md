# Git & AI Pull Request Workflow

Read this before committing, branching, or opening a PR. The premise: most
code in this project is AI-written, so the PR is where the human regains
control. Everything below is designed to make the human review fast and
trustworthy — small diffs, honest descriptions, and verification evidence
attached.

## One-time setup (if the project is not a git repo yet)

```bash
git init -b main
git add .gitignore .dockerignore   # ignore rules FIRST, before any other add
git add -A && git commit -m "chore: initial commit"
gh repo create <name> --private --source . --push
```

Adding ignore files in the first commit matters: it guarantees `.env.local`
or key files can never be in history "from before the gitignore existed".

## Branching

- `main` is always deployable. Never commit to it directly — even one-line
  fixes go through a branch, because "trivial" is exactly where unreviewed
  AI changes bite.
- Branch names: `feat/<short-topic>`, `fix/<short-topic>`, `chore/<...>`,
  e.g. `feat/admin-posts-crud`, `fix/csp-blocks-auth-popup`.
- One branch = one concern. If work drifts into a second concern, stop and
  split — a 1,000-line mixed PR doesn't get reviewed, it gets skimmed and
  rubber-stamped, which defeats the only human checkpoint in the loop.

## Commits

Conventional commits, imperative mood, scoped to this project's areas:

```
feat(admin): add post editor with draft/publish toggle
fix(proxy): forward query string to backend
chore(deploy): bump min-instances to 1
docs(skill): update security checklist
```

- Commit when a coherent unit works, not at the end of a session. Each
  commit should build (`npm run build` passes) — bisectability is what makes
  future debugging cheap.
- Never use `git add .` blindly; review `git status` and add specific paths.
  This is the last line of defense against committing `.env.local`, build
  output, or editor junk.
- Per repo policy for AI-authored commits, end the message with the
  Co-Authored-By trailer identifying the AI.

## Pre-PR checklist (run all, attach results to the PR)

```bash
npx tsc --noEmit          # types
npm run lint              # lint
npm run build             # the real gate — catches RSC/client boundary errors
gitleaks detect --source . -v   # no secrets in the diff or history
git diff main --stat      # final scan: only intended files changed?
```

The `git diff --stat` step catches the classic AI failure mode: incidental
edits to files outside the task (lockfile churn, reformatting, leftover debug
code). Revert anything the PR title doesn't explain.

## Opening the PR

```bash
git push -u origin <branch>
gh pr create --title "feat(admin): post editor" --body "$(cat <<'EOF'
## What
One-paragraph summary of the change.

## Why
The problem or request this solves. Link the issue if one exists.

## How verified
- [x] `npm run build` passes
- [x] `curl -i localhost:3000/api/admin/posts` → 401 without session (guard works)
- [ ] NOT verified: behavior on Cloud Run (needs deploy)

## Security notes
Touched: app/api/admin/* — guard order unchanged. No new env vars.

## Screenshots
(required for any UI change — before/after)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Rules for the description — this is the honesty contract of AI PRs:

- **"How verified" must distinguish verified from not-verified.** "Wrote
  tests" ≠ "tests pass". An unverified claim in a PR body is a hallucination
  with a paper trail. List what was actually run and what wasn't.
- **Security notes are mandatory** when the diff touches `app/api/`,
  `middleware.ts`, auth, rules, Dockerfile, or any config — one line saying
  what changed in the trust boundary, or "none touched".
- Keep PRs under ~400 changed lines where possible. Stack bigger work as a
  sequence of PRs instead.

## Reviewing an AI PR (for the human — and for AI self-review before push)

Before pushing, re-read the full diff (`git diff main`) with these questions,
in priority order:

1. **Trust boundary**: does any change weaken a guard, widen a rule, add an
   env var, or alter middleware order? That's where review time goes first.
2. **Scope**: does every hunk serve the PR title? Delete what doesn't.
3. **Dependencies**: any new package? Verify it's the real, popular one
   (`npm view <pkg>` — check weekly downloads/repo), not a near-name.
4. **Dead weight**: leftover `console.log`, commented-out code, unused
   imports, TODO without owner.

The `/code-review` and `/security-review` commands automate a pass of this —
use them on the branch before requesting human review, and fix findings
before the human ever sees the PR.

## Merge & cleanup

- Squash-merge (`gh pr merge --squash --delete-branch`) — one PR = one commit
  on main keeps history readable and revertable.
- After merge, deploy from `main` only. If the deploy breaks, `git revert`
  the squash commit and redeploy — don't hot-fix on top of a broken prod
  while debugging.
