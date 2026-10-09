---
name: commit-conventions
description: Commit message format and commit hygiene for this repository. Use every time you create a git commit, split work into commits, or write a PR title.
---

# Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <summary>

<body: what changed and why, wrapped at 72 columns>

<footer: BREAKING CHANGE: …, Refs #12>
```

## Types

`feat` (user-visible feature), `fix` (bug fix), `refactor` (no behavior change), `perf`, `style` (formatting only), `test`, `docs`, `build` (deps, package scripts, tooling config), `ci`, `chore` (anything else).

## Scopes

`web` (apps/web), `desktop` (apps/desktop), `backend` (apps/backend), `contract` (packages/contract), `mock` (tools/mock-server), `ci`, `docs`, `agents` (CLAUDE.md, .claude/). Omit the scope for repo-wide changes.

## Summary line

- Imperative mood: "add", "fix", "show". Not "added" or "adds".
- Lowercase after the colon, no trailing period, ≤ 72 characters total (aim for ~50).
- Say what changes for the user or developer, not which files you touched.
  - Good: `feat(web): collapse older cards under "Earlier terms"`
  - Bad: `update LiveScreen.tsx`

## Body

Explain **why** and any non-obvious **how**. Leave it out for trivial commits. Use bullets when listing several changes.

## Breaking changes

Add `!` after the scope and a footer: `feat(contract)!: rename card.now to card.context`, followed by `BREAKING CHANGE: the backend must send context instead of now.` Contract breaks also bump `CONTRACT_VERSION`.

## Hygiene

- One logical change per commit. Separate contract changes from the UI work that uses them.
- Run `pnpm check` before committing. Never commit a red build to `main`.
- Never commit secrets, `.env` files, `node_modules`, or `dist`.
- **No AI attribution.** Don't add `Co-Authored-By` trailers, "Generated with…" lines, or any assistant or tool names to commits or PR descriptions. The commit author is the human who owns the work.
- Don't amend or force-push commits that are already pushed unless asked.
