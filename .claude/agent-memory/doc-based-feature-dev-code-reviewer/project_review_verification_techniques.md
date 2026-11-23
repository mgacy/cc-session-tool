---
name: review-verification-techniques
description: Review verification traps and techniques — piped reads cut off at ~128 KB, scoped searches include the live session, and mutation-checking tests in a scratch copy (symlink main-repo node_modules)
metadata:
  type: project
---

**Piped JSON can come back cut off; redirect to a file before parsing.** In the issue #15 review (2026-11-22), piping `search` output into a Bun reader (`bun -e 'await Bun.stdin.text()'` or a script calling it) sometimes returned exactly 131072 bytes and failed with `JSON Parse error: Unexpected EOF`. Redirecting the same command to a file, or piping it to `wc -c`, always gave the full output (156677 / 158699 bytes). The cutoff did not happen every time: a 637 KB `--tool Bash` result parsed fine through the same pipe. The root cause was never found, so it is unknown whether the reader or the writer side cuts the output short. This is likely the same pipe truncation tracked as issue #21 (see [[preexisting-pipe-truncation]], which saw a ~64 KB cutoff on `list`).

**Why:** the reviewer spent 4 tool calls deciding the CLI itself truncated output, and called it a pre-existing CLI bug, before `wc -c` disproved it.

**How to apply:** write CLI output to a file and parse the file. Confirm the size with `wc -c` before reporting any truncation as a CLI bug.

**Scoped searches see the live session.** A `--project <main repo>` search includes the associated worktrees, so it also searches the transcripts of the session doing the review. One result was the live orchestrating parent session on `issue/15`, through one of its subagents. Two identical `--tool Bash --failed` runs gave 9 sessions, then 10. A never-match needle (`--output-match=zzzz_never_zzzz`) matched 1 session, probably because an earlier command of the reviewer's own printed the needle. Neither cause was confirmed by comparing session lists.

**How to apply:** use needles that never appear in your own commands or their output. Before treating a count difference as a regression, check which session IDs changed and exclude the live session.

**Mutation-checking a test in a scratch copy: link the main checkout's `node_modules`.** Reviewers may not edit sources, so to confirm a test fails without the fix, copy `index.ts`, `index.test.ts`, `src/`, `package.json` and `tsconfig.json` into the scratchpad, edit the copy, and run `bun test index.test.ts -t "<name>"` there. Worktrees have no `node_modules` of their own; the main checkout does. In the issue #27 review, symlinking the worktree's `node_modules` path made a dangling link, and the run failed with `Cannot find package 'citty'`. Symlinking `<main checkout>/node_modules` worked.

**How to apply:** symlink the main checkout's `node_modules` into the copy (find the checkout with `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`). Never stash or edit the worktree for this.
