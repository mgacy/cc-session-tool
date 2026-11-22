# `cc-session-tool search` deep dive

Search is the most powerful — and the most footgun-prone — command in the tool. This file explains its scoping rules, file-identity matching across worktrees, and aggregation modes.

## When to use search vs list

- **`list`** indexes sessions by metadata only. Use it when you have a branch / time range / slug-keyword.
- **`search`** opens the JSONL and looks at content. Use it when the question is "which session did X" where X is a tool call, a file access, a phrase, or a Bash command.

## Synopsis

```bash
cc-session-tool search [scope] [selectors] [shaping] [time/branch] [--last N]
```

At least one **selector** is required: `--tool`, `--input-match` / `--input-regex`, `--file`, `--text` / `--text-regex`, `--intent-match` / `--intent-regex`, `--bash` / `--bash-regex`, or a counter filter. Multiple selectors AND together.

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
| `--file <path>` | Touched file paths | Absolute paths use canonical/realpath then logical identity matching (see below). Substrings work too. |
| `--operation <op>` | Filters `--file` to a specific operation | One of `read`, `edit`, `write`, `grep`, `glob`. **Only valid with `--file`** and tied to the same matching access. |
| `--origin` | With `--file`, returns earliest matching transcript **write** evidence | Implies `--operation write`. Defaults to one result. Transcript evidence, **not** VCS creation history. |
| `--text <text>` / `--text-regex` | User/assistant text and thinking | Case-insensitive substring or regex. |
| `--intent-match <text>` / `--intent-regex` | Session intent sources (slug, first prompt token, first user message) | |
| `--bash <text>` / `--bash-regex` | Bash command inputs | Shorthand for finding Bash commands in match rows. Not counted by `--aggregate`; use `--tool Bash --input-match` for audits (see [Aggregation modes](#aggregation-modes)). |

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
| `--sort <mode>` | One of `session-newest` (default), `match-earliest`, `match-newest`, `project`. |
| `--last <n>` | Truncate after sorting. With `--origin`, defaults to 1. |

## Time and branch filters

| Flag | Description |
| --- | --- |
| `--branch <name>` | Git branch filter. |
| `--after <ISO>` / `--before <ISO>` | Date range. |
| `--since <duration>` | `30m`, `2h`, `1d`, `1w`. Mutually exclusive with `--after`. |

Date filters compare against each session's start time: a session that began before the cutoff is excluded even if its later activity falls inside the range.

## Aggregation modes

Default: full match rows with evidence. Two summary modes:

Both count matching tool calls, not occurrences of the text: `bun test && bun test` in one Bash call counts once, and a command that only mentions the text (for example, in a commit message) counts too.

### `--aggregate count-per-session`

Per-session rollup with `counts.tool_inputs` and a small `sample_matches` array. Useful for "how often did session X do Y" audits.

Requires `--tool`, `--input-match`, or `--input-regex`, and counts only the tool calls those flags match; `--bash` matches are not counted. For Bash audits use `--tool Bash --input-match '<text>'`: `--bash` alone is rejected, and `--tool Bash --bash '<text>'` counts every Bash call in the session.

### `--aggregate counters`

Named raw-input counters. Combine with `--counter NAME=text` or `--counter-regex NAME=regex` (repeatable). Counters match every tool call's raw input, so pass `--tool` to limit them to one tool. Add `--bucket day|week` to bucket by each session's start date (missing timestamps go to `unknown`). `--per-subagent` emits transcript-level rows instead of parent-session rollups.

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
```

## Follow-up from a result row

Pass `session_ref.project` to subsequent commands via `--claude-project`:

```bash
# A search row included:
#   "session_ref": { "session_id": "DA2738E3-...", "project": "-workspace-app--claude-worktrees-feature-a" }

cc-session-tool tools DA2738E3 --claude-project -workspace-app--claude-worktrees-feature-a
```

**Do not** derive `--project` paths from `project_path_guess` — it is display-only and not a stable handle.
