# cc-session-tool

A CLI tool for querying Claude Code session transcripts. Reads JSONL session files from `~/.claude/projects/` and compresses raw transcripts (50-120K tokens each) into focused JSON responses — designed for use by coding agents and scripts.

## Installation

```bash
bun install
```

## Usage

```bash
bun run dev <command> [session] [options]
```

Or compile to a standalone binary:

```bash
bun run build
./cc-session-tool <command> [session] [options]
```

### Session Identifiers

All commands except `list` require a `<session>` argument. Three forms are accepted:

| Form        | Example                                | Resolution                                             |
| ----------- | -------------------------------------- | ------------------------------------------------------ |
| Full UUID   | `DA2738E3-0ADE-40E7-B6AC-450F9CCE1B43` | Exact filename match                                   |
| UUID prefix | `DA2738E3`                             | Prefix match (must be unambiguous)                     |
| Slug        | `snuggly-floating-barto`               | Search across all `.jsonl` files (must be unambiguous) |

All session commands accept `--project <path>` to specify the project directory (defaults to CWD).

**Input validation:** Only `[a-zA-Z0-9-]` characters are accepted; all other inputs are rejected with exit code 2.

### Turn Numbering

All commands use consistent turn numbering:

- Each JSONL entry of type `user` or `assistant` gets the next sequential integer, starting at 1.
- Other entry types (`system`, `progress`, etc.) are excluded from numbering.
- When an assistant entry contains multiple content blocks (e.g., thinking + tool_use), they share the same turn number. The `block_index` field (0-indexed) disambiguates blocks within a turn.
- Turn numbers are consistent across all commands: turn 5 in `shape` is the same entry as turn 5 in `tools`, `tokens`, `messages`, `slice`, and `files`.

## Commands

### `list`

Index all sessions by reading metadata from the first few lines of each file.

```bash
cc-session-tool list [--project <path>] [--branch <name>] [--after <date>] [--before <date>] [--since <duration>] [--last <n>] [--min-lines <n>]
```

| Option        | Default | Description                                                    |
| ------------- | ------- | -------------------------------------------------------------- |
| `--branch`    | all     | Filter by git branch name                                      |
| `--after`     | —       | Sessions after ISO 8601 date (mutually exclusive with `--since`) |
| `--before`    | —       | Sessions before ISO 8601 date                                  |
| `--since`     | —       | Sessions from the last duration: `30m`, `2h`, `1d`, `1w` (mutually exclusive with `--after`) |
| `--last`      | all     | Return only the N most recent sessions                         |
| `--min-lines` | 0       | Sessions with at least N lines                                 |

**Output:** Sessions sorted by timestamp (newest first). Fields may be `null` for sessions with missing metadata. When `--last` is used, `_meta.total` reflects the pre-limit count and `_meta.hasMore` is `true` if results were truncated.

```json
{
  "ok": true,
  "data": [
    {
      "session_id": "DA2738E3-0ADE-40E7-B6AC-450F9CCE1B43",
      "branch": "feature/auth",
      "timestamp": "2026-03-07T22:31:26.359Z",
      "version": "2.1.71",
      "lines": 342,
      "slug": "snuggly-floating-barto"
    }
  ],
  "_meta": { "total": 1, "returned": 1, "hasMore": false }
}
```

---

### `shape <session>`

Turn-by-turn skeleton with summary stats. Compresses a full session into a table of contents.

```bash
cc-session-tool shape <session> [--project <path>]
```

**Output:**

```json
{
  "ok": true,
  "data": {
    "session_id": "DA2738E3-...",
    "turns": [
      { "n": 1, "role": "user", "type": "user", "block_index": 0 },
      { "n": 2, "role": "assistant", "type": "tool_use", "block_index": 0, "tools": ["Grep"] },
      { "n": 3, "role": "user", "type": "tool_result", "block_index": 0 },
      { "n": 4, "role": "assistant", "type": "thinking", "block_index": 0 },
      { "n": 4, "role": "assistant", "type": "text", "block_index": 1 }
    ],
    "summary": {
      "total_turns": 42,
      "user_messages": 8,
      "tool_calls": { "Grep": 12, "Read": 8, "Edit": 5, "Bash": 4 },
      "first_edit_turn": 15,
      "duration_minutes": 38.2
    }
  },
  "_meta": { "total": 5, "returned": 5, "hasMore": false }
}
```

**Turn types:**

| Role        | Type          | Description                              |
| ----------- | ------------- | ---------------------------------------- |
| `user`      | `user`        | User text message                        |
| `user`      | `tool_result` | Tool result returned to assistant        |
| `user`      | `image`       | Image attachment                         |
| `assistant` | `text`        | Assistant text response                  |
| `assistant` | `thinking`    | Thinking/reasoning block                 |
| `assistant` | `tool_use`    | Tool invocation (includes `tools` array) |

