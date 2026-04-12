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

Single-file CLI (`index.ts`) using `citty` for command parsing. All types, helpers, and commands live in one file. Types and pure helpers are `export`ed for unit testing.

### Subcommands

| Command | Purpose |
|---------|---------|
| `list` | Index all sessions with metadata (branch, timestamp, slug) |
| `shape` | Turn-by-turn skeleton with summary stats (tool counts, duration, first edit) |
| `tools` | Tool call log with condensed input summaries and outcomes |
| `files` | Files touched in a session, grouped by path or turn |
| `tokens` | Per-turn token usage timeline (optional cumulative mode) |
| `messages` | Filtered, truncated message content by role/type/turn |
| `slice` | Raw entries for a turn range |
| `search` | Find sessions matching structured queries (tool, file, text, bash filters) |
| `subagents` | List subagents for a session with metadata |

All session-scoped commands accept a positional session identifier (UUID, UUID prefix, or slug) and an optional `--project` flag (defaults to CWD). Subagent sessions can be targeted using colon notation: `<session>:<agent-id>` (e.g., `DA2738E3:a8361bc`).

### Session Resolution

Sessions are resolved in order: exact UUID filename match, UUID prefix match, then slug search (first 8KB of each JSONL file). Ambiguous matches are errors. Input is validated against `[a-zA-Z0-9-]` to prevent path traversal.

**Subagent targeting:** Use colon notation `<session>:<agent-id>` to address a subagent session (e.g., `DA2738E3:a8361bc`). The session part is resolved normally, then the subagent file is located at `<session-dir>/subagents/agent-<agent-id>.jsonl`. Agent IDs allow underscores: `[a-zA-Z0-9_-]+`. All session-scoped commands support this notation. The `subagents` command lists available agent IDs for a given session.

### Key Design Decisions

1. All output uses a `{ ok, data, _meta }` / `{ ok, error }` JSON envelope
2. Distinct exit codes: 0=success, 1=format/terminated, 2=invalid args/ID, 3=not found
3. Errors are thrown via `cliError(code, msg)` and caught at the command handler level
4. Content truncation uses `"...[truncated, N chars]"` suffix

### Testing

Tests in `index.test.ts` use `bun:test`. Two categories:
- **Unit tests**: Import exported helpers (`parseTurnRange`, `inputSummary`, `determineOutcome`, etc.) and test pure logic
- **Integration tests**: Create a temp fixture dir with a fake JSONL session, run the CLI via `Bun.spawn`, and assert on parsed JSON output. Fixture is created in `beforeAll` and cleaned up in `afterAll`.
