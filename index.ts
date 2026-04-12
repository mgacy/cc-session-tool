#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import { homedir } from 'os';
import { join, basename } from 'path';
import { readdirSync, existsSync } from 'fs';

export const VERSION = '0.1.0';

// ============================================================================
// Types
// ============================================================================

export type CliResult<T> = {
  ok: true;
  data: T;
  _meta: ResponseMeta;
} | {
  ok: false;
  error: { code: string; message: string };
};

export type ResponseMeta = {
  total: number;
  returned: number;
  hasMore: boolean;
};

/** A parsed JSONL entry from a Claude session transcript. */
export type SessionEntry = {
  type: 'user' | 'assistant' | 'system' | 'summary' | (string & {});
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  version?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    usage?: TokenUsage;
  };
  slug?: string;
};

export type ContentBlock = {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'document' | (string & {});
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | ContentBlock[];
};

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type ListSession = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  version: string | null;
  lines: number;
  slug: string | null;
};

export type ShapeRow = {
  n: number;
  role: 'user' | 'assistant';
  type: string;
  block_index: number;
  tools?: string[];
};

export type ShapeResult = {
  session_id: string;
  turns: ShapeRow[];
  summary: {
    total_turns: number;
    user_messages: number;
    tool_calls: Record<string, number>;
    first_edit_turn: number | null;
    duration_minutes: number | null;
  };
};

export type ToolCall = {
  turn: number;
  tool: string;
  input_summary: string;
  outcome: string;
  duration_ms: number | null;
};

export type ToolsResult = {
  session_id: string;
  tool_calls: ToolCall[];
};

export type TokenTurn = {
  n: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
};

export type TokensResult = {
  session_id: string;
  turns: TokenTurn[];
  totals: {
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
  };
};

export type MessageEntry = {
  n: number;
  role: 'user' | 'assistant';
  content: ContentBlock[];
};

export type FileAccess = {
  path: string;
  operation: 'read' | 'edit' | 'write' | 'grep' | 'glob';
  turn: number;
  errored: boolean;
};

export type FileEntry = {
  path: string;
  operations: string[];
  turns: number[];
  errored: boolean;
};

export type FilesResult = {
  session_id: string;
  group_by: 'file' | 'turn';
  files?: FileEntry[];
  accesses?: FileAccess[];
};

export type SearchMatch = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  slug: string | null;
  matches: {
    tools: string[];      // distinct tool names that matched --tool
    files: string[];      // distinct file paths that matched --file
    turns: number[];      // union of all turn numbers where any filter matched
  };
};

// ============================================================================
// Error Codes
// ============================================================================

export const ERROR_CODES = {
  INVALID_ARGS: { code: 'INVALID_ARGS', exitCode: 2 },
  INVALID_ID: { code: 'INVALID_ID', exitCode: 2 },
  NOT_FOUND: { code: 'NOT_FOUND', exitCode: 3 },
  FORMAT_ERROR: { code: 'FORMAT_ERROR', exitCode: 1 },
  TERMINATED: { code: 'TERMINATED', exitCode: 1 }
} as const;

type ErrorCode = keyof typeof ERROR_CODES;

// ============================================================================
// Response Helpers
// ============================================================================

export function success<T>(data: T, meta: ResponseMeta): CliResult<T> {
  return { ok: true, data, _meta: meta };
}

export function failure(errorCode: ErrorCode, message: string): CliResult<never> {
  return { ok: false, error: { code: ERROR_CODES[errorCode].code, message } };
}

function output<T>(result: CliResult<T>): void {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const code = Object.values(ERROR_CODES).find(e => e.code === result.error.code);
    process.exit(code?.exitCode ?? 1);
  }
}

function meta(total: number, returned: number): ResponseMeta {
  return { total, returned, hasMore: returned < total };
}

export class CliError extends Error {
  readonly errorCode: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.errorCode = code;
    this.name = 'CliError';
  }
}

function cliError(code: ErrorCode, message: string): CliError {
  return new CliError(code, message);
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

function handleCommandError(err: unknown): void {
  if (isCliError(err)) {
    output(failure(err.errorCode, err.message));
  } else {
    const message = err instanceof Error ? err.message : String(err);
    output(failure('FORMAT_ERROR', `Internal error: ${message}`));
  }
}

// ============================================================================
// Signal Handling
// ============================================================================

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    output(failure('TERMINATED', `Received ${signal}`));
  });
}

// ============================================================================
// Session Helpers
// ============================================================================

/**
 * Convert an absolute project path to the Claude projects directory.
 * /Users/jane/foo → ~/.claude/projects/-Users-jane-foo
 */
