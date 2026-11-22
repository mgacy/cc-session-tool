# `cc-session-tool search` deep dive

Search is the most powerful — and the most footgun-prone — command in the tool. This file explains its scoping rules, file-identity matching across worktrees, and aggregation modes.

## When to use search vs list

- **`list`** indexes sessions by metadata only. Use it when you have a branch / time range / slug-keyword.
- **`search`** opens the JSONL and looks at content. Use it when the question is "which session did X" where X is a tool call, a file access, a phrase, a Bash command, or output/an error a tool returned.

## Synopsis

```bash
cc-session-tool search [scope] [selectors] [shaping] [time/branch] [--last N]
```

At least one **selector** is required: `--tool`, `--input-match` / `--input-regex`, `--output-match` / `--output-regex`, `--failed`, `--file`, `--text` / `--text-regex`, `--intent-match` / `--intent-regex`, `--bash` / `--bash-regex`, or a counter filter. Multiple selectors AND together.

## Scoping

| Flag | Effect |
| --- | --- |
| (none) | Scoped to the logical project at CWD, **including its Claude worktree transcript dirs**. |
| `--project <path>` | Same as above but with an explicit logical project. |
| `--all-projects` | Scan every top-level Claude project directory under `~/.claude/projects`. |
| `--project-glob <pat>` | Only valid with `--all-projects`. Filter by raw Claude project basename **or** by display-only `project_path_guess`. `*` and `?` supported. This matches Claude project identity, not filesystem files. |
| `--no-subagents` | Disable the default one-level subagent transcript inclusion. |

**Critical:** in `--all-projects` mode, an explicit `--project` is **only** a file-identity anchor for normalizing absolute `--file` queries. It does **not** narrow the scan, and the tool does **not** silently use CWD or `project_path_guess` as an authoritative root for unrelated projects.

## Selectors

| Flag | Matches | Notes |
| --- | --- | --- |
| `--tool <name>` | Tool names | Case-insensitive substring. |
| `--input-match <text>` | Raw structured tool input | Sees values omitted/truncated in `input_summary`. |
| `--input-regex <regex>` | Raw structured tool input | Mutually exclusive with `--input-match`. |
| `--output-match <text>` | Tool result text (`tool_result` block content) | Case-insensitive substring. **Result selector**: binds to the same call as the other tool-call selectors (see "Tool output and failures"). |
| `--output-regex <regex>` | Tool result text | Case-sensitive. Mutually exclusive with `--output-match`. Result selector. |
| `--failed` | Tool calls that failed (`is_error` or empty result, same as `tools --failed`) | Result selector; ANDed with `--output-*`. A call with no result is not failed. |
| `--file <path>` | Touched file paths | Absolute paths use canonical/realpath then logical identity matching (see below). Substrings work too. |
| `--operation <op>` | Filters `--file` to a specific operation | One of `read`, `edit`, `write`, `grep`, `glob`. **Only valid with `--file`** and tied to the same matching access. |
| `--origin` | With `--file`, returns earliest matching transcript **write** evidence | Implies `--operation write`. Defaults to one result. Transcript evidence, **not** VCS creation history. |
| `--text <text>` / `--text-regex` | User/assistant text and thinking | Case-insensitive substring or regex. **Does not search tool output**: an empty result does not mean it never happened; use `--output-match`/`--output-regex`. Output of user `!` commands is user text, so `--text` does match it. |
| `--intent-match <text>` / `--intent-regex` | Session intent sources (slug, first prompt token, first user message) | |
| `--bash <text>` / `--bash-regex` | Bash command inputs | Convenience over `--tool Bash --input-match`. |

## Tool output and failures

`--output-match`, `--output-regex` and `--failed` are **result selectors**. Giving any of them switches `search` to **bound mode**:

- **Binding.** `--tool`, `--input-*`, `--bash*`, `--file` and `--operation` must all match the *same* tool call as the result selector. `--tool Bash --output-match X` does not match a session where a `Read` returned `X`. Evidence lists only the calls that satisfy every selector.
- **Session-level selectors.** `--text*`, `--intent-*`, `--branch` and the date filters stay session-level and are not bound to the call.
- **Rejected combinations.** Selector pairs that can never land on one call fail with `INVALID_ARGS` instead of returning `[]`: `--bash*` with `--file`; `--bash*` with a `--tool` that cannot name Bash; `--file` with a `--tool` that cannot name a file tool (Read, Edit, Write, Grep, Glob); `--operation` (or `--origin`, which implies `write`) contradicting `--tool`. `--origin` is otherwise allowed and means "the earliest write whose result also satisfies the result selectors".
- **`--failed` selectivity.** About half of all sessions contain at least one `is_error` result, so `--failed` alone is unselective. Combine it with `--tool`, `--bash`, `--file`, `--input-*` or `--output-*`, or use `--aggregate count-per-session`.
- **What is matched.** Only the model-visible `tool_result` content, the same text `messages --type tool_result` shows. The raw `toolUseResult` payload is not matched. Large outputs persisted to disk (`<persisted-output>`) match only on their 2 KB preview.
- **Not covered.** Errors that are not tool results: API errors and hook attachment errors.
- **ReDoS.** `--output-regex` runs a caller-supplied regex over potentially large outputs. Prefer `--output-match`, and avoid nested quantifiers.
- **Aggregation.** `--aggregate count-per-session` accepts result selectors; `counts.tool_inputs` then counts matched calls. `--aggregate counters` rejects them.

Follow up on a `tool_output` evidence item to read the full result:

