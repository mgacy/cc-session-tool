---
name: cc-session-tool
description: Use cc-session-tool to inspect Claude Code session transcripts. Trigger this skill whenever the user asks about a past Claude Code session, recent agent activity, prior tool usage, what files a session touched, which session wrote/edited a specific file, why a session ran long or consumed tokens, what a subagent did, or anything that would otherwise require reading raw transcripts. Prefer this tool over reading the JSONL files directly.
---

# cc-session-tool

A CLI that queries Claude Code session transcripts and returns compact JSON. Designed for agent consumption — every command returns a `{ ok, data, _meta }` envelope so output is mechanical to parse.

The CLI must be on PATH as `cc-session-tool`; inside the cc-session-tool repository, `bun run index.ts <command>` works without installing it. Run any subcommand with `--help` for full flag reference, or consult `references/commands.md` in this skill for a condensed catalog.

## When to reach for which command

Match the user's intent to a command before reading flags. Most investigations are two steps: find the session, then drill in.

| Intent                                                          | Command               |
| --------------------------------------------------------------- | --------------------- |
| List recent sessions (current project + its worktrees)          | `list`                |
| Cross-project listing                                           | `list --all-projects` |
| Index project transcript directories themselves                 | `projects`            |
| Find which sessions touched a file, ran a tool, said a phrase   | `search`              |
| Get a fast triage summary of one session                        | `summary`             |
| See the turn-by-turn skeleton with tool/edit stats              | `shape`               |
| Inspect tool calls with condensed inputs and outcomes           | `tools`               |
| List files touched by a session                                 | `files`               |
| Read raw entries for specific turns (full content escape hatch) | `slice`               |
| See filtered/truncated message text or thinking                 | `messages`            |
| Per-turn token usage                                            | `tokens`              |
| Discover subagents spawned during a session                     | `subagents`           |

Run `cc-session-tool <command> --help` whenever you need the exact flag list; flags evolve, and the help output is authoritative.

## Core workflow: triage then drill

Two-phase pattern that minimizes token usage:

1. **Triage** — narrow to one session with `list`, `search`, or a session ID the user provided.
2. **Drill** — start with `summary` for a one-shot overview. If you need more, use `shape` for the table of contents, then `tools` / `files` / `messages` / `slice` for specifics.

Avoid `slice` without a `--turn` range narrower than ~5 turns — it returns raw content, which is expensive. Use `shape` or `messages` first to locate the turns you care about. `messages` truncates text and thinking to 200 characters across a turn range, but a single `--turn N` returns them in full unless you pass `--max-content`.

## Key concepts

### Session identifiers

Three forms, all accepted by every session-scoped command:

- **Full UUID** (`DA2738E3-0ADE-40E7-B6AC-450F9CCE1B43`)
- **UUID prefix** (`DA2738E3`) — must be unambiguous within the selected project
- **Slug** (`snuggly-floating-barto`) — searched across JSONL contents, must be unambiguous

Pass a session ID directly when the user gives you one. Otherwise resolve via `list` or `search` and use the `session_id` field.

### Subagent targeting

A subagent session is addressed with colon notation: `<session>:<agent-id>` (e.g., `DA2738E3:a8361bc`). The session part resolves normally; the agent file lives at `<session-dir>/subagents/agent-<agent-id>.jsonl`. Every session-scoped command accepts this notation except `subagents` itself (use `subagents` to _discover_ agent IDs).

```bash
cc-session-tool subagents DA2738E3                # discover agents
cc-session-tool shape DA2738E3:a8361bc            # inspect one
```

### Projects, worktrees, and `--claude-project`

By default, `list` and `search` are scoped to the **logical project** of the current working directory and _also_ include that project's Claude-managed worktree transcript directories. This is intentional: from the main checkout, a search can find work done in a worktree without `--all-projects`.

For follow-up commands, use the stable `project` field (or `session_ref.project`) returned in search/list rows as `--claude-project`. **Never** use `project_path_guess` — it is display-only and lossy.

```bash
# Good — stable follow-up using the raw Claude project basename
cc-session-tool shape DA2738E3 --claude-project -workspace-app--claude-worktrees-feature-a

# Bad — project_path_guess is a display hint, not a handle
cc-session-tool shape DA2738E3 --project /workspace/app  # may target the wrong directory
```

