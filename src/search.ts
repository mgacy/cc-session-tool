import type {
  SearchProjectContext,
  PublicProjectRef,
  ProjectRef,
  SearchOperation,
  SearchProjectRole,
} from './project-selection.ts';
import type { SessionMetadata } from './transcript.ts';

export const SEARCH_EVIDENCE_SNIPPET_CHARS = 200;
export const SUMMARY_SNIPPET_CHARS = 400;

export type MatchMode = 'substring' | 'regex';

export type TextMatcher = {
  raw: string;
  mode: MatchMode;
  regex?: RegExp;
  needleLower?: string;
};

export type SessionRef = {
  session_id: string;
  project: string;
  agent_id?: string | null;
};

export type IntentMatchSource = 'slug' | 'first_prompt' | 'first_message';

export type SearchEvidenceKind =
  | 'file'
  | 'tool_input'
  | 'text'
  | 'thinking'
  | 'bash'
  | 'intent';

export type SearchEvidence = {
  kind: SearchEvidenceKind;
  turn: number;
  block_index: number | null;
  timestamp: string | null;
  role?: 'user' | 'assistant';
  agent_id?: string | null;
  parent_session_id?: string | null;
  is_subagent?: boolean;
  snippet?: string;

  rawPath?: string;
  logicalPath?: string | null;
  operation?: SearchOperation;

  tool?: string;
  input_summary?: string;
  intent_source?: IntentMatchSource;
};

export type SearchMatch = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  slug: string | null;
  model: string | null;
  project?: string;
  project_path_guess?: string | null;
  project_role?: SearchProjectRole;
  session_ref: SessionRef;
  agent_id?: string | null;
  parent_session_id?: string | null;
  is_subagent?: boolean;
  matches: {
    tools: string[];
    files: string[];
    normalized_files?: string[];
    operations?: SearchOperation[];
    turns: number[];
    evidence: SearchEvidence[];
  };
};

export type ToolInputMatch = {
  tool: string;
  input_summary: string;
  turn: number;
};

export type SearchAggregateMode = 'none' | 'count-per-session' | 'counters';
export type SearchBucketMode = 'none' | 'day' | 'week';

export type SearchCounterAggregateResult = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  slug: string | null;
  model: string | null;
  project: string;
  project_path_guess: string | null;
  project_role: SearchProjectRole;
  session_ref: SessionRef;
  parent_session_id?: string | null;
  agent_id?: string | null;
  is_subagent?: boolean;
  counts: Record<string, number>;
  total_matches: number;
};

export type SearchBucketAggregateResult = {
  bucket: string;
  sessions: number;
  counts: Record<string, number>;
  total_matches: number;
};

export type ResponseMeta = {
  total: number;
  returned: number;
  hasMore: boolean;
};

export type SearchMeta = ResponseMeta & {
  projects_scanned?: number;
  included_projects?: PublicProjectRef[];
  skipped_projects?: PublicProjectRef[];
};

export type SearchTranscriptTarget = {
  filePath: string;
  sessionId: string;
  parentSessionId: string | null;
  agentId: string | null;
  context?: SearchProjectContext;
  projectRef?: ProjectRef;
};

export type SearchSessionGroup = {
  parent: SearchTranscriptTarget;
  subagents: SearchTranscriptTarget[];
};

export type ToolCallScanRecord = {
  turn: number;
  block_index: number;
  timestamp: string | null;
  tool: string;
  input_summary: string;
  rawInput: Record<string, unknown>;
  agentId: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;
};

export type TranscriptScanResult = {
  target: SearchTranscriptTarget;
  evidence: SearchEvidence[];
  allToolCalls: ToolCallScanRecord[];
  metadata: SessionMetadata;
};

export type SessionGroupScanResult = {
  groupRef: SessionRef;
  parentMetadata: SessionMetadata;
  transcriptResults: TranscriptScanResult[];
};

export type ParsedCounter = {
  name: string;
  matcher: TextMatcher;
  source: 'substring' | 'regex';
};

const COUNTER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_COUNTER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function parseSubstringMatcher(raw: string | undefined): TextMatcher | null {
  if (raw === undefined) return null;
  return {
    raw,
    mode: 'substring',
    needleLower: raw.toLowerCase(),
  };
}