```bash
cc-session-tool messages <session>[:<agent_id>] --claude-project <session_ref.project> \
  --turn <result_turn> --type tool_result --max-tool-result 4000
```

Use `tool_use_id` to pick the matching result when the turn holds several results. Do not pass `--max-tool-result 0`; it yields an empty body.

## File identity matching (the worktree story)

For absolute `--file` queries inside the logical project, search does this in order:

1. **Exact canonical path candidates first.** The literal absolute path, plus its `realpath`-resolved variant when symlinks are involved.
2. **Shared project-relative logical identity next.** A main-tree path `/workspace/app/src/auth.ts` matches a worktree path `/workspace/app/.claude/worktrees/feature-a/src/auth.ts` as the same logical file `src/auth.ts`.
3. If both sides normalize to logical paths and they differ, search **does not** fall back to substring matching.

Practical consequence: from the main checkout, `search --file <absolute-main-tree-path> --operation write` is the primary workflow for finding worktree writes to the same logical file. You do not need `--all-projects` for that.

Use `--all-projects` only for broad audits.

## Shaping

| Flag | Description |
| --- | --- |
| `--sort <mode>` | One of `session-newest` (default), `match-earliest`, `match-newest`, `project`. **Match time** for `match-*`: file evidence time when the match has any file evidence, otherwise the earliest/latest non-`intent` evidence time (for `tool_output` evidence, the time of the matching `tool_use` call, not the result), otherwise the session start. |
| `--last <n>` | Truncate after sorting. With `--origin`, defaults to 1. |

## Time and branch filters

| Flag | Description |
| --- | --- |
| `--branch <name>` | Git branch filter. |
| `--after <ISO>` / `--before <ISO>` | Date range. |
| `--since <duration>` | `30m`, `2h`, `1d`, `1w`. Mutually exclusive with `--after`. |

Date filters and `--bucket` use session start time.

## Aggregation modes

Default: full match rows with evidence. Two summary modes:

### `--aggregate count-per-session`

Per-session rollup with `counts.tool_inputs` and a small `sample_matches` array. Useful for "how often did session X do Y" audits. Accepts `--output-match`, `--output-regex` and `--failed`, in which case `counts.tool_inputs` counts the matched (bound) calls.

### `--aggregate counters`

Named raw-input counters. They count every raw tool input in matched sessions (without `--tool`, every tool's input), not just the calls that matched a selector, and they reject `--output-match`, `--output-regex` and `--failed` (use `count-per-session`). Combine with `--counter NAME=text` or `--counter-regex NAME=regex` (repeatable). Add `--bucket day|week` to bucket by date (missing timestamps go to `unknown`). `--per-subagent` emits transcript-level rows instead of parent-session rollups.

```bash
cc-session-tool search --tool Bash --aggregate counters \
  --counter tests='bun test' \
  --counter typecheck='tsc' \
  --bucket day
```

## Output shape

Default full-match rows include, where relevant:

- `session_id`, `branch`, `timestamp`, `slug`
- `matches.tools`, `matches.files`, `matches.normalized_files`
- `matches.evidence` — array of evidence items `{ kind, rawPath, logicalPath, operation, turn, block_index, timestamp }`
- `tool_output` evidence (bound mode) adds `tool_use_id`, `result_turn`, `result_timestamp`, `is_error` and a `snippet` (omitted when empty). Its `turn` / `block_index` / `timestamp` describe the **`tool_use`** call, like every other evidence kind; `result_turn` / `result_timestamp` locate the `tool_result`. `matches.turns` holds call turns, and `matches.tools` lists the tools of the matched calls even without `--tool`.
- `matches.operations`, `matches.turns`

Worktree / all-project responses add:

- `project` — raw Claude project directory basename (use with `--claude-project`)
- `project_path_guess` — display-only, lossy when paths have hyphens
- `project_role` — `main` / `worktree` / `global`
- `session_ref` — `{ session_id, project }` for stable follow-up

Scoped responses set `_meta.included_projects`; all-projects responses set `_meta.projects_scanned`.

`--origin` results add `matches.file_evidence` (the earliest matching write entry).

## Common recipes

```bash
# Sessions that touched auth.ts in current project (incl. worktrees)
cc-session-tool search --file auth.ts

# Worktree writes to a specific logical file
cc-session-tool search --file /workspace/app/src/auth.ts --operation write

# Earliest transcript write evidence for a file
cc-session-tool search --file /workspace/app/src/auth.ts --origin

# Recent Bash test invocations across selected projects
cc-session-tool search --all-projects --project-glob "*app*" \
  --bash "bun test" --since 1d --last 5

# Audit raw Bash inputs by session
cc-session-tool search --tool Bash --input-match "bun test" \
  --aggregate count-per-session

# Find sessions where the user asked about auth
cc-session-tool search --text "auth" --since 7d

# Which sessions saw a given tool error/refusal text? (--text would not find it)
cc-session-tool search --all-projects --tool Bash \
  --output-match "denied by the Claude Code auto mode" --sort match-earliest

# Sessions where a specific kind of call failed; counts per session
cc-session-tool search --bash "bun test" --failed
cc-session-tool search --tool Bash --failed --aggregate count-per-session --since 7d
```

## Follow-up from a result row

Pass `session_ref.project` to subsequent commands via `--claude-project`:

```bash
# A search row included:
#   "session_ref": { "session_id": "DA2738E3-...", "project": "-workspace-app--claude-worktrees-feature-a" }

cc-session-tool tools DA2738E3 --claude-project -workspace-app--claude-worktrees-feature-a
```

**Do not** derive `--project` paths from `project_path_guess` — it is display-only and not a stable handle.