export function resolveClaudeProjectDir(projectPath: string): string {
  const stripped = projectPath.startsWith('/') ? projectPath.slice(1) : projectPath;
  const dirName = '-' + stripped.replace(/\//g, '-');
  const claudeDir = join(homedir(), '.claude', 'projects', dirName);
  if (!existsSync(claudeDir)) {
    throw cliError('NOT_FOUND', `Claude project directory not found: ${claudeDir}`);
  }
  return claudeDir;
}

/**
 * Resolve a session file from a UUID, UUID prefix, or slug.
 * Validates input against path traversal.
 */
export async function resolveSessionFile(claudeDir: string, input: string): Promise<string> {
  if (!input) {
    throw cliError('INVALID_ARGS', 'Session ID is required');
  }
  if (!/^[a-zA-Z0-9-]+$/.test(input)) {
    throw cliError('INVALID_ID', 'Invalid session ID -- only alphanumeric characters and hyphens allowed');
  }

  // Try UUID/prefix match
  const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl') && f.startsWith(input));
  if (files.length === 1) return join(claudeDir, files[0]!);
  if (files.length > 1) {
    throw cliError('INVALID_ID', `Ambiguous session ID prefix '${input}' -- matches ${files.length} sessions`);
  }

  // Try slug match - search for "slug":"<input>" in all jsonl files
  const allFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
  const slugPattern = `"slug":"${input}"`;
  const slugMatches: string[] = [];
  for (const f of allFiles) {
    try {
      const filePath = join(claudeDir, f);
      const chunk = await Bun.file(filePath).slice(0, 8192).text();
      if (chunk.includes(slugPattern)) {
        slugMatches.push(filePath);
      }
    } catch {
      // skip unreadable files during slug search
    }
  }
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    throw cliError('INVALID_ID', `Ambiguous slug '${input}' -- matches ${slugMatches.length} sessions`);
  }

  throw cliError('NOT_FOUND', `No session found matching '${input}'`);
}

/** Parse a JSONL session file into an array of entries. Skips malformed lines. */
export async function parseSessionLines(filePath: string): Promise<SessionEntry[]> {
  const text = await Bun.file(filePath).text();
  const entries: SessionEntry[] = [];
  let nonEmptyCount = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    nonEmptyCount++;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed &&
          typeof (parsed as Record<string, unknown>).type === 'string') {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      // skip malformed lines
    }
  }
  if (nonEmptyCount > 0 && entries.length === 0) {
    throw cliError('FORMAT_ERROR', 'Session file contains no valid entries');
  }
  return entries;
}

/** Filter to user/assistant entries only. */
export function userAssistantEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(e => e.type === 'user' || e.type === 'assistant');
}

/** Resolve a session from CLI args, returning the session ID and filtered entries. */
export type ResolvedSession = {
  sessionId: string;
  entries: SessionEntry[];
};

export async function resolveSession(args: { session: string; project?: string }): Promise<ResolvedSession> {
  const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
  const sessionFile = await resolveSessionFile(claudeDir, args.session);
  const sessionId = basename(sessionFile, '.jsonl');
  const allEntries = await parseSessionLines(sessionFile);
  const entries = userAssistantEntries(allEntries);
  return { sessionId, entries };
}

/** Parse turn range "N" or "N-M". Returns {start, end}. */
export function parseTurnRange(input: string): { start: number; end: number } {
  const rangeMatch = input.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]!, 10);
    const end = parseInt(rangeMatch[2]!, 10);
    if (start > end) {
      throw cliError('INVALID_ARGS', `Invalid turn range -- start (${start}) is greater than end (${end})`);
    }
    return { start, end };
  }
  const singleMatch = input.match(/^(\d+)$/);
  if (singleMatch) {
    const n = parseInt(singleMatch[1]!, 10);
    return { start: n, end: n };
  }
  throw cliError('INVALID_ARGS', `Invalid turn range '${input}' -- expected N or N-M`);
}

/** Truncate text with "...[truncated, N chars]" suffix. */
export function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `...[truncated, ${text.length} chars]`;
}

/** Condensed tool input summary per tool type. */
export function inputSummary(name: string, input: Record<string, unknown>): string {
  const inp = input as Record<string, any>;
  switch (name) {
    case 'Grep':
      return `pattern='${inp.pattern ?? ''}' ${inp.path ? `path='${inp.path}'` : ''}`.trim();
    case 'Read':
      return `file='${basename(inp.file_path ?? '')}' ${inp.offset != null ? `offset=${inp.offset}` : ''} ${inp.limit != null ? `limit=${inp.limit}` : ''}`.trim().replace(/\s+/g, ' ');
    case 'Edit':
      return `file='${basename(inp.file_path ?? '')}' old=(${(inp.old_string ?? '').length} chars) new=(${(inp.new_string ?? '').length} chars)`;
    case 'Write':
      return `file='${basename(inp.file_path ?? '')}' (${(inp.content ?? '').length} chars)`;
    case 'Bash':
      return (inp.command ?? '').slice(0, 80);
    case 'Glob':
      return `pattern='${inp.pattern ?? ''}' ${inp.path ? `path='${inp.path}'` : ''}`.trim();
    case 'Agent':
    case 'Task':
      return `prompt='${(inp.prompt ?? inp.description ?? '').slice(0, 80)}'`;
    case 'WebFetch':
      return `url='${inp.url ?? ''}'`;
    case 'WebSearch':
      return `query='${inp.query ?? ''}'`;
    default:
      return JSON.stringify(inp).slice(0, 80);
  }
}

