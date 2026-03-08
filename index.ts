import { defineCommand, runMain } from 'citty';
import { homedir } from 'os';
import { join, basename } from 'path';
import { readdirSync, existsSync, statSync } from 'fs';
import { readdir } from 'fs/promises';

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
  type: string;
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
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, any>;
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
  role: string;
  type: string;
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
  role: string;
  content: ContentBlock[];
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
    throw Object.assign(new Error(`Claude project directory not found: ${claudeDir}`), { errorCode: 'NOT_FOUND' as ErrorCode });
  }
  return claudeDir;
}

/**
 * Resolve a session file from a UUID, UUID prefix, or slug.
 * Validates input against path traversal.
 */
export async function resolveSessionFile(claudeDir: string, input: string): Promise<string> {
  if (!input) {
    throw Object.assign(new Error('Session ID is required'), { errorCode: 'INVALID_ARGS' as ErrorCode });
  }
  if (!/^[a-zA-Z0-9-]+$/.test(input)) {
    throw Object.assign(new Error('Invalid session ID -- only alphanumeric characters and hyphens allowed'), { errorCode: 'INVALID_ID' as ErrorCode });
  }

  // Try UUID/prefix match
  const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl') && f.startsWith(input));
  if (files.length === 1) return join(claudeDir, files[0]);
  if (files.length > 1) {
    throw Object.assign(new Error(`Ambiguous session ID prefix '${input}' -- matches ${files.length} sessions`), { errorCode: 'INVALID_ID' as ErrorCode });
  }

  // Try slug match - search for "slug":"<input>" in all jsonl files
  const allFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
  const slugPattern = `"slug":"${input}"`;
  const slugMatches: string[] = [];
  for (const f of allFiles) {
    const filePath = join(claudeDir, f);
    const file = Bun.file(filePath);
    // Read first 8KB to find slug (it's near the top)
    const buf = new Uint8Array(8192);
    const reader = file.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    if (value) {
      const chunk = new TextDecoder().decode(value);
      if (chunk.includes(slugPattern)) {
        slugMatches.push(filePath);
      }
    }
  }
  if (slugMatches.length === 1) return slugMatches[0];
  if (slugMatches.length > 1) {
    throw Object.assign(new Error(`Ambiguous slug '${input}' -- matches ${slugMatches.length} sessions`), { errorCode: 'INVALID_ID' as ErrorCode });
  }

  throw Object.assign(new Error(`No session found matching '${input}'`), { errorCode: 'NOT_FOUND' as ErrorCode });
}

/** Parse a JSONL session file into an array of entries. Skips malformed lines. */
export async function parseSessionLines(filePath: string): Promise<SessionEntry[]> {
  const text = await Bun.file(filePath).text();
  const entries: SessionEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Filter to user/assistant entries only (same turn numbering as POC). */
export function userAssistantEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(e => e.type === 'user' || e.type === 'assistant');
}

/** Parse turn range "N" or "N-M". Returns {start, end}. */
export function parseTurnRange(input: string): { start: number; end: number } {
  const rangeMatch = input.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start > end) {
      throw Object.assign(new Error(`Invalid turn range -- start (${start}) is greater than end (${end})`), { errorCode: 'INVALID_ARGS' as ErrorCode });
    }
    return { start, end };
  }
  const singleMatch = input.match(/^(\d+)$/);
  if (singleMatch) {
    const n = parseInt(singleMatch[1], 10);
    return { start: n, end: n };
  }
  throw Object.assign(new Error(`Invalid turn range '${input}' -- expected N or N-M`), { errorCode: 'INVALID_ARGS' as ErrorCode });
}

/** Truncate text with "...[truncated, N chars]" suffix. */
export function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `...[truncated, ${text.length} chars]`;
}

/** Condensed tool input summary per tool type. */
export function inputSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'Grep':
      return `pattern='${input.pattern ?? ''}' ${input.path ? `path='${input.path}'` : ''}`.trim();
    case 'Read':
      return `file='${basename(input.file_path ?? '')}' ${input.offset != null ? `offset=${input.offset}` : ''} ${input.limit != null ? `limit=${input.limit}` : ''}`.trim().replace(/\s+/g, ' ');
    case 'Edit':
      return `file='${basename(input.file_path ?? '')}' old=(${(input.old_string ?? '').length} chars) new=(${(input.new_string ?? '').length} chars)`;
    case 'Write':
      return `file='${basename(input.file_path ?? '')}' (${(input.content ?? '').length} chars)`;
    case 'Bash':
      return (input.command ?? '').slice(0, 80);
    case 'Glob':
      return `pattern='${input.pattern ?? ''}' ${input.path ? `path='${input.path}'` : ''}`.trim();
    case 'Agent':
    case 'Task':
      return `prompt='${(input.prompt ?? input.description ?? '').slice(0, 80)}'`;
    case 'WebFetch':
      return `url='${input.url ?? ''}'`;
    case 'WebSearch':
      return `query='${input.query ?? ''}'`;
    default:
      return JSON.stringify(input).slice(0, 80);
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

