import { basename } from 'path';
import { userAssistantEntries, type ContentBlock, type SessionEntry } from './transcript.ts';

/** Result info for a tool_use_id, extracted from tool_result blocks. */
export type ToolResultInfo = {
  is_error: boolean;
  content: string | ContentBlock[] | undefined;
  result_ts: string | undefined;
};

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

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
    .join(',')}}`;
}

export function safeInputSummary(tool: string, input: Record<string, unknown>): string {
  try {
    return inputSummary(tool, input);
  } catch {
    return stableJsonStringify(input).slice(0, 80);
  }
}

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

/** A tool_result located within user/assistant turn numbering. */
export type ToolResultLocation = ToolResultInfo & {
  /** 1-based user/assistant turn holding the tool_result (same numbering as search/tools/messages). */
  turn: number;
};

/**
 * Map tool_use_id -> located result. Filters to user/assistant entries internally, so callers may pass
 * raw or already-filtered entries. Built in full before calls are evaluated so results written ahead of
 * their tool_use still pair. Duplicate ids resolve last-wins, like buildResultLookup.
 */
export function buildToolResultLocations(entries: SessionEntry[]): Map<string, ToolResultLocation> {
  const locations = new Map<string, ToolResultLocation>();
  const relevant = userAssistantEntries(entries);
  for (let i = 0; i < relevant.length; i++) {
    const entry = relevant[i]!;
    if (entry.type !== 'user' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message!.content as ContentBlock[]) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        locations.set(block.tool_use_id, {
          is_error: block.is_error ?? false,
          content: block.content,
          result_ts: entry.timestamp ?? undefined,
          turn: i + 1,
        });
      }
    }
  }
  return locations;
}

/** Extract text from a content block's content field (string or array). Null-safe over malformed sub-blocks. */
export function extractContentText(content: string | ContentBlock[] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
  }
  return '';
}

/** Determine outcome from a tool_result. */
export function determineOutcome(resultInfo: { is_error?: boolean; content?: string | ContentBlock[] } | null): string {
  if (resultInfo == null) return 'no_result';
  if (resultInfo.is_error) {
    return 'error: ' + extractContentText(resultInfo.content).slice(0, 60);
  }
  if (resultInfo.content === '' || resultInfo.content == null || (Array.isArray(resultInfo.content) && resultInfo.content.length === 0)) {
    return 'empty';
  }
  // Success heuristics
  if (typeof resultInfo.content === 'string' || Array.isArray(resultInfo.content)) {
    const lines = extractContentText(resultInfo.content).split('\n').length;
    return lines > 1 ? `success (${lines} lines)` : 'success';
  }
  return 'success';
}

/** Outcome-string predicate used by `tools --failed`. */
export function isFailedOutcome(outcome: string): boolean {
  return outcome === 'empty' || outcome.startsWith('error:');
}

/**
 * Result predicate used by `search --failed`; must agree with isFailedOutcome(determineOutcome(r)).
 * Skips the line counting determineOutcome does for successful outputs.
 */
export function isFailedResult(
  result: { is_error?: boolean; content?: string | ContentBlock[] } | null | undefined,
): boolean {
  if (!result) return false;
  if (result.is_error) return true;
  const content = result.content;
  return content == null || content === '' || (Array.isArray(content) && content.length === 0);
}
