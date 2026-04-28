# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A CLI tool that queries Claude Code session transcripts stored as JSONL files in `~/.claude/projects/`. Built for coding agents to inspect session history programmatically — all output is machine-readable JSON.

## Commands

```bash
bun install          # Install dependencies
bun run index.ts     # Run the CLI (or: bun run dev)
bun test             # Run all tests
bun test --filter "shape"  # Run tests matching a pattern
bun build --compile index.ts --outfile cc-session-tool  # Compile to binary
bun run release <major|minor|patch>  # Bump VERSION, tag, push (triggers CI release)
```

## Bun Runtime

Default to Bun instead of Node.js:
- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of jest/vitest
- `bun install` instead of npm/yarn/pnpm
- `Bun.file()` / `Bun.spawn()` over Node equivalents

## Architecture

CLI entrypoint and command wiring live in `index.ts` using `citty`. Shared transcript, project-selection, and search primitives live under `src/` and are exported for unit testing.

### Subcommands

| Command | Purpose |
|---------|---------|
| `list` | Index sessions with metadata; scoped lists include associated Claude worktrees by default and support `--main-only` |
| `projects` | Summarize Claude project transcript directories and expose raw project handles |
| `shape` | Turn-by-turn skeleton with summary stats (tool counts, duration, first edit) |
| `summary` | One-call triage summary for a session |
| `tools` | Tool call log with condensed input summaries and outcomes |
| `files` | Files touched in a session, grouped by path or turn |
| `tokens` | Per-turn token usage timeline (optional cumulative mode) |
| `messages` | Filtered, truncated message content by role/type/turn |
| `slice` | Raw entries for a turn range |
| `search` | Find sessions matching structured queries (tool, input, file, text, bash filters), scoped to the logical project plus associated Claude worktrees by default |
| `subagents` | List subagents for a session with metadata |

All session-scoped commands accept a positional session identifier (UUID, UUID prefix, or slug) and an optional `--project` flag (defaults to CWD). They also accept `--claude-project <project>` for stable follow-up from search/list/projects rows that expose raw Claude project basenames through `project` or `session_ref.project`; do not use `project_path_guess` as a follow-up handle. `--project` and `--claude-project` are mutually exclusive. Subagent sessions can be targeted using colon notation: `<session>:<agent-id>` (e.g., `DA2738E3:a8361bc`).

The `list` and `search` commands are agent-first and worktree-aware by default. A scoped query from the logical project checkout includes associated Claude-managed worktree transcript directories. Use `list --main-only` only when you intentionally want to ignore worktree sessions. Search compares absolute main-tree file queries to worktree-local accesses by exact canonical path candidates first, then shared project-relative identity. Use `search --file <absolute-main-tree-path> --operation write` as the primary workflow for finding worktree writes to the same logical file; use `--all-projects` for broad audits, not routine worktree lookup.

In `search --all-projects`, an explicit `--project <path>` is a query identity anchor for absolute file matching only. It must not be treated as a scan limit, and without it the command must not silently use CWD or `project_path_guess` as the authoritative project root for unrelated projects.

Use `search --file <path> --operation <read|edit|write|grep|glob>` to bind file-operation filtering to the same matching file access. Use `--origin` to return the earliest matching transcript write evidence for a file; this is transcript evidence, not VCS creation history. Use `--sort session-newest|match-earliest|match-newest|project` for deterministic ordering.

Use `search --tool <name> --input-match <pattern>` or `tools --input-match <pattern>` to match raw structured tool inputs, including values omitted or truncated in `input_summary`. Add `--aggregate count-per-session` for per-session audit counts, or `--aggregate counters --counter name=pattern --bucket day|week` for named audit tables. `--project-glob` is valid only with `--all-projects` on `search` and `list`; it matches raw Claude project basenames and display-only `project_path_guess` strings, not filesystem files.

### Session Resolution

Sessions are resolved in order within the selected Claude project directory: exact UUID filename match, UUID prefix match, then slug search (first 8KB of each JSONL file). Ambiguous matches are errors. Session input is validated against `[a-zA-Z0-9-]`, agent IDs against `[a-zA-Z0-9_-]`, and `--claude-project` as a basename only to prevent path traversal.

**Subagent targeting:** Use colon notation `<session>:<agent-id>` to address a subagent session (e.g., `DA2738E3:a8361bc`). The session part is resolved normally, then the subagent file is located at `<session-dir>/subagents/agent-<agent-id>.jsonl`. Agent IDs allow underscores: `[a-zA-Z0-9_-]+`. All session-scoped commands except `subagents` support this notation. The `subagents` command lists available agent IDs for a given session.

### Key Design Decisions

1. All output uses a `{ ok, data, _meta }` / `{ ok, error }` JSON envelope
2. Distinct exit codes: 0=success, 1=format/terminated, 2=invalid args/ID, 3=not found
3. Errors are thrown via `cliError(code, msg)` and caught at the command handler level
4. Content truncation uses `"...[truncated, N chars]"` suffix
5. `project_path_guess` is display metadata only; raw `project` / `session_ref.project` is the stable Claude project identity for follow-up commands.

### Testing

Tests in `index.test.ts` use `bun:test`. Two categories:
- **Unit tests**: Import exported helpers (`parseTurnRange`, `inputSummary`, `determineOutcome`, etc.) and test pure logic
- **Integration tests**: Create a temp fixture dir with a fake JSONL session, run the CLI via `Bun.spawn`, and assert on parsed JSON output. Fixture is created in `beforeAll` and cleaned up in `afterAll`.
