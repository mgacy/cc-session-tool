import { basename } from 'path';
import { truncateContent, truncateMiddle, userAssistantEntries, type ContentBlock, type SessionEntry } from './transcript.ts';

/** Result info for a tool_use_id, extracted from tool_result blocks. */
export type ToolResultInfo = {
  is_error: boolean;
  content: string | ContentBlock[] | undefined;
  result_ts: string | undefined;
};

/** Visible-character budget for length-truncated input summaries. */
export const INPUT_SUMMARY_MAX_CHARS = 80;
/** Bash commands vary at the end (paths, args, heredoc bodies), so split the budget between both ends. */
export const BASH_SUMMARY_HEAD_CHARS = INPUT_SUMMARY_MAX_CHARS / 2;
export const BASH_SUMMARY_TAIL_CHARS = INPUT_SUMMARY_MAX_CHARS - BASH_SUMMARY_HEAD_CHARS;

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
    case 'Bash': {
      const command = inp.command ?? '';
      // Non-string commands are malformed; throwing sends safeInputSummary to its stable-JSON fallback.
      if (typeof command !== 'string') throw new TypeError('Bash command is not a string');
      return truncateMiddle(command, BASH_SUMMARY_HEAD_CHARS, BASH_SUMMARY_TAIL_CHARS);
    }
    case 'Glob':
      return `pattern='${inp.pattern ?? ''}' ${inp.path ? `path='${inp.path}'` : ''}`.trim();
    case 'Agent':
    case 'Task':
      return `prompt='${truncateContent(inp.prompt ?? inp.description ?? '', INPUT_SUMMARY_MAX_CHARS)}'`;
    case 'WebFetch':
      return `url='${inp.url ?? ''}'`;
    case 'WebSearch':
      return `query='${inp.query ?? ''}'`;
    default:
      return truncateContent(JSON.stringify(inp), INPUT_SUMMARY_MAX_CHARS);
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
    return truncateContent(stableJsonStringify(input), INPUT_SUMMARY_MAX_CHARS);
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

/** Default visible-character budget for the text after `error: ` in an outcome. */
export const DEFAULT_OUTCOME_ERROR_CHARS = 60;
/** Hex chars kept from the SHA-256 digest in `outcome_hash`. */
export const OUTCOME_HASH_HEX_CHARS = 12;

type ToolResultLike = { is_error?: boolean; content?: string | ContentBlock[] } | null | undefined;

/** Full extracted error text of an error result; null for non-error and missing results. */
function errorResultText(resultInfo: ToolResultLike): string | null {
  return resultInfo?.is_error ? extractContentText(resultInfo.content) : null;
}

/** Determine outcome from a tool_result. Error text longer than `maxErrorChars` gets the "...[truncated, N chars]" suffix. */
export function determineOutcome(
  resultInfo: ToolResultLike,
  options: { maxErrorChars?: number } = {},
): string {
  if (resultInfo == null) return 'no_result';
  const errText = errorResultText(resultInfo);
  if (errText != null) {
    return 'error: ' + truncateContent(errText, options.maxErrorChars ?? DEFAULT_OUTCOME_ERROR_CHARS);
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

/**
 * Stable discriminator for an error result: the first OUTCOME_HASH_HEX_CHARS hex chars of SHA-256 over the
 * full extracted error text (UTF-8). Null exactly when determineOutcome does not return an `error:` outcome.
 */
export function outcomeHash(resultInfo: ToolResultLike): string | null {
  const errText = errorResultText(resultInfo);
  return errText == null ? null : Bun.CryptoHasher.hash('sha256', errText, 'hex').slice(0, OUTCOME_HASH_HEX_CHARS);
}

/** Outcome-string predicate used by `tools --failed`. */
export function isFailedOutcome(outcome: string): boolean {
  return outcome === 'empty' || outcome.startsWith('error:');
}

/**
 * Result predicate used by `search --failed`; must agree with isFailedOutcome(determineOutcome(r)).
 * Skips the line counting determineOutcome does for successful outputs.
 */
export function isFailedResult(result: ToolResultLike): boolean {
  if (!result) return false;
  if (result.is_error) return true;
  const content = result.content;
  return content == null || content === '' || (Array.isArray(content) && content.length === 0);
}
