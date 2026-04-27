import { basename, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import {
  resolveClaudeProjectDirFromSelector,
  sessionProjectSelectorFromArgs,
  type SessionProjectSelector,
} from './project-selection.ts';

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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

export type SessionEntry = {
  type: 'user' | 'assistant' | 'system' | 'summary' | (string & {});
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  version?: string;
  cwd?: string;
  model?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    usage?: TokenUsage;
    model?: string;
  };
  slug?: string;
};

export type NormalizedBlock = {
  turn: number;
  block_index: number;
  role: 'user' | 'assistant';
  timestamp: string | null;
  block: ContentBlock;
};

export type SessionMetadata = {
  branch: string | null;
  timestamp: string | null;
  version: string | null;
  slug: string | null;
  model: string | null;
};

export type SessionIntent = {
  source: 'slug' | 'first_prompt' | 'first_message';
  value: string;
};

export type ExtractSessionMetadataOptions = {
  includeSlug?: boolean;
  maxLines?: number;
};

export type ResolvedFile = {
  filePath: string;
  sessionId: string;
  agentId: string | null;
};

export type ResolvedSessionWithText = {
  sessionId: string;
  agentId: string | null;
  filePath: string;
  text: string;
  entries: SessionEntry[];
  allEntries: SessionEntry[];
  lineCount: number;
  metadata: SessionMetadata;
};

export type TruncationKind = 'text' | 'thinking' | 'tool_result' | 'raw_entry';

export type TruncationPolicy = {
  textMaxChars?: number | null;
  thinkingMaxChars?: number | null;
  toolResultMaxChars?: number | null;
  rawEntryMaxChars?: number | null;
  defaultMaxChars?: number | null;
};

export type UserAssistantEntry = SessionEntry & { type: 'user' | 'assistant' };

export type SubagentInfo = {
  agent_id: string;
  agent_type: string | null;
  description: string | null;
  lines: number;
  timestamp: string | null;
};

export type SessionSummaryResult = {
  session_id: string;
  agent_id: string | null;
  branch: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  lines: number | null;
  slug: string | null;
  first_user_prompt: {
    turn: number;
    snippet: string;
  } | null;
  last_assistant_text: {
    turn: number;
    snippet: string;
  } | null;
  tool_counts: Record<string, number>;
  files_touched: {
    read: number;
    edit: number;
    write: number;
    grep: number;
    glob: number;
  };
  subagents: SubagentInfo[];
};

export function userAssistantEntries(entries: SessionEntry[]): UserAssistantEntry[] {
  return entries.filter((e): e is UserAssistantEntry => e.type === 'user' || e.type === 'assistant');
}

export function contentBlocksForEntry(entry: SessionEntry): ContentBlock[] {
  const rawContent = entry.message?.content;
  if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }];
  if (Array.isArray(rawContent)) return rawContent;
  return [];
}

export function normalizedBlocks(entries: SessionEntry[]): NormalizedBlock[] {
  const relevantEntries = userAssistantEntries(entries);
  const blocks: NormalizedBlock[] = [];
  for (let turnIndex = 0; turnIndex < relevantEntries.length; turnIndex++) {
    const entry = relevantEntries[turnIndex]!;
    const turn = turnIndex + 1;
    const content = contentBlocksForEntry(entry);
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      blocks.push({
        turn,
        block_index: blockIndex,
        role: entry.type,
        timestamp: entry.timestamp ?? null,
        block: content[blockIndex]!,
      });
    }
  }
  return blocks;
}

export function extractSessionIntent(entries: SessionEntry[], metadata?: Pick<SessionMetadata, 'slug'>): SessionIntent[] {
  const intents: SessionIntent[] = [];
  if (metadata?.slug) {
    intents.push({ source: 'slug', value: metadata.slug });
  }

  const blocks = normalizedBlocks(entries);
  const firstUserText = blocks.find(block => block.role === 'user' && block.block.type === 'text' && typeof block.block.text === 'string');
  if (firstUserText?.block.text) {
    const text = firstUserText.block.text;
    const firstPromptToken = text.trim().split(/\s+/).find(Boolean);
    if (firstPromptToken) {
      intents.push({ source: 'first_prompt', value: firstPromptToken });
    }
    intents.push({ source: 'first_message', value: text });
  }

  return intents;
}

export function parseSessionText(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let nonEmptyCount = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    nonEmptyCount++;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as Record<string, unknown>).type === 'string'
      ) {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      // Skip malformed JSONL rows.
    }
  }
  if (nonEmptyCount > 0 && entries.length === 0) {
    throw new Error('Session file contains no valid entries');
  }
  return entries;
}

export async function parseSessionLines(filePath: string): Promise<SessionEntry[]> {
  return parseSessionText(await Bun.file(filePath).text());
}