**`block_index`:** 0-indexed position within the turn's content blocks. When an assistant turn has multiple non-tool blocks (e.g., thinking + text), each gets a separate row with incrementing `block_index`. Assistant turns with `tool_use` blocks are collapsed into a single row with `block_index: 0`.

**Summary fields:**

| Field              | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `total_turns`      | Count of user + assistant entries                                   |
| `user_messages`    | Count of user entries                                               |
| `tool_calls`       | Map of tool name to call count                                      |
| `first_edit_turn`  | Turn of first `Edit` or `Write` call (`null` if none)               |
| `duration_minutes` | Minutes between first and last entry (`null` if missing timestamps) |

---

### `tools <session>`

Tool call log with condensed input summaries and outcome detection.

```bash
cc-session-tool tools <session> [--project <path>] [--name <tool>] [--failed] [--turn <N|N-M>]
```

**Output:**

```json
{
  "ok": true,
  "data": {
    "session_id": "DA2738E3-...",
    "tool_calls": [
      {
        "turn": 3,
        "tool": "Grep",
        "input_summary": "pattern='AuthReducer' path='Sources/'",
        "outcome": "empty",
        "duration_ms": 450
      },
      {
        "turn": 7,
        "tool": "Read",
        "input_summary": "file='AuthReducer.swift'",
        "outcome": "success (245 lines)",
        "duration_ms": 120
      }
    ]
  },
  "_meta": { "total": 2, "returned": 2, "hasMore": false }
}
```

**Input summary formats:**

| Tool           | Summary Format                                  |
| -------------- | ----------------------------------------------- |
| `Grep`         | `pattern='...' path='...'`                      |
| `Read`         | `file='<basename>' offset=N limit=N`            |
| `Edit`         | `file='<basename>' old=(N chars) new=(N chars)` |
| `Write`        | `file='<basename>' (N chars)`                   |
| `Bash`         | First 80 chars of command                       |
| `Glob`         | `pattern='...' path='...'`                      |
| `Agent`/`Task` | `prompt='...'` (first 80 chars)                 |
| `WebFetch`     | `url='...'`                                     |
| `WebSearch`    | `query='...'`                                   |
| Other          | First 80 chars of JSON-encoded input            |

**Outcome values:**

| Outcome             | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| `success`           | Non-empty content                                     |
| `success (N lines)` | N lines of content                                    |
| `empty`             | Empty content                                         |
| `error: <message>`  | Error (first 60 chars)                                |
| `no_result`         | No matching `tool_result` found (interrupted session) |

**`duration_ms`:** Milliseconds between assistant entry and corresponding tool_result. `null` if timestamps are missing.

---

### `files <session>`

Files touched in a session, grouped by file path or chronologically by turn.

```bash
cc-session-tool files <session> [--project <path>] [--group-by <file|turn>] [--turn <N|N-M>] [--operation <op>]
```

| Option        | Default | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `--group-by`  | `file`  | `file` (one entry per unique path) or `turn` (chronological) |
| `--turn`      | all     | Turn number `N` or range `N-M`                     |
| `--operation` | all     | Filter by operation: `read`, `edit`, `write`, `grep`, `glob` |

**Output (group-by=file, default):**

```json
{
  "ok": true,
  "data": {
    "session_id": "DA2738E3-...",
    "group_by": "file",
    "files": [
      {
        "path": "/Users/me/project/src/auth.ts",
        "operations": ["read", "edit"],
        "turns": [6, 8, 12, 18],
        "errored": false
      },
      {
        "path": "/Users/me/project/src/auth.test.ts",
        "operations": ["read", "write"],
        "turns": [10, 22],
        "errored": false
      }
    ]
  },
  "_meta": { "total": 2, "returned": 2, "hasMore": false }
}
```

**Output (group-by=turn):**

```json
{
  "ok": true,
  "data": {
    "session_id": "DA2738E3-...",
    "group_by": "turn",
    "accesses": [
      { "path": "/Users/me/project/src/auth.ts", "operation": "read", "turn": 6, "errored": false },
      { "path": "/Users/me/project/src/auth.ts", "operation": "edit", "turn": 8, "errored": true }
    ]
  },
  "_meta": { "total": 2, "returned": 2, "hasMore": false }
}
```

**Notes:**

- Extracts full file paths from tool inputs (`Read`, `Edit`, `Write` use `file_path`; `Grep`, `Glob` use `path`).
- `Grep`/`Glob` calls without a `path` argument are excluded (they search CWD implicitly).
- `Bash` calls are excluded — file references in shell commands are not parsed.
- Files are sorted by first turn accessed. `errored` is `true` if any operation on that file errored.

---

### `tokens <session>`

Per-turn token usage from assistant entries.

```bash
cc-session-tool tokens <session> [--project <path>] [--cumulative]
```

**Output:**

