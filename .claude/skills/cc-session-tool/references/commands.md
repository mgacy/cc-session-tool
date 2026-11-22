# cc-session-tool command reference

Condensed flag and output reference for every subcommand. For the most authoritative spec, run `cc-session-tool <command> --help`. The `search` command has its own deep dive in `search.md` because it's the most complex.

All session-scoped commands accept:
- a positional session identifier (UUID, prefix, or slug)
- `--project <path>` (defaults to CWD) **or** `--claude-project <raw-basename>` (mutually exclusive)
- colon notation `<session>:<agent-id>` to target a subagent (except for `subagents` itself)

All commands emit `{ ok, data, _meta }` (or `{ ok: false, error }`).

Arguments are parsed strictly: unknown or misplaced flags, repeated flags, missing or empty values, and extra or missing positionals fail with `INVALID_ARGS` (exit 2) before any I/O, and the message lists the command's supported flags. Flags follow the subcommand name. A value starting with `--` must use `--flag=value`. Booleans accept `--x`, `--no-x`, `--x=true` and `--x=false` (not `--x false`).

## Table of contents

- [list](#list)
- [projects](#projects)
- [summary](#summary)
- [shape](#shape)
- [tools](#tools)
- [files](#files)
- [tokens](#tokens)
- [messages](#messages)
- [slice](#slice)
- [subagents](#subagents)

---

## list

Index sessions by reading metadata from the first few lines of each JSONL file. Scoped to the logical project of `--project` (CWD by default), including associated Claude-managed worktree transcript directories.

```bash
cc-session-tool list [flags]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--project <path>` | CWD | Logical project. Scoped runs include associated Claude worktree transcript dirs. |
| `--main-only` | false | With scoped `--project`, skip worktrees. Incompatible with `--all-projects`. |
| `--all-projects` | false | List sessions from every top-level Claude project directory under `~/.claude/projects`. |
| `--project-glob <pat>` | — | With `--all-projects`, filter by raw Claude project basename or display-only `project_path_guess`. Supports `*` and `?`. |
| `--intent-match <text>` | — | Filter session intent sources (slug, first prompt token, first user message) by case-insensitive substring. |
| `--intent-regex <regex>` | — | Regex equivalent. Mutually exclusive with `--intent-match`. |
| `--branch <name>` | all | Filter by git branch. |
| `--after <ISO>` | — | Sessions after this ISO 8601 date. |
| `--before <ISO>` | — | Sessions before this date. |
| `--since <duration>` | — | Sessions in the last duration: `30m`, `2h`, `1d`, `1w`. Mutually exclusive with `--after`. |
| `--last <n>` | all | Most recent N sessions. |
| `--min-lines <n>` | 0 | Sessions with at least N lines. |
| `--include-subagents` | false | Adds `subagent_count` per session. |

`list` does not accept `--claude-project`. Pick the scoping row that matches what you have:

| What you have | Use | If the value is wrong |
| --- | --- | --- |
| The checkout or worktree path, e.g. `<repo>/.claude/worktrees/<name>` (**preferred**) | `list --project <path>` | `NOT_FOUND` |
| Only a raw Claude basename: the `project` / `session_ref.project` field of a `search`, `list` or `projects` row | `list --all-projects --project-glob <basename>` | `ok:true` with empty `data` and `_meta.projects_scanned: 0`. Confirm `_meta.projects_scanned === 1` before trusting an empty result. `_meta.skipped_projects` lists every other project, so the response grows with the number of projects. |
| A session to inspect, plus its raw basename | `shape`, `summary`, `tools`, `files`, `tokens`, `messages`, `slice` or `subagents` with `<session> --claude-project <basename>` | `NOT_FOUND` |

- `--claude-project` is accepted only by the session commands in the last row; `list` and `search` reject it, and `search` scopes the same way as `list`.
- Don't turn `project_path_guess` into a `--project` value: it is display-only and lossy. With only a row's fields, use the raw-basename row. A repo-root path also covers that repo's Claude worktrees (`--main-only` skips them). A worktree path covers that worktree.

Output rows are sorted newest first. When multiple project contexts are scanned, rows include `project`, `project_path_guess` (display only), `project_role` (`main` / `worktree` / `global`), and `session_ref` for stable follow-up. `_meta.included_projects` records what was scanned.

---

## projects

Summarize Claude project transcript directories and expose stable raw project handles for use with `--claude-project`.

```bash
cc-session-tool projects [--glob <pattern>] [--project <path>]
```

Without `--project`, scans every top-level Claude project directory under `~/.claude/projects`. With `--project`, returns the main project plus associated worktrees. Sorted by raw `project` basename.

Each row: `project` (raw Claude basename — pass to `--claude-project`), `project_path_guess` (display only), `project_role`, `session_count`, `total_lines`, `first_session_at`, `last_session_at`.

---

## summary

One-call triage summary. Use this first when investigating a session — it combines what you'd otherwise gather from `shape`, `tools`, `files`, and `messages`.

```bash
cc-session-tool summary <session>
```

Returns: model, timing, first prompt snippet, last assistant text snippet, tool counts, file access counts, subagent metadata. When following a `search`/`list` row, pass `session_ref.project` via `--claude-project`.

---

## shape

Turn-by-turn skeleton with summary stats — a table of contents for a session.

```bash
cc-session-tool shape <session>
```

`data.turns` is an array of `{ n, role, type, block_index, tools? }`. `data.summary` includes `total_turns`, `user_messages`, `tool_calls` (name→count), `first_edit_turn` (turn of first `Edit`/`Write`, or `null`), `duration_minutes`.

Turn types: user/`user|tool_result|image`, assistant/`text|thinking|tool_use`. Assistant turns with multiple non-tool blocks emit one row per block (`block_index` increments); tool_use blocks collapse into one row.

---

## tools

Tool call log with condensed input summaries and outcome detection.

```bash
cc-session-tool tools <session> [flags]
```

| Flag | Description |
| --- | --- |
| `--name <tool>` | Exact tool name filter. |
| `--name-match <text>` | Substring tool-name filter. Mutually exclusive with `--name`. |
| `--input-match <text>` | Match raw structured tool input by case-insensitive substring (sees values omitted/truncated in `input_summary`). |
| `--input-regex <regex>` | Regex equivalent. Mutually exclusive with `--input-match`. |
| `--failed` | Only failed calls. |
| `--turn <N\|N-M>` | Single turn or range. |

Each entry: `turn`, `tool`, `input_summary`, `outcome`, `duration_ms`.

**Input summary format by tool:**

| Tool | Summary |
| --- | --- |
| `Grep` | `pattern='...' path='...'` |
| `Read` | `file='<basename>' offset=N limit=N` |
| `Edit` | `file='<basename>' old=(N chars) new=(N chars)` |
| `Write` | `file='<basename>' (N chars)` |
| `Bash` | First 80 chars of command |
| `Glob` | `pattern='...' path='...'` |
| `Agent`/`Task` | `prompt='...'` (first 80 chars) |
| `WebFetch` | `url='...'` |
| `WebSearch` | `query='...'` |
| Other | First 80 chars of JSON-encoded input |

**Outcome:** `success`, `success (N lines)`, `empty`, `error: <message>`, or `no_result` (interrupted session).

`duration_ms` is the gap between the assistant entry and its matching tool_result; `null` if timestamps are missing.

---

## files

Files touched in a session.

```bash
cc-session-tool files <session> [--group-by file|turn] [--turn <N|N-M>] [--operation read|edit|write|grep|glob]
```

Default `--group-by file` returns one entry per unique path: `path`, `operations` (deduped), `turns` (sorted), `errored` (any op errored).

`--group-by turn` returns the chronological log: `path`, `operation`, `turn`, `errored` per access.

Notes:
- Paths come from `Read`/`Edit`/`Write.file_path` and `Grep`/`Glob.path`.
- `Grep`/`Glob` calls without an explicit `path` are excluded (they search CWD implicitly).
- `Bash` calls are excluded — shell file references are not parsed.

---

## tokens

Per-turn token usage from assistant entries.

```bash
cc-session-tool tokens <session> [--cumulative]
```

Each turn entry: `n`, `input`, `output`, `cache_read`, `cache_create`. `data.totals` is always non-cumulative even with `--cumulative`. With `--cumulative`, each `turns[i]` field is a running total.

Only assistant entries appear in `turns` (they carry `message.usage`). User turns are counted but not listed.

---

## messages

Filtered, truncated message content for drilling into specific parts of a session.

```bash
cc-session-tool messages <session> [flags]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--role <user\|assistant>` | all | Role filter. |
| `--type <text\|thinking\|tool_use\|tool_result>` | all | Block type filter. |
| `--turn <N\|N-M>` | all | Turn or range. |
| `--max-content <chars>` | 200; unbounded for a single `--turn` | Truncate text/thinking content (suffix `...[truncated, N chars]`). |

`tool_use` blocks keep `name` and `id` (not truncated). `tool_result` blocks keep `tool_use_id` and `is_error`, with truncated content.

---

## slice

Raw entries for a turn range. Escape hatch when you need full content.

```bash
cc-session-tool slice <session> --turn <N|N-M> [--max-content <chars>]
```

- `--turn` is **required**.
- Without `--max-content`, content is preserved verbatim.
- Output: `data = { session_id, agent_id, entries }`. `agent_id` is set when targeting a subagent via colon notation.

Use sparingly — raw entries are large. Use `shape` / `messages` first to find the right range.

---

## subagents

List subagents spawned during a session. Reads metadata from companion `agent-<id>.meta.json` files.

```bash
cc-session-tool subagents <session>
```

Each entry: `agent_id`, `agent_type`, `description`, `lines`, `timestamp`. Sorted by timestamp (newest first); null timestamps sort to end. `agent_type` and `description` are `null` if the meta file is missing.

Use the returned `agent_id` with colon notation in any other session-scoped command: `shape DA2738E3:a8361bc`. Colon notation is rejected by `subagents` itself (no nested subagents).
