---
name: review-verification-techniques
description: False-positive traps when probing cc-session-tool CLI output during review — piped reads cut off at ~128 KB, and scoped searches include the live session's own transcripts
metadata:
  type: project
---

**Piped JSON can come back cut off; redirect to a file before parsing.** In the issue #15 review (2026-11-22), piping `search` output into a Bun reader (`bun -e 'await Bun.stdin.text()'` or a script calling it) sometimes returned exactly 131072 bytes and failed with `JSON Parse error: Unexpected EOF`. Redirecting the same command to a file, or piping it to `wc -c`, always gave the full output (156677 / 158699 bytes). The cutoff did not happen every time: a 637 KB `--tool Bash` result parsed fine through the same pipe. The root cause was never found, so it is unknown whether the reader or the writer side cuts the output short.

**Why:** the reviewer spent 4 tool calls deciding the CLI itself truncated output, and called it a pre-existing CLI bug, before `wc -c` disproved it.

**How to apply:** write CLI output to a file and parse the file. Confirm the size with `wc -c` before reporting any truncation as a CLI bug.

**Scoped searches see the live session.** A `--project <main repo>` search includes the associated worktrees, so it also searches the transcripts of the session doing the review. One result was the live orchestrating parent session on `issue/15`, through one of its subagents. Two identical `--tool Bash --failed` runs gave 9 sessions, then 10. A never-match needle (`--output-match=zzzz_never_zzzz`) matched 1 session, probably because an earlier command of the reviewer's own printed the needle. Neither cause was confirmed by comparing session lists.

**How to apply:** use needles that never appear in your own commands or their output. Before treating a count difference as a regression, check which session IDs changed and exclude the live session.
