---
name: review-verification-techniques
description: False-positive traps when probing cc-session-tool CLI output during review — scoped searches include the live session's own transcripts, and fake-HOME python3 runs fail through the mise shim
metadata:
  type: project
---

**Scoped searches see the live session.** A `--project <main repo>` search includes the associated worktrees, so it also searches the transcripts of the session doing the review. One result was the live orchestrating parent session on `issue/15`, through one of its subagents. Two identical `--tool Bash --failed` runs gave 9 sessions, then 10. A never-match needle (`--output-match=zzzz_never_zzzz`) matched 1 session, probably because an earlier command of the reviewer's own printed the needle. Neither cause was confirmed by comparing session lists.

**How to apply:** use needles that never appear in your own commands or their output. Before treating a count difference as a regression, check which session IDs changed and exclude the live session.

**Fake-HOME runs: `python3` fails through its mise shim.** `python3` on PATH is a mise shim; `bun` is the Homebrew binary and was not affected. In the issue #21 review (2026-11-23), with `HOME` pointed at a scratch dir and the cwd inside the worktree, every PATH `python3` call failed with `mise ERROR Config files in /Users/matt/.config/mise/config.toml are not trusted`, and the script never ran. This cost two retries. The same call worked after `cd` to the scratchpad, but which condition triggers the error was never isolated.

**How to apply:** before you export a fake `HOME`, `cd` to the scratchpad and call `/usr/bin/python3` directly.