export function countNonEmptyLines(text: string): number {
  let count = 0;
  let lineHasContent = false;

  for (const char of text) {
    if (char === '\n') {
      if (lineHasContent) count++;
      lineHasContent = false;
    } else if (char.trim() !== '') {
      lineHasContent = true;
    }
  }

  if (lineHasContent) count++;
  return count;
}

function modelFromEntry(entry: SessionEntry): string | null {
  if (typeof entry.message?.model === 'string' && entry.message.model.trim()) return entry.message.model;
  if (typeof entry.model === 'string' && entry.model.trim()) return entry.model;
  return null;
}

export function extractSessionMetadata(
  text: string,
  options: ExtractSessionMetadataOptions = {},
): SessionMetadata {
  const includeSlug = options.includeSlug ?? true;
  const maxLines = options.maxLines ?? 50;
  let branch: string | null = null;
  let timestamp: string | null = null;
  let version: string | null = null;
  let slug: string | null = null;
  let model: string | null = null;

  let linesSeen = 0;
  let lineStart = 0;
  while (linesSeen < maxLines && lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const rawLine = text.slice(lineStart, lineEnd);
    if (rawLine.trim()) {
      linesSeen++;
      try {
        const entry = JSON.parse(rawLine) as SessionEntry;
        if (branch === null && entry.sessionId) {
          branch = entry.gitBranch ?? null;
          version = entry.version ?? null;
          timestamp = entry.timestamp ?? null;
        }
        if (includeSlug && slug === null && typeof entry.slug === 'string') {
          slug = entry.slug;
        }
        if (model === null) {
          model = modelFromEntry(entry);
        }
        if (branch !== null && (!includeSlug || slug !== null) && model !== null) break;
      } catch {
        // Skip malformed metadata rows.
      }
    }
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  return { branch, timestamp, version, slug, model };
}

function validateSessionInput(input: string): void {
  if (!input) throw new Error('Session ID is required');
  if (!/^[a-zA-Z0-9-]+$/.test(input)) {
    throw new Error('Invalid session ID -- only alphanumeric characters and hyphens allowed');
  }
}

async function fileContainsSlug(filePath: string, slug: string): Promise<boolean> {
  const slugNeedle = `"slug":"${slug}"`;
  const stream = Bun.file(filePath).stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const matchesSlug = (line: string): boolean => {
    if (!line.includes(slugNeedle)) return false;
    try {
      const parsed: unknown = JSON.parse(line);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as SessionEntry).slug === slug
      );
    } catch {
      return false;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffered += decoder.decode(value, { stream: true });
      let newlineIndex = buffered.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        if (matchesSlug(line)) {
          try {
            await reader.cancel();
          } catch {
            // Cleanup failures should not change a confirmed match.
          }
          return true;
        }
        newlineIndex = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return buffered.length > 0 && matchesSlug(buffered);
}

export async function resolveByIdOrSlug(claudeDir: string, input: string): Promise<string> {
  validateSessionInput(input);
  const allFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
  const prefixMatches = allFiles.filter(f => f.startsWith(input));
  if (prefixMatches.length === 1) return join(claudeDir, prefixMatches[0]!);
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous session ID prefix '${input}' -- matches ${prefixMatches.length} sessions`);
  }

  const slugMatches: string[] = [];
  for (const f of allFiles) {
    const filePath = join(claudeDir, f);
    try {
      if (await fileContainsSlug(filePath, input)) slugMatches.push(filePath);
    } catch {
      // Skip unreadable files during slug search.
    }
  }
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    throw new Error(`Ambiguous slug '${input}' -- matches ${slugMatches.length} sessions`);
  }

  throw new Error(`No session found matching '${input}'`);
}

export async function resolveSessionFile(claudeDir: string, input: string): Promise<ResolvedFile> {
  if (!input) throw new Error('Session ID is required');

  const colonIdx = input.indexOf(':');
  if (colonIdx !== -1) {
    const sessionPart = input.slice(0, colonIdx);
    const agentId = input.slice(colonIdx + 1);
    validateSessionInput(sessionPart);
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      throw new Error('Invalid agent ID -- only alphanumeric characters, hyphens, and underscores allowed');
    }

    const parentFile = await resolveByIdOrSlug(claudeDir, sessionPart);
    const parentUuid = basename(parentFile, '.jsonl');
    const subagentFile = join(claudeDir, parentUuid, 'subagents', `agent-${agentId}.jsonl`);
    if (!existsSync(subagentFile)) {
      throw new Error(`No subagent '${agentId}' found for session '${parentUuid}'`);
    }
    return { filePath: subagentFile, sessionId: parentUuid, agentId };
  }

  const filePath = await resolveByIdOrSlug(claudeDir, input);
  return { filePath, sessionId: basename(filePath, '.jsonl'), agentId: null };
}

export async function resolveSessionWithText(args: {
  session: string;
  project?: string;
  'claude-project'?: string;
  claudeProjectsRoot?: string;
  selector?: SessionProjectSelector;
}): Promise<ResolvedSessionWithText> {
  const selector = args.selector ?? sessionProjectSelectorFromArgs(args);
  const claudeDir = resolveClaudeProjectDirFromSelector(selector, args.claudeProjectsRoot);
  const resolved = await resolveSessionFile(claudeDir, args.session);
  const text = await Bun.file(resolved.filePath).text();
  const allEntries = parseSessionText(text);
  return {
    ...resolved,
    text,
    allEntries,
    entries: userAssistantEntries(allEntries),
    lineCount: countNonEmptyLines(text),
    metadata: extractSessionMetadata(text),
  };
}

export function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `...[truncated, ${text.length} chars]`;
}

export function maxCharsForTruncationKind(policy: TruncationPolicy, kind: TruncationKind): number | null {
  switch (kind) {
    case 'text':
      return policy.textMaxChars ?? policy.defaultMaxChars ?? null;
    case 'thinking':
      return policy.thinkingMaxChars ?? policy.defaultMaxChars ?? null;
    case 'tool_result':
      return policy.toolResultMaxChars ?? policy.defaultMaxChars ?? null;
    case 'raw_entry':
      return policy.rawEntryMaxChars ?? policy.defaultMaxChars ?? null;
  }
}

export function applyTruncationPolicy(text: string, policy: TruncationPolicy, kind: TruncationKind): string {
  const maxChars = maxCharsForTruncationKind(policy, kind);
  return maxChars == null ? text : truncateContent(text, maxChars);
}

const SUMMARY_SNIPPET_CHARS = 400;

function summarySnippet(text: string): string {
  return truncateContent(text, SUMMARY_SNIPPET_CHARS);
}

function timestampBounds(entries: SessionEntry[]): { startedAt: string | null; endedAt: string | null } {
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const entry of entries) {
    if (!entry.timestamp) continue;
    if (startedAt === null) startedAt = entry.timestamp;
    endedAt = entry.timestamp;
  }
  return { startedAt, endedAt };
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

function summaryFileOperation(toolName: string): keyof SessionSummaryResult['files_touched'] | null {
  switch (toolName) {
    case 'Read': return 'read';
    case 'Edit': return 'edit';
    case 'Write': return 'write';
    case 'Grep': return 'grep';
    case 'Glob': return 'glob';
    default: return null;
  }
}

export function buildSessionSummary(args: {
  sessionId: string;
  agentId: string | null;
  entries: SessionEntry[];
  metadata: SessionMetadata;
  lineCount: number | null;
  subagents?: SubagentInfo[];
}): SessionSummaryResult {
  const normalized = normalizedBlocks(args.entries);
  const { startedAt, endedAt } = timestampBounds(args.entries);
  const toolCounts: Record<string, number> = {};
  const filesTouched: SessionSummaryResult['files_touched'] = {
    read: 0,
    edit: 0,
    write: 0,
    grep: 0,
    glob: 0,
  };

  for (const block of normalized) {
    if (block.block.type !== 'tool_use' || !block.block.name) continue;
    toolCounts[block.block.name] = (toolCounts[block.block.name] ?? 0) + 1;
    const operation = summaryFileOperation(block.block.name);
    if (operation) filesTouched[operation]++;
  }

  const firstUserText = normalized.find(block =>
    block.role === 'user' &&
    block.block.type === 'text' &&
    typeof block.block.text === 'string' &&
    block.block.text.length > 0
  );
  const assistantTextBlocks = normalized.filter(block =>
    block.role === 'assistant' &&
    block.block.type === 'text' &&
    typeof block.block.text === 'string' &&
    block.block.text.length > 0
  );
  const lastAssistantText = assistantTextBlocks[assistantTextBlocks.length - 1] ?? null;

  return {
    session_id: args.sessionId,
    agent_id: args.agentId,
    branch: args.metadata.branch,
    model: args.metadata.model,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs(startedAt, endedAt),
    turn_count: userAssistantEntries(args.entries).length,
    lines: args.lineCount,
    slug: args.metadata.slug,
    first_user_prompt: firstUserText?.block.text
      ? { turn: firstUserText.turn, snippet: summarySnippet(firstUserText.block.text) }
      : null,
    last_assistant_text: lastAssistantText?.block.text
      ? { turn: lastAssistantText.turn, snippet: summarySnippet(lastAssistantText.block.text) }
      : null,
    tool_counts: toolCounts,
    files_touched: filesTouched,
    subagents: args.subagents ?? [],
  };
}
