---
name: executor-transcript-audit
description: progress.json executor timestamps can be estimates; verify durations and claimed test runs from the executor subagent transcripts with cc-session-tool
metadata:
  type: reference
---

Work-unit executors can write estimated `started_at` / `completed_at` values into progress.json. In task 019 (2026-11-22), 4 of 5 executors wrote rounded times (22:20:00, 22:25:00…). Some of those were later than the evaluation's own start time, so `execution_log` was out of order. Only the transcripts gave the real durations, about 1–1.6 minutes per unit. It recurred in task 018 (issue #16): WU5/WU6 never ran `date -u` and their `started_at` were 20–34 min late, and even executors that ran it for `started_at` invented `completed_at`.

**Why:** the estimates look plausible, and nothing in progress.json marks them as estimates. They go into the evaluation's timeline unless you check them against the transcripts.

**How to apply:** run these from the worktree. `<session>` is the orchestrator session, whose id is in the evaluator's scratchpad path.
- **Timing:** `bun run index.ts subagents <session>` lists each executor's agent_id and dispatch time. `shape <session>:<agent>` gives its `duration_minutes`; its turn timestamps can come back empty, so end time = dispatch + duration. `tools <session>:<agent>` shows whether the executor ran `date -u` at all.
- **Claimed `bun test` / `tsc` results:** use `slice <session>:<agent> --turn T-(T+1)`, where turn T is the call that ran the command.
  - The command's tool_result sits in the next turn's user entry, so slicing turn T alone shows only the command.
  - The response's `data` is an object (`session_id`, `agent_id`, `entries`), not an array.