/** Determine outcome from a tool_result. */
export function determineOutcome(resultInfo: { is_error?: boolean; content?: string | ContentBlock[] } | null): string {
  if (resultInfo == null) return 'no_result';
  if (resultInfo.is_error) {
    let errText = '';
    if (typeof resultInfo.content === 'string') {
      errText = resultInfo.content;
    } else if (Array.isArray(resultInfo.content)) {
      errText = resultInfo.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    }
    return 'error: ' + errText.slice(0, 60);
  }
  if (resultInfo.content === '' || resultInfo.content == null || (Array.isArray(resultInfo.content) && resultInfo.content.length === 0)) {
    return 'empty';
  }
  // Success heuristics
  if (typeof resultInfo.content === 'string') {
    const lines = resultInfo.content.split('\n').length;
    return lines > 1 ? `success (${lines} lines)` : 'success';
  }
  if (Array.isArray(resultInfo.content)) {
    const text = resultInfo.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    const lines = text.split('\n').length;
    return lines > 1 ? `success (${lines} lines)` : 'success';
  }
  return 'success';
}

/** Extract the file path from a tool_use block's input, if applicable. */
export function extractFilePath(toolName: string, input: Record<string, unknown>): { path: string; operation: string } | null {
  const inp = input as Record<string, any>;
  switch (toolName) {
    case 'Read':
      return inp.file_path ? { path: inp.file_path, operation: 'read' } : null;
    case 'Edit':
      return inp.file_path ? { path: inp.file_path, operation: 'edit' } : null;
    case 'Write':
      return inp.file_path ? { path: inp.file_path, operation: 'write' } : null;
    case 'Grep':
      return inp.path ? { path: inp.path, operation: 'grep' } : null;
    case 'Glob':
      return inp.path ? { path: inp.path, operation: 'glob' } : null;
    default:
      return null;
  }
}

/** Parse a relative duration string (e.g. "1d", "2h", "30m") into an ISO 8601 cutoff timestamp. */
export function parseSince(input: string): string {
  const match = input.match(/^(\d+)([smhdw])$/);
  if (!match) {
    throw cliError('INVALID_ARGS', `Invalid --since duration '${input}' -- expected format like 1d, 2h, 30m, 1w`);
  }
  const amount = parseInt(match[1]!, 10);
  if (amount <= 0) {
    throw cliError('INVALID_ARGS', `Invalid --since duration '${input}' -- amount must be positive`);
  }
  const unit = match[2]!;
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const ms = amount * multipliers[unit]!;
  return new Date(Date.now() - ms).toISOString();
}

/** Validate a numeric string arg. Returns the number or undefined. */
export function parseIntArg(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    throw cliError('INVALID_ARGS', `${name} must be a non-negative integer`);
  }
  return n;
}

/** Extract text from a content block's content field (string or array). */
function extractContentText(content: string | ContentBlock[] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  }
  return '';
}

/** Extract session metadata (branch, timestamp, version, slug) from raw JSONL text. */
export type SessionMetadata = {
  branch: string | null;
  timestamp: string | null;
  version: string | null;
  slug: string | null;
};

export function extractSessionMetadata(text: string): SessionMetadata {
  let branch: string | null = null;
  let timestamp: string | null = null;
  let version: string | null = null;
  let slug: string | null = null;

  const lines = text.split('\n');
  for (let j = 0; j < Math.min(5, lines.length); j++) {
    const rawLine = lines[j];
    if (!rawLine?.trim()) continue;
    try {
      const entry = JSON.parse(rawLine);
      if (entry.sessionId) {
        branch = entry.gitBranch ?? null;
        version = entry.version ?? null;
        timestamp = entry.timestamp ?? null;
        break;
      }
    } catch { /* skip */ }
  }

  const slugMatch = text.match(/"slug":"([a-zA-Z0-9][a-zA-Z0-9-]*)"/);
  if (slugMatch) slug = slugMatch[1] ?? null;

  return { branch, timestamp, version, slug };
}