/** Validate a numeric string arg. Returns the number or undefined. */
export function parseIntArg(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    throw Object.assign(new Error(`${name} must be a non-negative integer`), { errorCode: 'INVALID_ARGS' as ErrorCode });
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
    'min-lines': { type: 'string', description: 'Sessions with at least N lines' },
  },
  async run({ args }) {
    try {
      const projectPath = args.project || process.cwd();
      const claudeDir = resolveClaudeProjectDir(projectPath);
      const minLines = parseIntArg(args['min-lines'], '--min-lines') ?? 0;

      const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
      const sessions: ListSession[] = [];

      // Process files in parallel batches
      const BATCH_SIZE = 50;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (f) => {
          const filePath = join(claudeDir, f);
          const sessionId = f.replace('.jsonl', '');
          const text = await Bun.file(filePath).text();
          const lineCount = text.split('\n').filter(l => l.trim()).length;

          if (minLines > 0 && lineCount < minLines) return null;

          // Extract metadata from first few lines
          let branch: string | null = null;
          let timestamp: string | null = null;
          let version: string | null = null;
          let slug: string | null = null;

          const lines = text.split('\n');
          for (let j = 0; j < Math.min(5, lines.length); j++) {
            if (!lines[j].trim()) continue;
            try {
              const entry = JSON.parse(lines[j]);
              if (entry.sessionId) {
                branch = entry.gitBranch ?? null;
                version = entry.version ?? null;
                timestamp = entry.timestamp ?? null;
                break;
              }
            } catch { /* skip */ }
          }

          // Find slug via string search (fast, no full parse)
          const slugMatch = text.match(/"slug":"([a-z][a-z0-9-]*)"/);
          if (slugMatch) slug = slugMatch[1];

          // Apply filters
          if (args.branch && branch !== args.branch) return null;
          if (args.after) {
            if (!timestamp || timestamp < args.after) return null;
          }
          if (args.before) {
            if (!timestamp || timestamp > args.before) return null;
          }

          return { session_id: sessionId, branch, timestamp, version, lines: lineCount, slug } as ListSession;
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

      output(success(sessions, meta(sessions.length, sessions.length)));
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
      const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
      const sessionFile = await resolveSessionFile(claudeDir, args.session);
      const sessionId = basename(sessionFile, '.jsonl');
      const allEntries = await parseSessionLines(sessionFile);
      const entries = userAssistantEntries(allEntries);

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
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
      const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
      const sessionFile = await resolveSessionFile(claudeDir, args.session);
      const sessionId = basename(sessionFile, '.jsonl');
      const allEntries = await parseSessionLines(sessionFile);
      const entries = userAssistantEntries(allEntries);

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
            rows.push({ n: turnNum, role: 'user', type: 'user' });
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                rows.push({ n: turnNum, role: 'user', type: 'tool_result' });
              } else if (block.type === 'text') {
                rows.push({ n: turnNum, role: 'user', type: 'user' });
              } else if (block.type === 'image') {
                rows.push({ n: turnNum, role: 'user', type: 'image' });
              } else {
                rows.push({ n: turnNum, role: 'user', type: block.type ?? 'unknown' });
              }
            }
          } else {
            rows.push({ n: turnNum, role: 'user', type: 'user' });
          }
        } else if (entry.type === 'assistant') {
          const blocks = (entry.message?.content ?? []) as ContentBlock[];
          const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name!);
          if (tools.length > 0) {
            rows.push({ n: turnNum, role: 'assistant', type: 'tool_use', tools });
            for (const tool of tools) {
              toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
              if (firstEditTurn == null && (tool === 'Edit' || tool === 'Write')) {
                firstEditTurn = turnNum;
              }
            }
          } else {
            for (const block of blocks) {
              if (block.type === 'text') {
                rows.push({ n: turnNum, role: 'assistant', type: 'text' });
              } else if (block.type === 'thinking') {
                rows.push({ n: turnNum, role: 'assistant', type: 'thinking' });
              } else {
                rows.push({ n: turnNum, role: 'assistant', type: block.type ?? 'unknown' });
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
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
      const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
      const sessionFile = await resolveSessionFile(claudeDir, args.session);
      const sessionId = basename(sessionFile, '.jsonl');
      const allEntries = await parseSessionLines(sessionFile);
      const entries = userAssistantEntries(allEntries);

      const turnRange = args.turn ? parseTurnRange(args.turn) : null;

      // Pass 1: Build tool_use_id → result lookup from user entries
      const resultLookup = new Map<string, { is_error?: boolean; content?: string | ContentBlock[]; result_ts?: string }>();
      for (const entry of entries) {
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message!.content as ContentBlock[]) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              resultLookup.set(block.tool_use_id, {
                is_error: block.is_error ?? false,
                content: block.content,
                result_ts: entry.timestamp ?? undefined,
              });
            }
          }
        }
      }

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
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
      const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
      const sessionFile = await resolveSessionFile(claudeDir, args.session);
      const allEntries = await parseSessionLines(sessionFile);
      const entries = userAssistantEntries(allEntries);

      const maxContent = parseIntArg(args['max-content'], '--max-content') ?? 200;
      const turnRange = args.turn ? parseTurnRange(args.turn) : null;
      if (args.role && args.role !== 'user' && args.role !== 'assistant') {
        throw Object.assign(new Error("--role must be 'user' or 'assistant'"), { errorCode: 'INVALID_ARGS' as ErrorCode });
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

        messages.push({ n: turnNum, role: entry.type, content: processed as ContentBlock[] });
      }

      output(success(messages, meta(messages.length, messages.length)));
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
      const claudeDir = resolveClaudeProjectDir(args.project || process.cwd());
      const sessionFile = await resolveSessionFile(claudeDir, args.session);
      const allEntries = await parseSessionLines(sessionFile);
      const entries = userAssistantEntries(allEntries);

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
    } catch (err: any) {
      output(failure(err.errorCode ?? 'FORMAT_ERROR', err.message));
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
// Main
// ============================================================================

const main = defineCommand({
  meta: {
    name: 'cc-session-tool',
    description: 'Query Claude Code session transcripts',
  },
  subCommands: {
    list: listCommand,
    shape: shapeCommand,
    messages: messagesCommand,
    tools: toolsCommand,
    tokens: tokensCommand,
    slice: sliceCommand,
  },
});

if (import.meta.main) {
  runMain(main);
}