export function parseRegexMatcher(raw: string | undefined, flagName: string): TextMatcher | null {
  if (raw === undefined) return null;
  try {
    return {
      raw,
      mode: 'regex',
      regex: new RegExp(raw, 'i'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${flagName} regex: ${message}`);
  }
}

export function testTextMatcher(matcher: TextMatcher | null, value: string): boolean {
  if (!matcher) return true;
  if (matcher.mode === 'regex') return matcher.regex?.test(value) ?? false;
  return value.toLowerCase().includes(matcher.needleLower ?? matcher.raw.toLowerCase());
}

export function snippetForMatch(value: string, matcher: TextMatcher, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;

  const match = locateMatch(value, matcher);
  if (!match) return value.slice(0, maxChars);

  const matchCenter = Math.floor((match.start + match.end) / 2);
  let start = Math.max(0, matchCenter - Math.floor(maxChars / 2));
  let end = start + maxChars;
  if (end > value.length) {
    end = value.length;
    start = Math.max(0, end - maxChars);
  }

  return value.slice(start, end);
}

function locateMatch(value: string, matcher: TextMatcher): { start: number; end: number } | null {
  if (matcher.mode === 'regex') {
    const regex = matcher.regex;
    if (!regex) return null;
    regex.lastIndex = 0;
    const match = regex.exec(value);
    if (!match || match.index < 0) return null;
    const matchedText = match[0] ?? '';
    return {
      start: match.index,
      end: match.index + matchedText.length,
    };
  }

  const needle = matcher.needleLower ?? matcher.raw.toLowerCase();
  const start = value.toLowerCase().indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length };
}

export function parseCounterArgs(
  substringCounters: string | string[] | undefined,
  regexCounters: string | string[] | undefined,
): ParsedCounter[] {
  return [
    ...parseCounterArgList(substringCounters, 'substring'),
    ...parseCounterArgList(regexCounters, 'regex'),
  ];
}

function parseCounterArgList(
  counters: string | string[] | undefined,
  source: 'substring' | 'regex',
): ParsedCounter[] {
  const values = counters === undefined ? [] : Array.isArray(counters) ? counters : [counters];
  return values.map(value => {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid counter '${value}': expected NAME=PATTERN`);
    }

    const name = value.slice(0, separator);
    const pattern = value.slice(separator + 1);
    validateCounterName(name);

    return {
      name,
      matcher: source === 'regex'
        ? parseRegexMatcher(pattern, `--counter-regex ${name}`)!
        : parseSubstringMatcher(pattern)!,
      source,
    };
  });
}