`--project` and `--claude-project` are mutually exclusive. Use `--main-only` on `list` to skip worktrees when you really want only the main directory.

### Turn numbering

Every `user` or `assistant` JSONL entry gets the next sequential integer starting at 1. Other entry types are skipped. Turn numbers are consistent across all commands: turn 5 in `shape` is the same turn 5 in `tools`, `messages`, `slice`, etc. Multi-block assistant turns (e.g., thinking + tool_use) share the turn number; `block_index` disambiguates blocks within a turn.

### Output envelope

Every command emits one of:

```json
{ "ok": true,  "data": ..., "_meta": { "total": N, "returned": N, "hasMore": false } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Exit codes: `0` success, `1` format error, `2` invalid args, `3` not found. Always check `_meta.hasMore` — long results truncate.

## Common workflows

### "What did the last session do?"

```bash
cc-session-tool list --last 1
# grab session_id from output
cc-session-tool summary DA2738E3
```

`summary` returns model, timing, first prompt snippet, last assistant text, tool counts, file access counts, and subagent metadata in a single call — usually enough for triage.

### "Find the session that wrote/edited file X"

```bash
# Current logical project (includes its worktrees by default)
cc-session-tool search --file src/auth.ts --operation write

# Earliest matching transcript write evidence (one row by default)
cc-session-tool search --file /workspace/app/src/auth.ts --origin

# Broad audit across every Claude project
cc-session-tool search --all-projects --file src/auth.ts --operation write
```

Search compares absolute main-tree paths against worktree-local paths via shared project-relative identity — so a query for the main-checkout path can match the same logical file written from a worktree. See `references/search.md` for the matching rules and aggregation modes.

### "What tools / files were used in this session?"

```bash
cc-session-tool tools DA2738E3                           # full tool log
cc-session-tool tools DA2738E3 --name Grep --failed      # only failed greps
cc-session-tool tools DA2738E3 --turn 1-14               # before first edit
cc-session-tool files DA2738E3                           # files by path
cc-session-tool files DA2738E3 --operation edit          # only edits
cc-session-tool files DA2738E3 --group-by turn           # chronological
```

### "Show me the assistant's reasoning on turn 14"

```bash
cc-session-tool shape DA2738E3                                   # locate the turn
cc-session-tool messages DA2738E3 --role assistant --type thinking --turn 14
cc-session-tool slice DA2738E3 --turn 14-16                      # full content
```

### "What did the subagent do?"

```bash
cc-session-tool subagents DA2738E3                # list agents
cc-session-tool summary  DA2738E3:a8361bc         # triage that agent
cc-session-tool tools    DA2738E3:a8361bc         # its tool calls
```

### Audits across many sessions

```bash
# Per-session counts of Bash commands matching a pattern
cc-session-tool search --tool Bash --input-match "bun test" --aggregate count-per-session

# Named raw-input counters, bucketed by day
cc-session-tool search --tool Bash \
  --aggregate counters \
  --counter tests='bun test' \
  --counter typecheck='tsc' \
  --bucket day
```

## Pitfalls to avoid

- **Don't read JSONL files directly.** Transcripts are huge; always go through the CLI.
- **Don't rely on `project_path_guess`** for follow-up commands. Use `project` / `session_ref.project` with `--claude-project`.
- **Don't pass `--operation` without `--file`** — the filter only binds when there's a matching file access to bind to.
- **`--origin` is transcript evidence, not VCS history.** It tells you the earliest _recorded write in a transcript_, not when the file was first committed.
- **`--all-projects` plus `--project` does not narrow the scan.** In all-projects mode, `--project` is only a file-identity anchor for absolute paths; the scan still covers every project.
- **`slice` without `--turn` is required to fail** — always pass a range.
- **Validate inputs.** Session IDs accept `[a-zA-Z0-9-]`; agent IDs additionally allow `_`; `--claude-project` is a basename only (no path traversal).

## Further detail

Use these reference files when the above isn't enough. Read only the one you need.

- `references/commands.md` — full per-command flag list and output schemas, condensed from the README.
- `references/search.md` — search command deep dive: scoping semantics, file-identity matching across worktrees, aggregation modes, output fields.