/** Result info for a tool_use_id, extracted from tool_result blocks. */
export type ToolResultInfo = {
  is_error: boolean;
  content: string | ContentBlock[] | undefined;
  result_ts: string | undefined;
};

/** Build a lookup from tool_use_id to result info from user entries. */
export function buildResultLookup(entries: SessionEntry[]): Map<string, ToolResultInfo> {
  const lookup = new Map<string, ToolResultInfo>();
  for (const entry of entries) {
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message!.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          lookup.set(block.tool_use_id, {
            is_error: block.is_error ?? false,
            content: block.content,
            result_ts: entry.timestamp ?? undefined,
          });
        }
      }
    }
  }
  return lookup;
}

// ============================================================================
// List Command
// ============================================================================

const listCommand = defineCommand({
  meta: { name: 'list', description: 'Index all sessions (metadata only)' },
  args: {
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    branch: { type: 'string', description: 'Filter by git branch' },
    after: { type: 'string', description: 'Sessions after DATE (ISO 8601)' },
    before: { type: 'string', description: 'Sessions before DATE (ISO 8601)' },
    since: { type: 'string', description: 'Sessions from the last duration (e.g. 1d, 2h, 1w)' },
    last: { type: 'string', description: 'Return only the last N sessions' },
    'min-lines': { type: 'string', description: 'Sessions with at least N lines' },
  },
  async run({ args }) {
    try {
      const projectPath = args.project || process.cwd();
      const claudeDir = resolveClaudeProjectDir(projectPath);
      const minLines = parseIntArg(args['min-lines'], '--min-lines') ?? 0;

      if (args.since && args.after) {
        throw cliError('INVALID_ARGS', '--since and --after are mutually exclusive');
      }
      const afterCutoff = args.since ? parseSince(args.since) : args.after ?? null;

      const lastN = parseIntArg(args.last, '--last');
      if (lastN != null && lastN <= 0) {
        throw cliError('INVALID_ARGS', '--last must be a positive integer');
      }

      const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
      const sessions: ListSession[] = [];

      // Process files in parallel batches
      const BATCH_SIZE = 50;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (f) => {
          try {
            const filePath = join(claudeDir, f);
            const sessionId = f.replace('.jsonl', '');
            const text = await Bun.file(filePath).text();
            const lineCount = text.split('\n').filter(l => l.trim()).length;

            if (minLines > 0 && lineCount < minLines) return null;

            const { branch, timestamp, version, slug } = extractSessionMetadata(text);

            // Apply filters
            if (args.branch && branch !== args.branch) return null;
            if (afterCutoff) {
              if (!timestamp || timestamp < afterCutoff) return null;
            }
            if (args.before) {
              if (!timestamp || timestamp > args.before) return null;
            }

            return { session_id: sessionId, branch, timestamp, version, lines: lineCount, slug } as ListSession;
          } catch {
            return null; // skip unreadable files
          }
        }));
        sessions.push(...results.filter((r): r is ListSession => r !== null));
      }

      // Sort newest first
      sessions.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return b.timestamp.localeCompare(a.timestamp);
      });

      // Apply --last limit after sorting
      const total = sessions.length;
      const returned = lastN != null ? sessions.slice(0, lastN) : sessions;
      output(success(returned, meta(total, returned.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Tokens Command
// ============================================================================

const tokensCommand = defineCommand({
  meta: { name: 'tokens', description: 'Per-turn token usage timeline' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    cumulative: { type: 'boolean', description: 'Show running totals', default: false },
  },
  async run({ args }) {
    try {
      const { sessionId, entries } = await resolveSession(args);

      const turns: TokenTurn[] = [];
      let turnNum = 0;
      for (const entry of entries) {
        turnNum++;
        if (entry.type === 'assistant') {
          const usage = entry.message?.usage;
          turns.push({
            n: turnNum,
            input: usage?.input_tokens ?? 0,
            output: usage?.output_tokens ?? 0,
            cache_read: usage?.cache_read_input_tokens ?? 0,
            cache_create: usage?.cache_creation_input_tokens ?? 0,
          });
        }
      }

      const totals = {
        input: turns.reduce((s, t) => s + t.input, 0),
        output: turns.reduce((s, t) => s + t.output, 0),
        cache_read: turns.reduce((s, t) => s + t.cache_read, 0),
        cache_create: turns.reduce((s, t) => s + t.cache_create, 0),
      };

      let finalTurns = turns;
      if (args.cumulative) {
        let accIn = 0, accOut = 0, accCr = 0, accCc = 0;
        finalTurns = turns.map(t => {
          accIn += t.input;
          accOut += t.output;
          accCr += t.cache_read;
          accCc += t.cache_create;
          return { n: t.n, input: accIn, output: accOut, cache_read: accCr, cache_create: accCc };
        });
      }

      const result: TokensResult = { session_id: sessionId, turns: finalTurns, totals };
      output(success(result, meta(turns.length, turns.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Shape Command
// ============================================================================

const shapeCommand = defineCommand({
  meta: { name: 'shape', description: 'Turn-by-turn skeleton with summary stats' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
  },
  async run({ args }) {
    try {
      const { sessionId, entries } = await resolveSession(args);

      const rows: ShapeRow[] = [];
      const toolCounts: Record<string, number> = {};
      let userCount = 0;
      let firstEditTurn: number | null = null;
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let turnNum = 0;

      for (const entry of entries) {
        turnNum++;
        if (!firstTs && entry.timestamp) firstTs = entry.timestamp;
        if (entry.timestamp) lastTs = entry.timestamp;

        if (entry.type === 'user') {
          userCount++;
          const content = entry.message?.content;
          if (typeof content === 'string') {
            rows.push({ n: turnNum, role: 'user', type: 'user', block_index: 0 });
          } else if (Array.isArray(content)) {
            for (let bi = 0; bi < content.length; bi++) {
              const block = content[bi]!;
              if (block.type === 'tool_result') {
                rows.push({ n: turnNum, role: 'user', type: 'tool_result', block_index: bi });
              } else if (block.type === 'text') {
                rows.push({ n: turnNum, role: 'user', type: 'user', block_index: bi });
              } else if (block.type === 'image') {
                rows.push({ n: turnNum, role: 'user', type: 'image', block_index: bi });
              } else {
                rows.push({ n: turnNum, role: 'user', type: block.type ?? 'unknown', block_index: bi });
              }
            }
          } else {
            rows.push({ n: turnNum, role: 'user', type: 'user', block_index: 0 });
          }
        } else if (entry.type === 'assistant') {
          const blocks = (entry.message?.content ?? []) as ContentBlock[];
          const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name!);
          if (tools.length > 0) {
            rows.push({ n: turnNum, role: 'assistant', type: 'tool_use', block_index: 0, tools });
            for (const tool of tools) {
              toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
              if (firstEditTurn == null && (tool === 'Edit' || tool === 'Write')) {
                firstEditTurn = turnNum;
              }
            }
          } else {
            for (let bi = 0; bi < blocks.length; bi++) {
              const block = blocks[bi]!;
              if (block.type === 'text') {
                rows.push({ n: turnNum, role: 'assistant', type: 'text', block_index: bi });
              } else if (block.type === 'thinking') {
                rows.push({ n: turnNum, role: 'assistant', type: 'thinking', block_index: bi });
              } else {
                rows.push({ n: turnNum, role: 'assistant', type: block.type ?? 'unknown', block_index: bi });
              }
            }
          }
        }
      }

      // Duration
      let durationMinutes: number | null = null;
      if (firstTs && lastTs) {
        const first = new Date(firstTs).getTime();
        const last = new Date(lastTs).getTime();
        if (!isNaN(first) && !isNaN(last)) {
          durationMinutes = Math.round(((last - first) / 60000) * 10) / 10;
        }
      }

      const result: ShapeResult = {
        session_id: sessionId,
        turns: rows,
        summary: {
          total_turns: turnNum,
          user_messages: userCount,
          tool_calls: toolCounts,
          first_edit_turn: firstEditTurn,
          duration_minutes: durationMinutes,
        },
      };
      output(success(result, meta(rows.length, rows.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Tools Command
// ============================================================================

const toolsCommand = defineCommand({
  meta: { name: 'tools', description: 'Tool call log with condensed input summaries' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    name: { type: 'string', description: 'Filter by tool name' },
    failed: { type: 'boolean', description: 'Show only failed/empty outcomes', default: false },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
  },
  async run({ args }) {
    try {
      const { sessionId, entries } = await resolveSession(args);

      const turnRange = args.turn ? parseTurnRange(args.turn) : null;

      const resultLookup = buildResultLookup(entries);

      // Pass 2: Extract tool calls
      let calls: ToolCall[] = [];
      let turnNum = 0;
      for (const entry of entries) {
        turnNum++;
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message!.content as ContentBlock[]) {
            if (block.type === 'tool_use' && block.name) {
              const resultInfo = resultLookup.get(block.id ?? '') ?? null;
              let durationMs: number | null = null;
              if (entry.timestamp && resultInfo?.result_ts) {
                const diff = new Date(resultInfo.result_ts).getTime() - new Date(entry.timestamp).getTime();
                if (diff >= 0) durationMs = diff;
              }
              calls.push({
                turn: turnNum,
                tool: block.name,
                input_summary: inputSummary(block.name, block.input ?? {}),
                outcome: determineOutcome(resultInfo),
                duration_ms: durationMs,
              });
            }
          }
        }
      }

      // Apply filters
      if (args.name) calls = calls.filter(c => c.tool === args.name);
      if (args.failed) calls = calls.filter(c => c.outcome === 'empty' || c.outcome.startsWith('error:'));
      if (turnRange) calls = calls.filter(c => c.turn >= turnRange.start && c.turn <= turnRange.end);

      const total = calls.length;
      const result: ToolsResult = { session_id: sessionId, tool_calls: calls };
      output(success(result, meta(total, total)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Files Command
// ============================================================================

const filesCommand = defineCommand({
  meta: { name: 'files', description: 'Files touched in a session, grouped by operation' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    'group-by': { type: 'string', description: "Group by 'file' (default) or 'turn'" },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
    operation: { type: 'string', description: 'Filter by operation (read/edit/write/grep/glob)' },
  },
  async run({ args }) {
    try {
      const { sessionId, entries } = await resolveSession(args);

      const groupBy = args['group-by'] ?? 'file';
      if (groupBy !== 'file' && groupBy !== 'turn') {
        throw cliError('INVALID_ARGS', "--group-by must be 'file' or 'turn'");
      }
      const turnRange = args.turn ? parseTurnRange(args.turn) : null;
      const opFilter = args.operation ?? null;
      if (opFilter && !['read', 'edit', 'write', 'grep', 'glob'].includes(opFilter)) {
        throw cliError('INVALID_ARGS', '--operation must be one of: read, edit, write, grep, glob');
      }

      const resultLookup = buildResultLookup(entries);

      // Pass 2: Extract file accesses from tool_use blocks
      let accesses: FileAccess[] = [];
      let turnNum = 0;
      for (const entry of entries) {
        turnNum++;
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message!.content as ContentBlock[]) {
            if (block.type === 'tool_use' && block.name) {
              const fileInfo = extractFilePath(block.name, block.input ?? {});
              if (fileInfo) {
                const resultInfo = resultLookup.get(block.id ?? '');
                accesses.push({
                  path: fileInfo.path,
                  operation: fileInfo.operation as FileAccess['operation'],
                  turn: turnNum,
                  errored: resultInfo?.is_error ?? false,
                });
              }
            }
          }
        }
      }

      // Apply filters
      if (turnRange) accesses = accesses.filter(a => a.turn >= turnRange.start && a.turn <= turnRange.end);
      if (opFilter) accesses = accesses.filter(a => a.operation === opFilter);

      if (groupBy === 'turn') {
        const result: FilesResult = { session_id: sessionId, group_by: 'turn', accesses };
        output(success(result, meta(accesses.length, accesses.length)));
      } else {
        const fileMap = new Map<string, FileEntry>();
        for (const access of accesses) {
          let entry = fileMap.get(access.path);
          if (!entry) {
            entry = { path: access.path, operations: [], turns: [], errored: false };
            fileMap.set(access.path, entry);
          }
          if (!entry.operations.includes(access.operation)) {
            entry.operations.push(access.operation);
          }
          if (!entry.turns.includes(access.turn)) {
            entry.turns.push(access.turn);
          }
          if (access.errored) entry.errored = true;
        }
        const files = Array.from(fileMap.values());
        files.sort((a, b) => (a.turns[0] ?? 0) - (b.turns[0] ?? 0));
        const result: FilesResult = { session_id: sessionId, group_by: 'file', files };
        output(success(result, meta(files.length, files.length)));
      }
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Messages Command
// ============================================================================

const messagesCommand = defineCommand({
  meta: { name: 'messages', description: 'Filtered, truncated message content' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    role: { type: 'string', description: 'Filter by role (user or assistant)' },
    type: { type: 'string', description: 'Filter by content block type' },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
    'max-content': { type: 'string', description: 'Truncate content to N chars (default: 200)' },
  },
  async run({ args }) {
    try {
      const { entries } = await resolveSession(args);

      const maxContent = parseIntArg(args['max-content'], '--max-content') ?? 200;
      const turnRange = args.turn ? parseTurnRange(args.turn) : null;
      if (args.role && args.role !== 'user' && args.role !== 'assistant') {
        throw cliError('INVALID_ARGS', "--role must be 'user' or 'assistant'");
      }

      const messages: MessageEntry[] = [];
      let turnNum = 0;

      for (const entry of entries) {
        turnNum++;

        // Apply role filter
        if (args.role && entry.type !== args.role) continue;
        // Apply turn filter
        if (turnRange && (turnNum < turnRange.start || turnNum > turnRange.end)) continue;

        // Normalize content to array
        let blocks: ContentBlock[];
        const rawContent = entry.message?.content;
        if (typeof rawContent === 'string') {
          blocks = [{ type: 'text', text: rawContent }];
        } else if (Array.isArray(rawContent)) {
          blocks = rawContent as ContentBlock[];
        } else {
          blocks = [];
        }

        // Apply type filter
        if (args.type) {
          blocks = blocks.filter(b => b.type === args.type);
        }

        if (blocks.length === 0) continue;

        // Process blocks
        const processed = blocks.map(block => {
          switch (block.type) {
            case 'text':
              return { type: 'text', text: truncateContent(block.text ?? '', maxContent) };
            case 'thinking':
              return { type: 'thinking', text: truncateContent(block.thinking ?? '', maxContent) };
            case 'tool_use':
              return { type: 'tool_use', name: block.name, id: block.id };
            case 'tool_result': {
              const contentText = extractContentText(block.content);
              return {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                is_error: block.is_error ?? false,
                content: truncateContent(contentText, maxContent),
              };
            }
            case 'image':
              return { type: 'image' };
            case 'document':
              return { type: 'document' };
            default:
              return { type: block.type ?? 'unknown' };
          }
        });

        messages.push({ n: turnNum, role: entry.type as 'user' | 'assistant', content: processed as ContentBlock[] });
      }

      output(success(messages, meta(messages.length, messages.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Slice Command
// ============================================================================

const sliceCommand = defineCommand({
  meta: { name: 'slice', description: 'Raw entries for a turn range' },
  args: {
    session: { type: 'positional', description: 'Session ID (UUID, prefix, or slug)', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    turn: { type: 'string', description: 'Turn range N or N-M (required)', required: true },
    'max-content': { type: 'string', description: 'Truncate content blocks to N chars' },
  },
  async run({ args }) {
    try {
      const { entries } = await resolveSession(args);

      const turnRange = parseTurnRange(args.turn);
      const maxContent = parseIntArg(args['max-content'], '--max-content');

      const sliced: SessionEntry[] = [];
      let turnNum = 0;
      for (const entry of entries) {
        turnNum++;
        if (turnNum < turnRange.start) continue;
        if (turnNum > turnRange.end) break;

        if (maxContent != null && maxContent > 0) {
          // Deep clone and truncate content blocks
          const cloned = JSON.parse(JSON.stringify(entry)) as SessionEntry;
          truncateEntryContent(cloned, maxContent);
          sliced.push(cloned);
        } else {
          sliced.push(entry);
        }
      }

      output(success(sliced, meta(sliced.length, sliced.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

/** Truncate content blocks within a session entry in-place. */
function truncateEntryContent(entry: SessionEntry, maxLen: number): void {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    entry.message!.content = truncateContent(content, maxLen);
  } else if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        block.text = truncateContent(block.text, maxLen);
      } else if (block.type === 'thinking' && block.thinking) {
        block.thinking = truncateContent(block.thinking, maxLen);
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          block.content = truncateContent(block.content, maxLen);
        } else if (Array.isArray(block.content)) {
          for (const sub of block.content as ContentBlock[]) {
            if (sub.type === 'text' && sub.text) {
              sub.text = truncateContent(sub.text, maxLen);
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// Search Command
// ============================================================================

const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Find sessions matching structured queries' },
  args: {
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    tool: { type: 'string', description: 'Sessions using a specific tool (case-insensitive substring)' },
    file: { type: 'string', description: 'Sessions that touched a file (substring match on path)' },
    text: { type: 'string', description: 'Search in assistant text and thinking content (case-insensitive substring)' },
    bash: { type: 'string', description: 'Search in Bash command inputs (case-insensitive substring)' },
    branch: { type: 'string', description: 'Filter by git branch' },
    after: { type: 'string', description: 'Sessions after DATE (ISO 8601)' },
    before: { type: 'string', description: 'Sessions before DATE (ISO 8601)' },
    since: { type: 'string', description: 'Sessions from the last duration (e.g. 1d, 2h, 1w)' },
    last: { type: 'string', description: 'Return only the last N matches' },
  },
  async run({ args }) {
    try {
      // Validate at least one search filter is provided
      if (!args.tool && !args.file && !args.text && !args.bash) {
        throw cliError('INVALID_ARGS', 'At least one search filter is required (--tool, --file, --text, or --bash)');
      }

      // Validate --since and --after mutual exclusivity
      if (args.since && args.after) {
        throw cliError('INVALID_ARGS', '--since and --after are mutually exclusive');
      }

      const projectPath = args.project || process.cwd();
      const claudeDir = resolveClaudeProjectDir(projectPath);
      const afterCutoff = args.since ? parseSince(args.since) : args.after ?? null;
      const lastN = parseIntArg(args.last, '--last');
      if (lastN != null && lastN <= 0) {
        throw cliError('INVALID_ARGS', '--last must be a positive integer');
      }

      // WU-2: Session scanning with metadata filters
      const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
      const results: SearchMatch[] = [];

      const BATCH_SIZE = 50;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (f) => {
          try {
            const filePath = join(claudeDir, f);
            const sessionId = f.replace('.jsonl', '');
            const text = await Bun.file(filePath).text();

            const { branch, timestamp, slug } = extractSessionMetadata(text);

            // Apply metadata filters to skip non-matching sessions early
            if (args.branch && branch !== args.branch) return null;
            if (afterCutoff) {
              if (!timestamp || timestamp < afterCutoff) return null;
            }
            if (args.before) {
              if (!timestamp || timestamp > args.before) return null;
            }

            // Parse full session for content filtering
            const entries = await parseSessionLines(filePath);
            const uaEntries = userAssistantEntries(entries);

            // WU-3: Content search filters with AND semantics
            const matchedTools = new Set<string>();
            const matchedFiles = new Set<string>();
            const matchedTurns = new Set<number>();

            const toolQuery = args.tool?.toLowerCase();
            const fileQuery = args.file?.toLowerCase();
            const textQuery = args.text?.toLowerCase();
            const bashQuery = args.bash?.toLowerCase();

            // Per-filter hit booleans for AND semantics
            // A filter that wasn't provided is considered satisfied (true)
            let toolHit = !toolQuery;
            let fileHit = !fileQuery;
            let textHit = !textQuery;
            let bashHit = !bashQuery;

            for (let ei = 0; ei < uaEntries.length; ei++) {
              const entry = uaEntries[ei]!;
              const turnNum = ei + 1;
              const content = entry.message?.content;
              if (!Array.isArray(content)) continue;

              for (const block of content as ContentBlock[]) {
                // --tool: match tool_use block names (case-insensitive substring)
                if (toolQuery && block.type === 'tool_use' && block.name) {
                  if (block.name.toLowerCase().includes(toolQuery)) {
                    matchedTools.add(block.name);
                    matchedTurns.add(turnNum);
                    toolHit = true;
                  }
                }

                // --file: match file paths from extractFilePath on tool_use blocks
                if (fileQuery && block.type === 'tool_use' && block.name) {
                  const fileInfo = extractFilePath(block.name, block.input ?? {});
                  if (fileInfo && fileInfo.path.toLowerCase().includes(fileQuery)) {
                    matchedFiles.add(fileInfo.path);
                    matchedTurns.add(turnNum);
                    fileHit = true;
                  }
                }

                // --text: match text and thinking blocks in assistant entries only
                if (textQuery && entry.type === 'assistant') {
                  if (block.type === 'text' && block.text && block.text.toLowerCase().includes(textQuery)) {
                    matchedTurns.add(turnNum);
                    textHit = true;
                  }
                  if (block.type === 'thinking' && block.thinking && block.thinking.toLowerCase().includes(textQuery)) {
                    matchedTurns.add(turnNum);
                    textHit = true;
                  }
                }

                // --bash: match Bash tool_use block command inputs
                if (bashQuery && block.type === 'tool_use' && block.name === 'Bash') {
                  const command = (block.input as Record<string, any>)?.command;
                  if (typeof command === 'string' && command.toLowerCase().includes(bashQuery)) {
                    matchedTurns.add(turnNum);
                    bashHit = true;
                  }
                }
              }
            }

            // AND semantics: session matches only if ALL provided filters have hits
            if (!toolHit || !fileHit || !textHit || !bashHit) return null;

            return {
              session_id: sessionId,
              branch,
              timestamp,
              slug,
              matches: {
                tools: Array.from(matchedTools),
                files: Array.from(matchedFiles),
                turns: Array.from(matchedTurns).sort((a, b) => a - b),
              },
            } satisfies SearchMatch;
          } catch {
            return null; // skip unreadable files
          }
        }));
        results.push(...batchResults.filter((r): r is SearchMatch => r !== null));
      }

      // Sort newest first; null timestamps sort to end
      results.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return b.timestamp.localeCompare(a.timestamp);
      });

      // Apply --last limit after sorting
      const total = results.length;
      const returned = lastN != null ? results.slice(0, lastN) : results;
      output(success(returned, meta(total, returned.length)));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Main
// ============================================================================

const main = defineCommand({
  meta: {
    name: 'cc-session-tool',
    version: VERSION,
    description: 'Query Claude Code session transcripts',
  },
  subCommands: {
    list: listCommand,
    shape: shapeCommand,
    messages: messagesCommand,
    tools: toolsCommand,
    tokens: tokensCommand,
    slice: sliceCommand,
    files: filesCommand,
    search: searchCommand,
  },
});

if (import.meta.main) {
  runMain(main);
}