```json
{
  "ok": true,
  "data": {
    "session_id": "DA2738E3-...",
    "turns": [
      {
        "n": 2,
        "input": 20170,
        "output": 11,
        "cache_read": 0,
        "cache_create": 20170
      },
      {
        "n": 4,
        "input": 5995,
        "output": 380,
        "cache_read": 20170,
        "cache_create": 5995
      }
    ],
    "totals": {
      "input": 142000,
      "output": 38000,
      "cache_read": 890000,
      "cache_create": 45000
    }
  },
  "_meta": { "total": 2, "returned": 2, "hasMore": false }
}
```

**Notes:**

- Only assistant entries appear in `turns` (they carry `message.usage`). User turns are counted but not listed.
- `totals` is always non-cumulative, even with `--cumulative`.
- With `--cumulative`, each field in `turns` is a running total.

**Token fields:**

| Field          | Source                                      |
| -------------- | ------------------------------------------- |
| `input`        | `message.usage.input_tokens`                |
| `output`       | `message.usage.output_tokens`               |
| `cache_read`   | `message.usage.cache_read_input_tokens`     |
| `cache_create` | `message.usage.cache_creation_input_tokens` |

---

### `messages <session>`

Filtered, truncated message content for drilling into specific parts of a session.

```bash
cc-session-tool messages <session> [--project <path>] [--role <user|assistant>] [--type <block_type>] [--turn <N|N-M>] [--max-content <chars>]
```

| Option          | Default | Description                                                         |
| --------------- | ------- | ------------------------------------------------------------------- |
| `--role`        | all     | Filter by `user` or `assistant`                                     |
| `--type`        | all     | Filter by block type: `text`, `thinking`, `tool_use`, `tool_result` |
| `--turn`        | all     | Turn number `N` or range `N-M`                                      |
| `--max-content` | 200     | Truncate text/thinking content to N chars                           |

**Output:**

```json
{
  "ok": true,
  "data": [
    {
      "n": 1,
      "role": "user",
      "content": [{ "type": "text", "text": "Implement the feature..." }]
    },
    {
      "n": 2,
      "role": "assistant",
      "content": [
        { "type": "thinking", "text": "I need to...[truncated, 4832 chars]" },
        { "type": "tool_use", "name": "Grep", "id": "toolu_abc123" }
      ]
    }
  ],
  "_meta": { "total": 2, "returned": 2, "hasMore": false }
}
```

**Notes:**

- Content is truncated with `...[truncated, N chars]` suffix.
- `tool_use` blocks preserve `name` and `id` (not truncated).
- `tool_result` blocks preserve `tool_use_id` and `is_error`, with truncated content.

---

### `slice <session>`

Raw entries for a turn range. The escape hatch for getting full content of specific turns.

```bash
cc-session-tool slice <session> --turn <N|N-M> [--project <path>] [--max-content <chars>]
```

| Option          | Description                                           |
| --------------- | ----------------------------------------------------- |
| `--turn`        | Turn range (**required**)                             |
| `--max-content` | Truncate text/thinking/tool_result content to N chars |

**Notes:**

- Without `--max-content`, entries are output as-is (full content preserved).
- Output is wrapped in the standard `{ ok, data, _meta }` envelope where `data` is an array of raw session entries.

## Composition Examples

### Quick access to recent sessions

```bash
# Last 5 sessions
cc-session-tool list --last 5

# Sessions from the last day
cc-session-tool list --since 1d

# Last 3 sessions on a specific branch
cc-session-tool list --branch feature/auth --last 3
```

### Navigation analysis before first edit

```bash
# Find the session
cc-session-tool list --branch feature/auth

# See the structure -- note first_edit_turn in summary
cc-session-tool shape DA2738E3

# Extract all tool calls before the first edit (say turn 15)
cc-session-tool tools DA2738E3 --turn 1-14
```

### Failed Grep patterns

```bash
cc-session-tool tools <session> --name Grep --failed
```

### Drill into a specific turn

```bash
# Full content of turns around the first edit
cc-session-tool slice DA2738E3 --turn 14-16

# Just the assistant's reasoning
cc-session-tool messages DA2738E3 --role assistant --type thinking --turn 14-16
```

### What files did a session touch?

```bash
# All files, grouped by path
cc-session-tool files DA2738E3

# Just edits
cc-session-tool files DA2738E3 --operation edit

# Chronological log of all file accesses
cc-session-tool files DA2738E3 --group-by turn
```

### Token consumption comparison

```bash
cc-session-tool tokens <planning-session>
cc-session-tool tokens <implementation-session>
# Compare input/output ratios and cache_read/cache_create patterns
```

## Output Format

All commands return JSON with a consistent envelope:

```json
{
  "ok": true,
  "data": { ... },
  "_meta": { "total": 1, "returned": 1, "hasMore": false }
}
```

Errors:

```json
{
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "..." }
}
```

### Exit Codes

| Code | Meaning                        |
| ---- | ------------------------------ |
| 0    | Success                        |
| 1    | Format error / terminated      |
| 2    | Invalid arguments or ID format |
| 3    | Not found                      |

## Testing

```bash
bun test
```