function validateCounterName(name: string): void {
  if (!COUNTER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid counter name '${name}': use ${COUNTER_NAME_PATTERN.source}`);
  }
  if (RESERVED_COUNTER_NAMES.has(name)) {
    throw new Error(`Invalid counter name '${name}': reserved name`);
  }
}

export function evidenceTimestamps(match: SearchMatch, kind?: SearchEvidenceKind): string[] {
  return match.matches.evidence
    .filter(e => !kind || e.kind === kind)
    .map(e => e.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort();
}

export function toolInputSamplesFromEvidence(evidence: SearchEvidence[], limit = 5): ToolInputMatch[] {
  return evidence
    .filter(e => e.kind === 'tool_input' && e.tool)
    .slice(0, limit)
    .map(e => ({
      tool: e.tool!,
      input_summary: e.input_summary ?? '',
      turn: e.turn,
    }));
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

type CounterAggregateTranscript = {
  target: SearchTranscriptTarget;
  metadata: SessionMetadata;
  allToolCalls: ToolCallScanRecord[];
};

type CounterAggregateSource = SearchMatch & {
  __counterTranscriptResults?: CounterAggregateTranscript[];
};

export function attachCounterTranscriptResults(
  match: SearchMatch,
  transcriptResults: CounterAggregateTranscript[],
): void {
  Object.defineProperty(match, '__counterTranscriptResults', {
    value: transcriptResults,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function aggregateCounterRows(
  matches: SearchMatch[],
  counters: ParsedCounter[],
  options: {
    tool?: string;
    explicitSelector: boolean;
    perSubagent: boolean;
  },
): SearchCounterAggregateResult[] {
  const rows: SearchCounterAggregateResult[] = [];

  for (const match of matches as CounterAggregateSource[]) {
    const transcriptResults = match.__counterTranscriptResults ?? [];
    if (options.perSubagent) {
      for (const transcript of transcriptResults) {
        const row = counterRowForTranscript(match, transcript, counters, options.tool);
        if (options.explicitSelector || row.total_matches > 0) rows.push(row);
      }
      continue;
    }

    const counts = emptyCounterCounts(counters);
    for (const transcript of transcriptResults) {
      addCounterMatches(counts, transcript.allToolCalls, counters, options.tool);
    }
    const row = counterRowBase(match, counts);
    if (options.explicitSelector || row.total_matches > 0) rows.push(row);
  }

  return rows;
}

function counterRowForTranscript(
  match: SearchMatch,
  transcript: CounterAggregateTranscript,
  counters: ParsedCounter[],
  tool: string | undefined,
): SearchCounterAggregateResult {
  const counts = emptyCounterCounts(counters);
  addCounterMatches(counts, transcript.allToolCalls, counters, tool);
  const row = counterRowBase(match, counts, transcript.metadata);

  if (transcript.target.agentId) {
    row.agent_id = transcript.target.agentId;
    row.parent_session_id = transcript.target.parentSessionId ?? match.session_id;
    row.is_subagent = true;
    row.session_ref = {
      session_id: match.session_id,
      project: match.session_ref.project,
      agent_id: transcript.target.agentId,
    };
  }

  return row;
}

function counterRowBase(
  match: SearchMatch,
  counts: Record<string, number>,
  metadata = {
    branch: match.branch,
    timestamp: match.timestamp,
    slug: match.slug,
    model: match.model,
  } as SessionMetadata,
): SearchCounterAggregateResult {
  return {
    session_id: match.session_id,
    branch: metadata.branch,
    timestamp: metadata.timestamp,
    slug: metadata.slug,
    model: metadata.model,
    project: match.session_ref.project,
    project_path_guess: match.project_path_guess ?? null,
    project_role: match.project_role ?? 'main',
    session_ref: match.session_ref,
    counts,
    total_matches: totalCounterMatches(counts),
  };
}

function emptyCounterCounts(counters: ParsedCounter[]): Record<string, number> {
  return Object.fromEntries(counters.map(counter => [counter.name, 0]));
}

function addCounterMatches(
  counts: Record<string, number>,
  toolCalls: ToolCallScanRecord[],
  counters: ParsedCounter[],
  tool: string | undefined,
): void {
  const toolQuery = tool?.toLowerCase();
  for (const call of toolCalls) {
    if (toolQuery && !call.tool.toLowerCase().includes(toolQuery)) continue;
    const serializedInput = stableJsonStringify(call.rawInput);
    for (const counter of counters) {
      if (testTextMatcher(counter.matcher, serializedInput)) {
        counts[counter.name] = (counts[counter.name] ?? 0) + 1;
      }
    }
  }
}

function totalCounterMatches(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function bucketCounterRows(
  rows: SearchCounterAggregateResult[],
  mode: SearchBucketMode,
): SearchBucketAggregateResult[] {
  if (mode === 'none') return [];
  const buckets = new Map<string, SearchBucketAggregateResult>();

  for (const row of rows) {
    const bucket = bucketForTimestamp(row.timestamp, mode);
    let aggregate = buckets.get(bucket);
    if (!aggregate) {
      aggregate = {
        bucket,
        sessions: 0,
        counts: emptyCountsFromRow(row),
        total_matches: 0,
      };
      buckets.set(bucket, aggregate);
    }
    aggregate.sessions += 1;
    aggregate.total_matches += row.total_matches;
    for (const [name, count] of Object.entries(row.counts)) {
      aggregate.counts[name] = (aggregate.counts[name] ?? 0) + count;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => {
    if (a.bucket === 'unknown') return 1;
    if (b.bucket === 'unknown') return -1;
    return b.bucket.localeCompare(a.bucket);
  });
}

function emptyCountsFromRow(row: SearchCounterAggregateResult): Record<string, number> {
  return Object.fromEntries(Object.keys(row.counts).map(name => [name, 0]));
}

function bucketForTimestamp(timestamp: string | null, mode: Exclude<SearchBucketMode, 'none'>): string {
  if (!timestamp) return 'unknown';
  if (mode === 'day') return timestamp.slice(0, 10);

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  return monday.toISOString().slice(0, 10);
}
