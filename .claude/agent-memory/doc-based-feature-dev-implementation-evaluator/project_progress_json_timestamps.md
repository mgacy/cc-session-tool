---
name: progress-json-timestamps-unreliable
description: Executor-written progress.json started_at/completed_at can be invented round minutes, even later than the wall clock; recover real start times and durations from the executor subagent transcripts with cc-session-tool
metadata:
  type: project
---

In task 018 (issue #16, 2026-11-22), executors recorded round-minute timestamps that did not match reality. Four `completed_at` values (WU2, WU3, WU5, WU6; e.g. WU6 `23:40:00Z`) were later than `date -u` at evaluation time (`22:56:01Z`). WU5/WU6 `started_at` (`23:10:00Z`, `23:25:00Z`) were 20–34 min after the real starts (`22:50:00Z`, `22:51:00Z`), and those executors never ran `date -u`. Only WU1–WU4 ran `date -u`, and their `started_at` matched to within seconds. Statuses and cumulative `bun test` pass counts were accurate.

**Why:** progress.json is the only completion artifact, so invented timestamps silently corrupt any duration or sequence analysis built on it.

**How to apply:** Before reporting durations, compare progress.json against `date -u` and `stat` mtimes. Recover the real timeline from the orchestrator session (its id is in the evaluator's scratchpad path):
- `bun run index.ts subagents <orchestrator-session> --project "$PWD"`: the `timestamp` per executor is its start time.
- `shape <session>:<agent-id>`: use `duration_minutes`. Its turn timestamp fields came back empty in task 018, so the end time is start + duration (inferred, not observed).
- `tools <session>:<agent-id>`: shows what each executor actually ran, e.g. whether it called `date -u`.

`list --main-only` only helps to identify the orchestrator session; its other fields were mostly blank.
