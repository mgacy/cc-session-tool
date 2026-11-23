import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { createHash, randomUUID } from 'crypto';
import {
  ERROR_CODES, success, failure, CliError, isCliError, outputFailureEnvelope,
  parseTurnRange, truncateContent, inputSummary, determineOutcome, parseIntArg,
  parseDateArg,
  extractFilePath, parseSince, buildResultLookup, extractSessionMetadata,
  resolveClaudeProjectDir, resolveSessionFile, resolveSession, parseSessionLines, userAssistantEntries,
  claudeProjectsRoot, findRelatedProjectRefs, listClaudeProjectRefs, listSubagents,
  mangleProjectPath, mapConcurrent, projectPathGuessFromClaudeProject,
  buildScopedSearchScope, isPathWithinOrEqual, listSearchTargetsForContext,
  normalizePathForContainment, parseSessionText, pathContainmentCandidates,
  scanProjectContexts, buildSearchSessionContext, extractSessionCwd, normalizeFileAccess,
  normalizeFileQuery, matchFileAccess, projectMatchesGlob, selectProjectContexts,
  stableJsonStringify, toolInputMatches, deriveWorktreeRootFromPath,
  extractWorktreeStatePaths, collectObservedWorktreeRoots, absolutePathCandidatesFor,
  scanSearchTarget, extractContentText, sortSearchMatches, main as cliMain, VERSION,
} from './index.ts';
import {
  buildToolResultLocations,
  isFailedOutcome,
  isFailedResult,
  outcomeHash,
  safeInputSummary,
} from './src/tool-log.ts';
import {
  applyTruncationPolicy,
  truncateMiddle,
  buildSessionSummary,
  contentBlocksForEntry,
  countNonEmptyLines,
  extractSessionIntent,
  extractSessionMetadata as extractTranscriptSessionMetadata,
  parseSessionLines as parseTranscriptSessionLines,
  parseSessionText as parseTranscriptSessionText,
  normalizedBlocks,
  resolveByIdOrSlug as resolveTranscriptByIdOrSlug,
  resolveSessionFile as resolveTranscriptSessionFile,
  resolveSessionWithText,
} from './src/transcript.ts';
import {
  buildProjectScanMeta,
  buildScopedSearchScope as buildScopedSearchScopeModule,
  listSearchTargetsForContext as listSearchTargetsForContextModule,
  claudeProjectPathHash,
  mangleProjectPath as mangleProjectPathModule,
  ProjectSelectionError,
  resolveClaudeProjectDirFromSelector,
  sessionProjectSelectorFromArgs,
} from './src/project-selection.ts';
import {
  CliArgsError,
  isCliArgsError,
  parseCommandArgs,
  resolveCliCommand,
} from './src/cli-args.ts';
import { errnoCode, writeAll, writeAllToFd, type WriteAllIo } from './src/write-all.ts';
import { defineCommand } from 'citty';
import type { ArgsDef, CommandDef } from 'citty';
import {
  aggregateCounterRows,
  attachCounterTranscriptResults,
  bucketCounterRows,
  evaluateResultSelectors,
  evidenceTimestamps,
  matchedToolCalls,
  parseCounterArgs,
  parseRegexMatcher,
  parseSubstringMatcher,
  snippetForMatch,
  testTextMatcher,
  toolInputSamplesFromEvidence,
  type SearchEvidence,
  type SearchMatch,
  type SearchMeta,
} from './src/search.ts';

import {
  computeIndexFreshness,
  defaultIndexDbPath,
  INDEX_DB_ENV_VAR,
  INDEX_SCHEMA_VERSION,
  listIndexTargetsForContext,
  openIndexDb,
  queryTokenStats,
  queryToolPairs,
  refreshIndexForContexts,
  resolveIndexDbPath,
} from './src/transcript-index.ts';

function uniqueTempName(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// Fixture project paths must encode under Claude Code's 200-char project-dir cap: past it the encoder
// hash-truncates, so worktree discovery and project-name globs stop matching. The longest fixture adds ~130 chars,
// so a long TMPDIR (e.g. a session scratchpad) falls back to /tmp.
const SHORT_TMP_ROOT = tmpdir().length <= 64 ? tmpdir() : '/tmp';

// ============================================================================
// Search Module Primitives
// ============================================================================

describe('search matcher primitives', () => {
  test('substring matcher is case-insensitive and null matcher passes', () => {
    const matcher = parseSubstringMatcher('Needle');
    expect(testTextMatcher(matcher, 'haystack needle value')).toBe(true);
    expect(testTextMatcher(matcher, 'haystack value')).toBe(false);
    expect(testTextMatcher(null, 'anything')).toBe(true);
  });

  test('regex matcher is case-sensitive and rejects invalid patterns', () => {
    const matcher = parseRegexMatcher('foo\\s+bar', '--text-regex');
    expect(testTextMatcher(matcher, 'foo   bar')).toBe(true);
    expect(testTextMatcher(matcher, 'FOO   bar')).toBe(false);
    expect(() => parseRegexMatcher('[', '--text-regex')).toThrow('Invalid --text-regex regex');
  });

  test('snippetForMatch centers around substring and regex matches', () => {
    const value = '0123456789abcdefghijKLMNOPQRSTuvwxyz';
    expect(snippetForMatch(value, parseSubstringMatcher('KLM')!, 10)).toContain('KLM');
    expect(snippetForMatch(value, parseRegexMatcher('MNOP', '--sample')!, 12)).toBe('ijKLMNOPQRST');
  });

  test('parseCounterArgs handles repeated substring and regex counters', () => {
    const counters = parseCounterArgs(['reads=Read', 'writes=Write=file'], 'bash=\\brg\\b');
    expect(counters.map(counter => ({
      name: counter.name,
      source: counter.source,
      mode: counter.matcher.mode,
      raw: counter.matcher.raw,
    }))).toEqual([
      { name: 'reads', source: 'substring', mode: 'substring', raw: 'Read' },
      { name: 'writes', source: 'substring', mode: 'substring', raw: 'Write=file' },
      { name: 'bash', source: 'regex', mode: 'regex', raw: '\\brg\\b' },
    ]);
  });

  test('parseCounterArgs rejects malformed and reserved counter names', () => {
    expect(() => parseCounterArgs('missingSeparator', undefined)).toThrow('expected NAME=PATTERN');
    expect(() => parseCounterArgs('1bad=value', undefined)).toThrow('Invalid counter name');
    expect(() => parseCounterArgs('constructor=value', undefined)).toThrow('reserved name');
    expect(() => parseCounterArgs(undefined, 'rx=[')).toThrow('Invalid --counter-regex rx regex');
  });

  test('evidenceTimestamps filters by kind and sorts timestamps', () => {
    const match: SearchMatch = {
      session_id: 's1',
      branch: null,
      timestamp: '2026-03-01T00:00:00.000Z',
      slug: null,
      model: null,
      session_ref: { session_id: 's1', project: '-tmp-project' },
      matches: {
        tools: [],
        files: [],
        turns: [1, 2],
        evidence: [
          { kind: 'tool_input', turn: 1, block_index: 0, timestamp: '2026-03-03T00:00:00.000Z', tool: 'Read' },
          { kind: 'file', turn: 2, block_index: 0, timestamp: '2026-03-02T00:00:00.000Z', rawPath: 'a.ts', operation: 'read' },
          { kind: 'file', turn: 3, block_index: 0, timestamp: null, rawPath: 'b.ts', operation: 'write' },
        ],
      },
    };
    expect(evidenceTimestamps(match)).toEqual([
      '2026-03-02T00:00:00.000Z',
      '2026-03-03T00:00:00.000Z',
    ]);
    expect(evidenceTimestamps(match, 'file')).toEqual(['2026-03-02T00:00:00.000Z']);
  });

  describe('sortSearchMatches match-* ordering', () => {
    const mk = (id: string, timestamp: string | null, evidence: SearchEvidence[]): SearchMatch => ({
      session_id: id,
      branch: null,
      timestamp,
      slug: null,
      model: null,
      session_ref: { session_id: id, project: '-tmp-project' },
      matches: { tools: [], files: [], turns: [], evidence },
    });
    const ev = (kind: SearchEvidence['kind'], timestamp: string | null): SearchEvidence => ({ kind, turn: 1, block_index: 0, timestamp });
    const order = (matches: SearchMatch[], mode: 'match-earliest' | 'match-newest') => sortSearchMatches([...matches], mode).map(m => m.session_id);

    test('file evidence wins over other evidence when present', () => {
      const a = mk('a', '2026-01-01T00:00:00.000Z', [ev('file', '2026-03-05T00:00:00.000Z'), ev('tool_output', '2026-01-01T00:00:00.000Z')]);
      const b = mk('b', '2026-02-01T00:00:00.000Z', [ev('file', '2026-03-01T00:00:00.000Z'), ev('tool_output', '2026-04-01T00:00:00.000Z')]);
      expect(order([a, b], 'match-earliest')).toEqual(['b', 'a']);
      expect(order([a, b], 'match-newest')).toEqual(['a', 'b']);
    });

    test('without file evidence, earliest/newest is taken over non-intent evidence', () => {
      const a = mk('a', '2026-01-01T00:00:00.000Z', [ev('text', '2026-05-02T00:00:00.000Z'), ev('tool_output', '2026-05-04T00:00:00.000Z')]);
      const b = mk('b', '2026-06-01T00:00:00.000Z', [ev('bash', '2026-05-03T00:00:00.000Z')]);
      // earliest: a=05-02, b=05-03; newest: a=05-04, b=05-03
      expect(order([b, a], 'match-earliest')).toEqual(['a', 'b']);
      expect(order([b, a], 'match-newest')).toEqual(['a', 'b']);
      const c = mk('c', '2026-01-01T00:00:00.000Z', [ev('tool_input', '2026-05-10T00:00:00.000Z')]);
      expect(order([a, c], 'match-newest')).toEqual(['c', 'a']);
    });

    test('intent-only evidence falls back to the session start', () => {
      const a = mk('a', '2026-03-01T00:00:00.000Z', [ev('intent', '2026-03-01T00:00:00.000Z')]);
      const b = mk('b', '2026-02-01T00:00:00.000Z', [ev('intent', '2026-02-01T00:00:00.000Z')]);
      expect(order([a, b], 'match-earliest')).toEqual(['b', 'a']);
      expect(order([a, b], 'match-newest')).toEqual(['a', 'b']);
    });

    test('intent evidence is ignored when other evidence exists', () => {
      const a = mk('a', '2026-01-01T00:00:00.000Z', [ev('intent', '2026-01-01T00:00:00.000Z'), ev('text', '2026-06-01T00:00:00.000Z')]);
      const b = mk('b', '2026-03-01T00:00:00.000Z', [ev('text', '2026-04-01T00:00:00.000Z')]);
      expect(order([a, b], 'match-earliest')).toEqual(['b', 'a']);
    });

    test('file evidence with null timestamps falls back to the session start', () => {
      const a = mk('a', '2026-03-01T00:00:00.000Z', [ev('file', null), ev('text', '2026-01-01T00:00:00.000Z')]);
      const b = mk('b', '2026-02-01T00:00:00.000Z', [ev('file', null)]);
      expect(order([a, b], 'match-earliest')).toEqual(['b', 'a']);
      expect(order([a, b], 'match-newest')).toEqual(['a', 'b']);
    });
  });

  test('SearchMeta contains only active search metadata fields', () => {
    const meta: SearchMeta = {
      total: 0,
      returned: 0,
      hasMore: false,
      projects_scanned: 1,
      projects_skipped: 0,
      included_projects: [],
      skipped_projects: [],
    };
    expect(meta).not.toHaveProperty('warning');
    expect(meta).not.toHaveProperty('related_projects');
    expect(meta).not.toHaveProperty('project');
  });

  test('counter aggregation uses complete raw tool calls, session_ref keys, and parent rollup', () => {
    const match: SearchMatch = {
      session_id: 'parent-session',
      branch: 'main',
      timestamp: '2026-03-05T12:00:00.000Z',
      slug: '/plan-counter-test',
      model: 'claude-sonnet-4-5',
      project_path_guess: '/workspace/project',
      project_role: 'worktree',
      session_ref: { session_id: 'parent-session', project: '-workspace-project' },
      matches: { tools: [], files: [], turns: [], evidence: [] },
    };
    attachCounterTranscriptResults(match, [
      {
        target: { filePath: '/tmp/parent.jsonl', sessionId: 'parent-session', parentSessionId: null, agentId: null },
        metadata: { branch: 'main', timestamp: '2026-03-05T12:00:00.000Z', version: null, slug: '/plan-counter-test', model: 'claude-sonnet-4-5' },
        allToolCalls: [
          { turn: 1, block_index: 0, timestamp: '2026-03-05T12:01:00.000Z', tool: 'Bash', input_summary: 'rg', rawInput: { command: 'rg .claude-tracking' }, agentId: null, parentSessionId: null, isSubagent: false },
        ],
      },
      {
        target: { filePath: '/tmp/sub.jsonl', sessionId: 'parent-session', parentSessionId: 'parent-session', agentId: 'agent_a' },
        metadata: { branch: 'main', timestamp: null, version: null, slug: null, model: null },
        allToolCalls: [
          { turn: 1, block_index: 0, timestamp: null, tool: 'Bash', input_summary: 'find', rawInput: { command: 'find .claude-tracking -name implementation.md' }, agentId: 'agent_a', parentSessionId: 'parent-session', isSubagent: true },
          { turn: 2, block_index: 0, timestamp: null, tool: 'Read', input_summary: 'file', rawInput: { file_path: '.claude-tracking/011/progress.json' }, agentId: 'agent_a', parentSessionId: 'parent-session', isSubagent: true },
        ],
      },
    ]);

    const counters = parseCounterArgs('tracking=.claude-tracking', 'find_cmd=^\\{\"command\":\"find');
    const rows = aggregateCounterRows([match], counters, { explicitSelector: false, perSubagent: false, tool: 'Bash' });
    expect(rows).toEqual([
      expect.objectContaining({
        session_id: 'parent-session',
        project: '-workspace-project',
        project_path_guess: '/workspace/project',
        project_role: 'worktree',
        session_ref: { session_id: 'parent-session', project: '-workspace-project' },
        counts: { tracking: 2, find_cmd: 1 },
        total_matches: 3,
      }),
    ]);
  });

  test('counter aggregation supports zero-count selectors, per-subagent rows, and buckets', () => {
    const match: SearchMatch = {
      session_id: 'bucket-session',
      branch: 'main',
      timestamp: '2026-03-08T12:00:00.000Z',
      slug: null,
      model: null,
      session_ref: { session_id: 'bucket-session', project: '-workspace-bucket' },
      matches: { tools: [], files: [], turns: [], evidence: [] },
    };
    attachCounterTranscriptResults(match, [
      {
        target: { filePath: '/tmp/parent.jsonl', sessionId: 'bucket-session', parentSessionId: null, agentId: null },
        metadata: { branch: 'main', timestamp: '2026-03-08T12:00:00.000Z', version: null, slug: null, model: null },
        allToolCalls: [],
      },
      {
        target: { filePath: '/tmp/sub.jsonl', sessionId: 'bucket-session', parentSessionId: 'bucket-session', agentId: 'agent_b' },
        metadata: { branch: 'main', timestamp: null, version: null, slug: null, model: null },
        allToolCalls: [
          { turn: 1, block_index: 0, timestamp: null, tool: 'Bash', input_summary: 'rg', rawInput: { command: 'rg bucket-marker' }, agentId: 'agent_b', parentSessionId: 'bucket-session', isSubagent: true },
        ],
      },
    ]);

    const counters = parseCounterArgs('marker=bucket-marker', undefined);
    expect(aggregateCounterRows([match], counters, { explicitSelector: false, perSubagent: true }).map(row => row.agent_id)).toEqual(['agent_b']);

    const rows = aggregateCounterRows([match], counters, { explicitSelector: true, perSubagent: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ counts: { marker: 0 }, total_matches: 0 });
    expect(rows[1]).toMatchObject({
      agent_id: 'agent_b',
      parent_session_id: 'bucket-session',
      is_subagent: true,
      session_ref: { session_id: 'bucket-session', project: '-workspace-bucket', agent_id: 'agent_b' },
      counts: { marker: 1 },
    });
    expect(bucketCounterRows(rows, 'day')).toEqual([
      { bucket: '2026-03-08', sessions: 1, counts: { marker: 0 }, total_matches: 0 },
      { bucket: 'unknown', sessions: 1, counts: { marker: 1 }, total_matches: 1 },
    ]);
    expect(bucketCounterRows(rows, 'week')[0]!.bucket).toBe('2026-03-02');
  });
});

// ============================================================================
// Response Helpers
// ============================================================================

describe('success', () => {
  test('returns ok response with data and meta', () => {
    const result = success({ items: ['a'] }, { total: 1, returned: 1, hasMore: false });
    expect(result).toEqual({
      ok: true,
      data: { items: ['a'] },
      _meta: { total: 1, returned: 1, hasMore: false },
    });
  });
});

describe('failure', () => {
  test('returns error response with code and message', () => {
    const result = failure('NOT_FOUND', 'Item not found');
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Item not found' },
    });
  });
});

// ============================================================================
// Error Codes
// ============================================================================

describe('ERROR_CODES', () => {
  test('has distinct exit codes', () => {
    expect(ERROR_CODES.INVALID_ARGS.exitCode).toBe(2);
    expect(ERROR_CODES.NOT_FOUND.exitCode).toBe(3);
    expect(ERROR_CODES.OUTPUT_ERROR.exitCode).toBe(1);
  });
});

describe('outputFailureEnvelope', () => {
  test('a closed reader (EPIPE) needs no report', () => {
    expect(outputFailureEnvelope(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBeNull();
  });

  test('an errno error is reported by its code', () => {
    const report = outputFailureEnvelope(Object.assign(new Error('bad file descriptor'), { code: 'EBADF' }));
    expect(report?.ok).toBe(false);
    if (report && !report.ok) {
      expect(report.error.code).toBe('OUTPUT_ERROR');
      expect(report.error.message).toContain('EBADF');
    }
  });

  test('a non-errno error is reported by its message', () => {
    const report = outputFailureEnvelope(new Error('boom'));
    expect(report?.ok).toBe(false);
    if (report && !report.ok) {
      expect(report.error.code).toBe('OUTPUT_ERROR');
      expect(report.error.message).toContain('boom');
    }
  });
});

// ============================================================================
// CliError / isCliError
// ============================================================================

describe('CliError', () => {
  test('has correct errorCode and message', () => {
    const err = new CliError('NOT_FOUND', 'gone');
    expect(err.errorCode).toBe('NOT_FOUND');
    expect(err.message).toBe('gone');
    expect(err.name).toBe('CliError');
  });

  test('is instanceof Error', () => {
    const err = new CliError('INVALID_ARGS', 'bad');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isCliError', () => {
  test('returns true for CliError', () => {
    expect(isCliError(new CliError('NOT_FOUND', 'test'))).toBe(true);
  });

  test('returns false for plain Error', () => {
    expect(isCliError(new Error('test'))).toBe(false);
  });

  test('returns false for plain object with errorCode', () => {
    expect(isCliError({ errorCode: 'NOT_FOUND', message: 'test' })).toBe(false);
  });
});

// ============================================================================
// parseTurnRange
// ============================================================================

describe('parseTurnRange', () => {
  test('parses single turn', () => {
    expect(parseTurnRange('5')).toEqual({ start: 5, end: 5 });
  });

  test('parses range', () => {
    expect(parseTurnRange('3-7')).toEqual({ start: 3, end: 7 });
  });

  test('throws on invalid format', () => {
    expect(() => parseTurnRange('abc')).toThrow('Invalid turn range');
  });

  test('throws on start > end', () => {
    expect(() => parseTurnRange('10-3')).toThrow('start (10) is greater than end (3)');
  });

  test('handles single digit range endpoints', () => {
    expect(parseTurnRange('1-1')).toEqual({ start: 1, end: 1 });
  });
});

// ============================================================================
// truncateContent
// ============================================================================

describe('truncateContent', () => {
  test('returns text under limit unchanged', () => {
    expect(truncateContent('short', 100)).toBe('short');
  });

  test('returns text at limit unchanged', () => {
    expect(truncateContent('12345', 5)).toBe('12345');
  });

  test('truncates text over limit with suffix', () => {
    const result = truncateContent('hello world', 5);
    expect(result).toBe('hello...[truncated, 11 chars]');
  });
});

describe('truncateMiddle', () => {
  test('returns text at and below head + tail unchanged', () => {
    expect(truncateMiddle('abcd', 2, 2)).toBe('abcd');
    expect(truncateMiddle('abc', 2, 2)).toBe('abc');
  });

  test('keeps exact head, marker with full length, then exact tail', () => {
    expect(truncateMiddle('0123456789', 3, 2)).toBe('012...[truncated, 10 chars]...89');
  });

  test('one char over the threshold is elided', () => {
    expect(truncateMiddle('abcde', 2, 2)).toBe('ab...[truncated, 5 chars]...de');
  });
});

// ============================================================================
// inputSummary
// ============================================================================

describe('inputSummary', () => {
  test('Grep with pattern and path', () => {
    expect(inputSummary('Grep', { pattern: 'foo', path: 'src/' })).toBe("pattern='foo' path='src/'");
  });

  test('Grep with pattern only', () => {
    expect(inputSummary('Grep', { pattern: 'foo' })).toBe("pattern='foo'");
  });

  test('Read with file_path', () => {
    expect(inputSummary('Read', { file_path: '/a/b/test.ts' })).toBe("file='test.ts'");
  });

  test('Read with offset and limit', () => {
    expect(inputSummary('Read', { file_path: '/a/b/test.ts', offset: 10, limit: 50 })).toBe("file='test.ts' offset=10 limit=50");
  });

  test('Edit with file and content lengths', () => {
    expect(inputSummary('Edit', { file_path: '/a/b/test.ts', old_string: 'abc', new_string: 'defgh' })).toBe("file='test.ts' old=(3 chars) new=(5 chars)");
  });

  test('Write with file and content length', () => {
    expect(inputSummary('Write', { file_path: '/x/y.txt', content: 'hello' })).toBe("file='y.txt' (5 chars)");
  });

  test('Bash keeps the first 40 and last 40 chars of a long command', () => {
    const cmd = `${'a'.repeat(40)}${'m'.repeat(20)}${'z'.repeat(40)}`;
    expect(inputSummary('Bash', { command: cmd })).toBe(`${'a'.repeat(40)}...[truncated, 100 chars]...${'z'.repeat(40)}`);
  });

  test('Bash commands sharing an 80-char prefix get distinct summaries', () => {
    const prefix = 'p'.repeat(80);
    const a = inputSummary('Bash', { command: `${prefix}${'q'.repeat(30)} first-ending-path.txt` });
    const b = inputSummary('Bash', { command: `${prefix}${'q'.repeat(30)} second-ending-path.txt` });
    expect(a).not.toBe(b);
    expect(a.endsWith('first-ending-path.txt')).toBe(true);
    expect(b.endsWith('second-ending-path.txt')).toBe(true);
  });

  test('Bash commands at or under 80 chars are unchanged', () => {
    const cmd = 'c'.repeat(80);
    expect(inputSummary('Bash', { command: cmd })).toBe(cmd);
    expect(inputSummary('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  test('Agent prompt over 80 chars gets the suffix marker inside the quotes', () => {
    const prompt = `${'p'.repeat(80)}tail-not-shown`;
    expect(inputSummary('Agent', { prompt })).toBe(`prompt='${'p'.repeat(80)}...[truncated, ${prompt.length} chars]'`);
    expect(inputSummary('Task', { description: prompt })).toBe(`prompt='${'p'.repeat(80)}...[truncated, ${prompt.length} chars]'`);
  });

  test('default JSON form over 80 chars gets the suffix marker', () => {
    const input = { todos: [{ status: 'pending', content: 'z'.repeat(100) }] };
    const json = JSON.stringify(input);
    expect(inputSummary('TodoWrite', input)).toBe(`${json.slice(0, 80)}...[truncated, ${json.length} chars]`);
  });

  test('short default JSON and Agent inputs are unchanged', () => {
    expect(inputSummary('TodoWrite', { a: 1 })).toBe('{"a":1}');
    expect(inputSummary('Agent', { prompt: 'short' })).toBe("prompt='short'");
  });

  test('Glob with pattern and path', () => {
    expect(inputSummary('Glob', { pattern: '*.ts', path: 'src' })).toBe("pattern='*.ts' path='src'");
  });

  test('Agent with prompt', () => {
    expect(inputSummary('Agent', { prompt: 'do stuff' })).toBe("prompt='do stuff'");
  });

  test('WebFetch with url', () => {
    expect(inputSummary('WebFetch', { url: 'https://example.com' })).toBe("url='https://example.com'");
  });

  test('WebSearch with query', () => {
    expect(inputSummary('WebSearch', { query: 'bun runtime' })).toBe("query='bun runtime'");
  });

  test('unknown tool uses JSON.stringify', () => {
    const result = inputSummary('Custom', { foo: 'bar' });
    expect(result).toContain('foo');
  });
});

describe('safeInputSummary', () => {
  test('matches inputSummary for well-formed input', () => {
    expect(safeInputSummary('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  test('falls back to marker-suffixed stable JSON when inputSummary throws', () => {
    const input = { command: 123, zzz: 'z'.repeat(100), aaa: 1 };
    expect(() => inputSummary('Bash', input)).toThrow();
    const json = stableJsonStringify(input);
    expect(safeInputSummary('Bash', input)).toBe(`${json.slice(0, 80)}...[truncated, ${json.length} chars]`);
  });

  test('short malformed input falls back to unmarked stable JSON', () => {
    expect(safeInputSummary('Bash', { command: 123 })).toBe('{"command":123}');
  });

  test('array-valued Bash command falls back to stable JSON instead of leaking a non-string', () => {
    const input = { command: ['ls', '-la'] };
    expect(() => inputSummary('Bash', input)).toThrow();
    const summary = safeInputSummary('Bash', input);
    expect(typeof summary).toBe('string');
    expect(summary).toBe('{"command":["ls","-la"]}');
  });

  test('missing Bash command still summarizes as an empty string', () => {
    expect(safeInputSummary('Bash', {})).toBe('');
  });
});

describe('toolInputMatches', () => {
  test('uses stable JSON serialization for structured inputs', () => {
    const left = stableJsonStringify({ b: 2, a: { d: 4, c: 3 } });
    const right = stableJsonStringify({ a: { c: 3, d: 4 }, b: 2 });
    expect(left).toBe(right);
    expect(toolInputMatches({ b: 2, a: { d: 4, c: 'Stable JSON Marker' } }, '"c":"stable json marker"')).toBe(true);
  });
});

// ============================================================================
// determineOutcome
// ============================================================================

describe('determineOutcome', () => {
  test('null returns no_result', () => {
    expect(determineOutcome(null)).toBe('no_result');
  });

  test('error with string content', () => {
    const result = determineOutcome({ is_error: true, content: 'file not found' });
    expect(result).toBe('error: file not found');
  });

  test('error with array content', () => {
    const result = determineOutcome({ is_error: true, content: [{ type: 'text', text: 'bad input' }] });
    expect(result).toBe('error: bad input');
  });

  test('empty string content', () => {
    expect(determineOutcome({ content: '' })).toBe('empty');
  });

  test('null content', () => {
    expect(determineOutcome({ content: undefined })).toBe('empty');
  });

  test('empty array content', () => {
    expect(determineOutcome({ content: [] })).toBe('empty');
  });

  test('success with single line string', () => {
    expect(determineOutcome({ content: 'ok' })).toBe('success');
  });

  test('success with multi-line string', () => {
    expect(determineOutcome({ content: 'line1\nline2\nline3' })).toBe('success (3 lines)');
  });

  test('success with array content blocks', () => {
    expect(determineOutcome({ content: [{ type: 'text', text: 'a\nb' }] })).toBe('success (2 lines)');
  });

  test('long error is truncated to 60 chars with a marker carrying the full length', () => {
    const text = 'E'.repeat(60) + 'tail-beyond-budget';
    expect(determineOutcome({ is_error: true, content: text })).toBe(
      `error: ${'E'.repeat(60)}...[truncated, ${text.length} chars]`,
    );
  });

  test('error of exactly 60 chars is unchanged', () => {
    const text = 'x'.repeat(60);
    expect(determineOutcome({ is_error: true, content: text })).toBe(`error: ${text}`);
  });

  test('maxErrorChars is a literal budget, including 0', () => {
    const text = 'abcdefghij';
    expect(determineOutcome({ is_error: true, content: text }, { maxErrorChars: 4 })).toBe('error: abcd...[truncated, 10 chars]');
    expect(determineOutcome({ is_error: true, content: text }, { maxErrorChars: 0 })).toBe('error: ...[truncated, 10 chars]');
    expect(determineOutcome({ is_error: true, content: text }, { maxErrorChars: 10 })).toBe('error: abcdefghij');
    expect(determineOutcome({ is_error: true, content: text }, { maxErrorChars: 500 })).toBe('error: abcdefghij');
  });

  test('non-error branches ignore the budget', () => {
    const opts = { maxErrorChars: 0 };
    expect(determineOutcome({ content: 'ok' }, opts)).toBe('success');
    expect(determineOutcome({ content: 'a\nb\nc' }, opts)).toBe('success (3 lines)');
    expect(determineOutcome({ content: '' }, opts)).toBe('empty');
    expect(determineOutcome(null, opts)).toBe('no_result');
  });

  test('undefined returns no_result like null', () => {
    expect(determineOutcome(undefined)).toBe('no_result');
  });

  test('isFailedOutcome stays true for truncated errors', () => {
    expect(isFailedOutcome(determineOutcome({ is_error: true, content: 'z'.repeat(500) }))).toBe(true);
    expect(isFailedOutcome(determineOutcome({ is_error: true, content: 'z'.repeat(500) }, { maxErrorChars: 0 }))).toBe(true);
  });

  test('works inside Array.map with one argument', () => {
    const results = [{ is_error: true, content: 'q'.repeat(100) }, { content: 'ok' }];
    expect(results.map(r => determineOutcome(r))).toEqual([
      `error: ${'q'.repeat(60)}...[truncated, 100 chars]`,
      'success',
    ]);
  });
});

describe('outcomeHash', () => {
  const sha12 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

  test('returns null for missing, success and empty non-error results', () => {
    expect(outcomeHash(null)).toBeNull();
    expect(outcomeHash(undefined)).toBeNull();
    expect(outcomeHash({ content: 'ok' })).toBeNull();
    expect(outcomeHash({ content: 'a\nb' })).toBeNull();
    expect(outcomeHash({ content: '' })).toBeNull();
    expect(outcomeHash({ content: [] })).toBeNull();
    expect(outcomeHash({ is_error: false, content: 'boom' })).toBeNull();
  });

  test('known vectors', () => {
    expect(outcomeHash({ is_error: true, content: '' })).toBe('e3b0c44298fc');
    expect(outcomeHash({ is_error: true, content: '\u00e9' })).toBe('4a99557e4033');
  });

  test('"no text" error results hash the empty string', () => {
    expect(outcomeHash({ is_error: true })).toBe('e3b0c44298fc');
    expect(outcomeHash({ is_error: true, content: [{ type: 'image' }] as any })).toBe('e3b0c44298fc');
    expect(outcomeHash({ is_error: true, content: [null] as any })).toBe('e3b0c44298fc');
  });

  test('is 12 lowercase hex chars matching an independent SHA-256', () => {
    const text = 'something went wrong in /some/path/file.ts:42';
    const hash = outcomeHash({ is_error: true, content: text });
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).toBe(sha12(text));
  });

  test('string and array text-block content hash equal; blocks are joined', () => {
    const asString = outcomeHash({ is_error: true, content: 'part one part two' });
    const asArray = outcomeHash({
      is_error: true,
      content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] as any,
    });
    expect(asArray).toBe(asString);
  });

  test('same-length errors sharing a long prefix: identical outcomes, different hashes', () => {
    const prefix = 'This session is isolated in the worktree /some/long/path/to/worktree, but this command ';
    expect(prefix.length).toBeGreaterThan(60);
    const a = `${prefix}touches /repo/src/alpha.ts which is outside it.`;
    const b = `${prefix}touches /repo/src/bravo.ts which is outside it.`;
    expect(a.length).toBe(b.length);
    const ra = { is_error: true, content: a };
    const rb = { is_error: true, content: b };
    expect(determineOutcome(ra)).toBe(determineOutcome(rb));
    expect(outcomeHash(ra)).not.toBe(outcomeHash(rb));
    expect(outcomeHash(ra)).toBe(sha12(a));
    expect(outcomeHash(rb)).toBe(sha12(b));
  });

  test('does not depend on the display budget', () => {
    const r = { is_error: true, content: 'w'.repeat(200) };
    expect(determineOutcome(r, { maxErrorChars: 0 })).not.toBe(determineOutcome(r, { maxErrorChars: 500 }));
    expect(outcomeHash(r)).toBe(sha12('w'.repeat(200)));
  });
});

describe('isFailedOutcome', () => {
  test('error and empty outcomes are failures', () => {
    expect(isFailedOutcome('error: boom')).toBe(true);
    expect(isFailedOutcome('error: ')).toBe(true);
    expect(isFailedOutcome('empty')).toBe(true);
  });

  test('success and no_result are not failures', () => {
    expect(isFailedOutcome('success')).toBe(false);
    expect(isFailedOutcome('success (3 lines)')).toBe(false);
    expect(isFailedOutcome('no_result')).toBe(false);
  });
});

describe('isFailedResult parity with isFailedOutcome(determineOutcome(r))', () => {
  const cases: Array<{ name: string; result: { is_error?: boolean; content?: any } | null | undefined }> = [
    { name: 'null', result: null },
    { name: 'undefined', result: undefined },
    { name: 'error string', result: { is_error: true, content: 'file not found' } },
    { name: 'error array', result: { is_error: true, content: [{ type: 'text', text: 'bad input' }] } },
    { name: 'error no content', result: { is_error: true } },
    { name: 'empty string', result: { content: '' } },
    { name: 'undefined content', result: { content: undefined } },
    { name: 'empty array', result: { content: [] } },
    { name: 'single line', result: { content: 'ok' } },
    { name: 'multi line', result: { content: 'line1\nline2\nline3' } },
    { name: 'array blocks', result: { content: [{ type: 'text', text: 'a\nb' }] } },
    { name: 'array of non-text blocks', result: { content: [{ type: 'image' }] } },
    { name: 'malformed [null]', result: { content: [null] } },
    { name: 'malformed [{}]', result: { content: [{}] } },
    { name: 'malformed error [null]', result: { is_error: true, content: [null] } },
  ];

  for (const { name, result } of cases) {
    test(name, () => {
      expect(isFailedResult(result as any)).toBe(isFailedOutcome(determineOutcome((result ?? null) as any)));
    });
  }

  test('missing result is not a failure', () => {
    expect(isFailedResult(undefined)).toBe(false);
    expect(isFailedResult(null)).toBe(false);
  });

  describe('outcomeHash invariant: non-null iff determineOutcome starts with "error:"', () => {
    for (const { name, result } of cases) {
      test(name, () => {
        const hashed = outcomeHash(result as any) !== null;
        expect(hashed).toBe(determineOutcome(result as any).startsWith('error:'));
      });
    }
  });
});

describe('malformed tool_result content tolerance', () => {
  test('extractContentText tolerates [null] and [{}] sub-blocks', () => {
    expect(extractContentText([null] as any)).toBe('');
    expect(extractContentText([{}] as any)).toBe('');
    expect(extractContentText([null, { type: 'text', text: 'a' }, {}, { type: 'text', text: 'b' }] as any)).toBe('ab');
  });

  test('determineOutcome tolerates [null] and [{}] sub-blocks', () => {
    expect(determineOutcome({ content: [null] as any })).toBe('success');
    expect(determineOutcome({ content: [{}] as any })).toBe('success');
    expect(determineOutcome({ is_error: true, content: [null] as any })).toBe('error: ');
    expect(determineOutcome({ is_error: true, content: [{}] as any })).toBe('error: ');
  });
});

describe('buildToolResultLocations', () => {
  const entries: any[] = [
    { type: 'summary', summary: 'ignored' },
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
    },
    { type: 'system', subtype: 'noise' },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:02Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'out a' },
          { type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'err b' }] },
          null,
        ],
      },
    },
  ];

  test('turn follows userAssistantEntries numbering for raw entries', () => {
    const map = buildToolResultLocations(entries);
    expect(map.get('a')?.turn).toBe(3);
    expect(map.get('b')?.turn).toBe(3);
  });

  test('turn is identical for already-filtered entries', () => {
    const map = buildToolResultLocations(userAssistantEntries(entries));
    expect(map.get('a')?.turn).toBe(3);
  });

  test('locates every result in one entry with string and array content', () => {
    const map = buildToolResultLocations(entries);
    expect(map.size).toBe(2);
    expect(map.get('a')).toEqual({ is_error: false, content: 'out a', result_ts: '2026-01-01T00:00:02Z', turn: 3 });
    expect(map.get('b')).toEqual({
      is_error: true,
      content: [{ type: 'text', text: 'err b' }],
      result_ts: '2026-01-01T00:00:02Z',
      turn: 3,
    });
  });

  test('ignores user entries with string content', () => {
    const map = buildToolResultLocations([
      { type: 'user', message: { role: 'user', content: 'tool_use_id: a' } } as any,
    ]);
    expect(map.size).toBe(0);
  });

  test('a result written before its tool_use still pairs', () => {
    const map = buildToolResultLocations([
      { type: 'user', timestamp: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early', content: 'x' }] } },
      { type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'early', name: 'Bash', input: {} }] } },
    ] as any);
    expect(map.get('early')?.turn).toBe(1);
  });

  test('duplicate ids resolve last-wins', () => {
    const map = buildToolResultLocations([
      { type: 'user', timestamp: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', content: 'first' }] } },
      { type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', content: 'second' }] } },
    ] as any);
    expect(map.get('d')?.content).toBe('second');
    expect(map.get('d')?.turn).toBe(2);
  });
});

// ============================================================================
// parseIntArg
// ============================================================================

describe('evaluateResultSelectors', () => {
  const ok = (content: any, is_error = false) => ({ is_error, content, result_ts: '2026-04-01T10:02:00Z' });

  test('matcher only: substring matches case-insensitively and returns a snippet', () => {
    const r = evaluateResultSelectors(ok('Build FAILED here'), { outputMatcher: parseSubstringMatcher('failed'), failed: false });
    expect(r).toEqual({ matched: true, snippet: 'Build FAILED here' });
    expect(evaluateResultSelectors(ok('all good'), { outputMatcher: parseSubstringMatcher('failed'), failed: false })).toEqual({ matched: false });
  });

  test('matcher only: regex is case-sensitive', () => {
    const matcher = parseRegexMatcher('FAIL \\d', '--output-regex');
    expect(evaluateResultSelectors(ok('FAIL 3'), { outputMatcher: matcher, failed: false }).matched).toBe(true);
    expect(evaluateResultSelectors(ok('fail 3'), { outputMatcher: matcher, failed: false }).matched).toBe(false);
  });

  test('failed only: matches is_error results and uses the leading text as snippet', () => {
    const r = evaluateResultSelectors(ok('old_string not found', true), { outputMatcher: null, failed: true });
    expect(r).toEqual({ matched: true, snippet: 'old_string not found' });
    expect(evaluateResultSelectors(ok('fine'), { outputMatcher: null, failed: true })).toEqual({ matched: false });
  });

  test('failed only: truncates the snippet to the evidence window', () => {
    const long = 'x'.repeat(500);
    const r = evaluateResultSelectors(ok(long, true), { outputMatcher: null, failed: true });
    expect(r.matched && r.snippet?.length).toBe(200);
  });

  test('both selectors are ANDed', () => {
    const selectors = { outputMatcher: parseSubstringMatcher('boom'), failed: true };
    expect(evaluateResultSelectors(ok('boom', true), selectors).matched).toBe(true);
    expect(evaluateResultSelectors(ok('boom', false), selectors).matched).toBe(false);
    expect(evaluateResultSelectors(ok('other', true), selectors).matched).toBe(false);
  });

  test('missing result never matches, even for --failed', () => {
    expect(evaluateResultSelectors(undefined, { outputMatcher: null, failed: true })).toEqual({ matched: false });
    expect(evaluateResultSelectors(undefined, { outputMatcher: parseSubstringMatcher('x'), failed: false })).toEqual({ matched: false });
  });

  test('empty failed output yields an undefined snippet', () => {
    const r = evaluateResultSelectors(ok('', false), { outputMatcher: null, failed: true });
    expect(r).toEqual({ matched: true, snippet: undefined });
    expect(r.matched && 'snippet' in r && r.snippet).toBeUndefined();
  });

  test('snippet is a 200-char window centered on the match', () => {
    const text = `${'a'.repeat(400)}NEEDLE${'b'.repeat(400)}`;
    const r = evaluateResultSelectors(ok(text), { outputMatcher: parseSubstringMatcher('needle'), failed: false });
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.snippet?.length).toBe(200);
      expect(r.snippet).toContain('NEEDLE');
      expect(r.snippet?.indexOf('NEEDLE')).toBeGreaterThan(90);
      expect(r.snippet?.indexOf('NEEDLE')).toBeLessThan(105);
    }
  });

  test('array content and malformed sub-blocks do not throw', () => {
    const matcher = parseSubstringMatcher('hello');
    expect(evaluateResultSelectors(ok([{ type: 'text', text: 'hello world' }]), { outputMatcher: matcher, failed: false }).matched).toBe(true);
    expect(evaluateResultSelectors(ok([null, {}] as any), { outputMatcher: matcher, failed: false }).matched).toBe(false);
    expect(evaluateResultSelectors(ok([null] as any, true), { outputMatcher: null, failed: true })).toEqual({ matched: true, snippet: undefined });
  });
});

describe('matchedToolCalls with toolOutput', () => {
  const ev = (kind: SearchEvidence['kind'], turn: number, block_index: number, agent_id?: string): SearchEvidence => ({
    kind, turn, block_index, timestamp: null, tool: 'Bash', input_summary: 'cmd', ...(agent_id !== undefined ? { agent_id } : {}),
  });

  test('tool_output alone returns one item per call', () => {
    const out = matchedToolCalls([ev('tool_output', 2, 0), ev('tool_output', 2, 1), ev('tool_input', 4, 0)], { toolInput: false, bash: false, toolOutput: true });
    expect(out.map(e => [e.turn, e.block_index])).toEqual([[2, 0], [2, 1]]);
    expect(out.every(e => e.kind === 'tool_output')).toBe(true);
  });

  test('intersects tool_output with tool_input and bash by call key', () => {
    const evidence = [
      ev('tool_input', 2, 0), ev('bash', 2, 0), ev('tool_output', 2, 0),
      ev('tool_input', 2, 1), ev('tool_output', 2, 1),
      ev('bash', 4, 0),
    ];
    expect(matchedToolCalls(evidence, { toolInput: true, bash: false, toolOutput: true }).map(e => [e.turn, e.block_index])).toEqual([[2, 0], [2, 1]]);
    expect(matchedToolCalls(evidence, { toolInput: true, bash: true, toolOutput: true }).map(e => [e.turn, e.block_index])).toEqual([[2, 0]]);
  });

  test('agent_id is part of the call key', () => {
    const evidence = [ev('tool_input', 2, 0, 'sub1'), ev('tool_output', 2, 0), ev('tool_output', 2, 0, 'sub2')];
    expect(matchedToolCalls(evidence, { toolInput: true, bash: false, toolOutput: true })).toEqual([]);
    const both = [ev('tool_input', 2, 0, 'sub1'), ev('tool_output', 2, 0, 'sub1')];
    expect(matchedToolCalls(both, { toolInput: true, bash: false, toolOutput: true })).toHaveLength(1);
  });

  test('toolOutput omitted behaves as before', () => {
    const out = matchedToolCalls([ev('tool_input', 2, 0), ev('tool_output', 2, 0)], { toolInput: true, bash: false });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('tool_input');
  });
});

describe('toolInputSamplesFromEvidence with tool_output', () => {
  test('includes tool_output items with the ToolInputMatch shape', () => {
    const samples = toolInputSamplesFromEvidence([
      { kind: 'tool_output', turn: 2, block_index: 1, timestamp: null, tool: 'Bash', input_summary: 'npm test', tool_use_id: 'bash_b', result_turn: 3 },
      { kind: 'text', turn: 1, block_index: 0, timestamp: null, tool: 'Ignored' },
    ]);
    expect(samples).toEqual([{ tool: 'Bash', input_summary: 'npm test', turn: 2 }]);
  });
});

describe('parseIntArg', () => {
  test('undefined returns undefined', () => {
    expect(parseIntArg(undefined, 'test')).toBeUndefined();
  });

  test('valid number string', () => {
    expect(parseIntArg('42', 'test')).toBe(42);
  });

  test('zero is valid', () => {
    expect(parseIntArg('0', 'test')).toBe(0);
  });

  test('negative throws', () => {
    expect(() => parseIntArg('-1', 'test')).toThrow('non-negative integer');
  });

  test('non-numeric throws', () => {
    expect(() => parseIntArg('abc', 'test')).toThrow('non-negative integer');
  });
});

// ============================================================================
// parseSince
// ============================================================================

describe('parseSince', () => {
  test('parses days', () => {
    const result = parseSince('1d');
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(86_400_000 - 1000);
    expect(diff).toBeLessThan(86_400_000 + 1000);
  });

  test('parses hours', () => {
    const result = parseSince('2h');
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(7_200_000 - 1000);
    expect(diff).toBeLessThan(7_200_000 + 1000);
  });

  test('parses minutes', () => {
    const result = parseSince('30m');
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(1_800_000 - 1000);
    expect(diff).toBeLessThan(1_800_000 + 1000);
  });

  test('parses weeks', () => {
    const result = parseSince('1w');
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(604_800_000 - 1000);
    expect(diff).toBeLessThan(604_800_000 + 1000);
  });

  test('parses seconds', () => {
    const result = parseSince('10s');
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(10_000 - 1000);
    expect(diff).toBeLessThan(10_000 + 1000);
  });

  test('returns valid ISO string', () => {
    const result = parseSince('1d');
    expect(new Date(result).toISOString()).toBe(result);
  });

  test('throws on invalid format', () => {
    expect(() => parseSince('abc')).toThrow('Invalid --since duration');
  });

  test('throws on zero amount', () => {
    expect(() => parseSince('0d')).toThrow('amount must be positive');
  });

  test('throws on invalid unit', () => {
    expect(() => parseSince('1x')).toThrow('Invalid --since duration');
  });

  test('throws on negative (no match)', () => {
    expect(() => parseSince('-1h')).toThrow('Invalid --since duration');
  });
});

describe('parseDateArg', () => {
  test('returns null when the value is absent', () => {
    expect(parseDateArg(undefined, '--before', 'end')).toBeNull();
  });

  test('widens a bare date to an inclusive whole-day UTC boundary', () => {
    // --after anchors the day's start, --before its end, so the named day is
    // included on both ends rather than silently dropped by lexicographic sort.
    expect(parseDateArg('2026-01-09', '--after', 'start')).toBe('2026-01-09T00:00:00.000Z');
    expect(parseDateArg('2026-01-09', '--before', 'end')).toBe('2026-01-09T23:59:59.999Z');
  });

  test('canonicalizes a UTC timestamp to millisecond precision', () => {
    expect(parseDateArg('2026-01-09T14:30:00Z', '--after', 'start')).toBe('2026-01-09T14:30:00.000Z');
  });

  test('converts an offset timestamp to UTC so it sorts correctly', () => {
    expect(parseDateArg('2026-01-09T14:30:00+02:00', '--before', 'end')).toBe('2026-01-09T12:30:00.000Z');
  });

  test('rejects a time without a timezone', () => {
    expect(() => parseDateArg('2026-01-09T14:30', '--before', 'end')).toThrow('Invalid --before date');
    expect(() => parseDateArg('2026-01-09T14:30:00', '--after', 'start')).toThrow('Invalid --after date');
  });

  test('rejects malformed or unpadded values', () => {
    expect(() => parseDateArg('2026-1-9', '--after', 'start')).toThrow('Invalid --after date');
    expect(() => parseDateArg('yesterday', '--before', 'end')).toThrow('Invalid --before date');
    expect(() => parseDateArg('2026-13-40', '--after', 'start')).toThrow('Invalid --after date');
  });
});

// ============================================================================
// Claude project discovery helpers
// ============================================================================

describe('Claude project discovery helpers', () => {
  test('mangleProjectPath converts absolute paths to Claude project names', () => {
    expect(mangleProjectPath('/tmp/example')).toBe('-tmp-example');
  });

  test('mangleProjectPath normalizes path-equivalent project inputs', () => {
    expect(mangleProjectPath('/tmp/example/')).toBe(mangleProjectPath('/tmp/example'));
    expect(mangleProjectPath('/tmp/example/./')).toBe(mangleProjectPath('/tmp/example'));
  });

  // Encoding-sensitive expectations below are hardcoded literals on purpose: a fixture derived from the
  // encoder agrees with any encoder, which is how the original dot-handling bug went unnoticed.
  test('mangleProjectPath maps every non-alphanumeric character to a hyphen like Claude Code', () => {
    // Issue example: the '.' of '.claude' becomes '-', so the worktree dir has a double dash.
    expect(mangleProjectPath('/workspace/app/.claude/worktrees/feature-a')).toBe('-workspace-app--claude-worktrees-feature-a');
    // macOS tmpdir shape contains an underscore.
    expect(mangleProjectPath('/var/folders/_t/abc/T/x')).toBe('-var-folders--t-abc-T-x');
    expect(mangleProjectPath('/workspace/My App - v2/pkg')).toBe('-workspace-My-App---v2-pkg');
    expect(mangleProjectPath('/work/repo/.notes/042_draft_plan')).toBe('-work-repo--notes-042-draft-plan');
    expect(mangleProjectPath('/work/a@b+c/pkg')).toBe('-work-a-b-c-pkg');
  });

  test('mangleProjectPath NFC-normalizes and encodes per UTF-16 code unit', () => {
    const precomposed = '/tmp/caf\u00e9';
    const decomposed = '/tmp/cafe\u0301';
    expect(precomposed).not.toBe(decomposed);
    expect(mangleProjectPath(precomposed)).toBe('-tmp-caf-');
    expect(mangleProjectPath(decomposed)).toBe('-tmp-caf-');
    // An astral character is two UTF-16 code units, so it yields two hyphens.
    expect(mangleProjectPath('/tmp/\u{1F600}')).toBe('-tmp---');
  });

  test('mangleProjectPath output only ever contains alphanumerics and hyphens', () => {
    const inputs = [
      '/tmp/../..',
      '/a/..b',
      '/a/b\nc',
      '/a/b\\c',
      `/workspace/${'a'.repeat(300)}`,
      '/tmp/caf\u00e9/\u{1F600}/na\u00efve',
    ];
    for (const input of inputs) {
      expect(mangleProjectPath(input)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  // The suffixes f06yf, qm5yvc and 16gmfc were computed with the reference algorithm during planning,
  // not observed from Claude Code. The Java String.hashCode oracle test below is the independent check.
  test('claudeProjectPathHash matches Java String.hashCode as base36 of the JS absolute value', () => {
    // Inputs and Java hashCode values: '' = 0, 'a' = 97, 'hello' = 99162322, 'Hello World' = -862545276,
    // 'polygenelubricants' = Integer.MIN_VALUE (JS Math.abs gives +2147483648, unlike Java's Math.abs).
    expect(claudeProjectPathHash('')).toBe('0');
    expect(claudeProjectPathHash('a')).toBe('2p');
    expect(claudeProjectPathHash('hello')).toBe('1n1e4y');
    expect(claudeProjectPathHash('Hello World')).toBe('e9jc70');
    expect(claudeProjectPathHash('polygenelubricants')).toBe('zik0zk');
  });

  test('mangleProjectPath truncates names over 200 chars and appends the path hash', () => {
    const exactly200 = `/workspace/${'a'.repeat(189)}`;
    expect(mangleProjectPath(exactly200)).toBe(`-workspace-${'a'.repeat(189)}`);
    expect(mangleProjectPath(exactly200)).toHaveLength(200);

    const over200 = `/workspace/${'a'.repeat(190)}`;
    expect(mangleProjectPath(over200)).toBe(`-workspace-${'a'.repeat(189)}-f06yf`);
  });

  test('mangleProjectPath hashes the unsanitized path of a truncated nested worktree', () => {
    const nested = `/workspace/app/.claude/worktrees/${'x'.repeat(100)}/.claude/worktrees/${'y'.repeat(80)}`;
    const encoded = mangleProjectPath(nested);
    expect(encoded).toBe(`-workspace-app--claude-worktrees-${'x'.repeat(100)}--claude-worktrees-${'y'.repeat(48)}-qm5yvc`);
    expect(encoded).toHaveLength(207);
  });

  test('mangleProjectPath hashes the NFC-normalized path', () => {
    // Sanitized NFC length is 201. Hashing the NFD input instead would give suffix ygso7h.
    const input = `/workspace/${'a'.repeat(185)}/cafe\u0301`;
    expect(input.normalize('NFC')).not.toBe(input);
    expect(mangleProjectPath(input)).toBe(`-workspace-${'a'.repeat(185)}-caf-16gmfc`);
  });

  test('claudeProjectsRoot can resolve from an explicit home directory', () => {
    expect(claudeProjectsRoot('/tmp/example-home')).toBe('/tmp/example-home/.claude/projects');
  });

  test('projectPathGuessFromClaudeProject converts mangled names to best-effort paths', () => {
    expect(projectPathGuessFromClaudeProject('-tmp-example')).toBe('/tmp/example');
  });

  test('projectPathGuessFromClaudeProject returns null for non-mangled names', () => {
    expect(projectPathGuessFromClaudeProject('tmp-example')).toBeNull();
  });

  test('listClaudeProjectRefs returns directories and skips files', () => {
    const unique = uniqueTempName('cc-session-tool-project-refs');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const dirProject = `-${unique}-dir`;
    const worktreeProject = `-${unique}-worktree`;
    const fileProject = `-${unique}-file`;

    mkdirSync(join(root, dirProject), { recursive: true });
    mkdirSync(join(root, worktreeProject), { recursive: true });
    writeFileSync(join(root, fileProject), '');

    try {
      const refs = listClaudeProjectRefs(root);
      const projects = refs.map(ref => ref.project);
      expect(projects).toContain(dirProject);
      expect(projects).toContain(worktreeProject);
      expect(projects).not.toContain(fileProject);

      const ref = refs.find(ref => ref.project === dirProject);
      expect(ref).toEqual({
        project: dirProject,
        claude_dir: join(root, dirProject),
        project_path_guess: projectPathGuessFromClaudeProject(dirProject),
      });
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  const projectRefNamed = (project: string) => ({
    project,
    claude_dir: join('/tmp/claude/projects', project),
    project_path_guess: projectPathGuessFromClaudeProject(project),
  });

  test('findRelatedProjectRefs returns double-dash worktree project names under the project path', () => {
    const refs = [
      projectRefNamed('-tmp-repo--claude-worktrees-feature-a'),
      projectRefNamed('-tmp-repo--claude-worktrees-feature-b'),
      {
        ...projectRefNamed('-tmp-repo--claude-worktrees-feature-b'),
        claude_dir: '/tmp/claude/projects/-tmp-repo--claude-worktrees-feature-b-duplicate',
      },
      projectRefNamed('-tmp-repo-other'),
      {
        project: 'not-mangled',
        claude_dir: '/tmp/claude/projects/not-mangled',
        project_path_guess: null,
      },
    ];

    expect(findRelatedProjectRefs('/tmp/repo/', refs)).toEqual([refs[0]!, refs[1]!]);
  });

  test('findRelatedProjectRefs does not return the dot-shaped worktree name Claude Code never writes', () => {
    const refs = [
      projectRefNamed('-tmp-repo-.claude-worktrees-feature-c'),
      projectRefNamed('-tmp-repo--claude-worktrees-feature-a'),
    ];

    expect(findRelatedProjectRefs('/tmp/repo', refs)).toEqual([refs[1]!]);
  });

  test('findRelatedProjectRefs handles hyphenated project paths without relying on path guesses', () => {
    const projectPath = '/tmp/cc-session-tool/cc-session-tool';
    const refs = [
      projectRefNamed('-tmp-cc-session-tool-cc-session-tool--claude-worktrees-feature-a'),
      projectRefNamed('-tmp-cc-session-tool-cc-session-tool--claude-worktrees-feature-b'),
      projectRefNamed('-tmp-cc-session-tool-other'),
      projectRefNamed('-tmp-cc-session-tool-cc-session-tool-other--claude-worktrees-feature-c'),
    ];

    expect(refs[0]!.project_path_guess).not.toStartWith(`${projectPath}/.claude/worktrees/`);
    expect(refs[1]!.project_path_guess).not.toStartWith(`${projectPath}/.claude/worktrees/`);
    expect(findRelatedProjectRefs(projectPath, refs)).toEqual([refs[0]!, refs[1]!]);
  });

  test('findRelatedProjectRefs matches repo paths containing dots and underscores', () => {
    const refs = [
      projectRefNamed('-tmp-my-app-v2--claude-worktrees-x'),
      projectRefNamed('-tmp-my-app-v2-other--claude-worktrees-x'),
    ];

    expect(findRelatedProjectRefs('/tmp/my_app.v2', refs)).toEqual([refs[0]!]);
  });

  test('findRelatedProjectRefs matches a truncated nested worktree name', () => {
    // Nested path is 232 sanitized chars, so Claude Code stores its first 200 chars plus the pinned qm5yvc hash.
    const repo = `/workspace/app/.claude/worktrees/${'x'.repeat(100)}`;
    const nestedProject = `-workspace-app--claude-worktrees-${'x'.repeat(100)}--claude-worktrees-${'y'.repeat(48)}-qm5yvc`;
    expect(mangleProjectPath(`${repo}/.claude/worktrees/${'y'.repeat(80)}`)).toBe(nestedProject);
    const refs = [projectRefNamed(nestedProject)];

    expect(findRelatedProjectRefs(repo, refs)).toEqual(refs);
  });

  test('findRelatedProjectRefs prefix guard ignores lookalikes at 200 chars and returns nothing past it', () => {
    const lookalike = (head: string, suffix: string) => projectRefNamed(`${head}a-${suffix}`);

    // Prefix of exactly 200 chars: sanitized repo of 181 chars.
    const repo181 = `-r-${'a'.repeat(178)}`;
    const head199 = `${repo181}--claude-worktrees`;
    const real200 = projectRefNamed(`${head199}--abc123`);
    expect(findRelatedProjectRefs(`/r/${'a'.repeat(178)}`, [real200, lookalike(head199, 'def456')])).toEqual([real200]);

    // Prefix of exactly 201 chars: sanitized repo of 182 chars. The trailing '-' lines up with the truncation
    // separator, so real and lookalike names share the 200-char head. The guard returns no refs rather than both.
    const repo182 = `-r-${'a'.repeat(179)}`;
    const head200 = `${repo182}--claude-worktrees`;
    expect(head200).toHaveLength(200);
    const real201 = projectRefNamed(`${head200}-abc123`);
    const fake201 = projectRefNamed(`${head200}-def456`);
    expect(findRelatedProjectRefs(`/r/${'a'.repeat(179)}`, [real201, fake201])).toEqual([]);
  });

  test('isPathWithinOrEqual is separator-safe', () => {
    expect(isPathWithinOrEqual('/tmp/repo/file.ts', '/tmp/repo')).toBe(true);
    expect(isPathWithinOrEqual('/tmp/repo', '/tmp/repo')).toBe(true);
    expect(isPathWithinOrEqual('/tmp/repo2/file.ts', '/tmp/repo')).toBe(false);
  });

  test('normalizePathForContainment removes trailing slashes', () => {
    expect(normalizePathForContainment('/tmp/example/')).toBe('/tmp/example');
  });

  test('pathContainmentCandidates preserves lexical path when realpath is unavailable', () => {
    expect(pathContainmentCandidates('/tmp/no-such-cc-session-tool-path')).toContain('/tmp/no-such-cc-session-tool-path');
  });

  test('buildScopedSearchScope returns main context only when worktrees are excluded', () => {
    const unique = uniqueTempName('cc-session-tool-scope-main');
    const root = join(SHORT_TMP_ROOT, unique, '.claude', 'projects');
    const projectPath = join(SHORT_TMP_ROOT, unique, 'repo');
    const claudeDir = join(root, mangleProjectPath(projectPath));
    const worktreeProject = `${mangleProjectPath(projectPath)}--claude-worktrees-feature-a`;

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(root, worktreeProject), { recursive: true });

    try {
      const scope = buildScopedSearchScope({ projectPath, claudeProjectsRoot: root, includeWorktrees: false });
      expect(scope.projectRoot).toBe(normalizePathForContainment(projectPath));
      expect(scope.projects).toHaveLength(1);
      expect(scope.projects[0]).toEqual({
        role: 'main',
        projectRoot: projectPath,
        worktreeRoot: null,
        projectRef: {
          project: mangleProjectPath(projectPath),
          claude_dir: claudeDir,
          project_path_guess: projectPath,
        },
      });
    } finally {
      rmSync(join(SHORT_TMP_ROOT, unique), { recursive: true, force: true });
    }
  });

  test('buildScopedSearchScope includes related hyphenated worktree refs without reverse-mangling', () => {
    const unique = uniqueTempName('cc-session-tool-scope-worktree');
    const root = join(SHORT_TMP_ROOT, unique, '.claude', 'projects');
    const projectPath = join(SHORT_TMP_ROOT, unique, 'cc-session-tool', 'cc-session-tool');
    const mainProject = mangleProjectPath(projectPath);
    const worktreeProjectA = `${mainProject}--claude-worktrees-feature-a`;
    const worktreeProjectB = `${mainProject}--claude-worktrees-feature-b`;
    const siblingProject = mangleProjectPath(join(SHORT_TMP_ROOT, unique, 'cc-session-tool-other'));

    mkdirSync(join(root, mainProject), { recursive: true });
    mkdirSync(join(root, worktreeProjectA), { recursive: true });
    mkdirSync(join(root, worktreeProjectB), { recursive: true });
    mkdirSync(join(root, siblingProject), { recursive: true });

    try {
      const scope = buildScopedSearchScope({ projectPath, claudeProjectsRoot: root, includeWorktrees: true });
      expect(scope.projects.map(context => context.role)).toEqual(['main', 'worktree', 'worktree']);
      expect(scope.projects[1]!.projectRef.project).toBe(worktreeProjectA);
      expect(scope.projects[1]!.projectRef.project_path_guess).toBe(projectPathGuessFromClaudeProject(worktreeProjectA));
      expect(scope.projects[1]!.worktreeRoot).toBeNull();
      expect(scope.projects[2]!.projectRef.project).toBe(worktreeProjectB);
      expect(scope.projects[2]!.projectRef.project_path_guess).toBe(projectPathGuessFromClaudeProject(worktreeProjectB));
      expect(scope.projects[2]!.worktreeRoot).toBeNull();
    } finally {
      rmSync(join(SHORT_TMP_ROOT, unique), { recursive: true, force: true });
    }
  });

  test('buildScopedSearchScope from a worktree path resolves that worktree dir and excludes parent and siblings', () => {
    const unique = uniqueTempName('cc-session-tool-scope-from-worktree');
    const root = join(SHORT_TMP_ROOT, unique, '.claude', 'projects');
    const repoPath = join(SHORT_TMP_ROOT, unique, 'repo');
    const projectPath = join(repoPath, '.claude', 'worktrees', 'feature-a');
    const repoProject = mangleProjectPath(repoPath);
    const worktreeProject = `${repoProject}--claude-worktrees-feature-a`;
    const siblingProject = `${repoProject}--claude-worktrees-feature-b`;

    mkdirSync(join(root, repoProject), { recursive: true });
    mkdirSync(join(root, worktreeProject), { recursive: true });
    mkdirSync(join(root, siblingProject), { recursive: true });

    try {
      expect(resolveClaudeProjectDir(projectPath, root)).toBe(join(root, worktreeProject));
      const scope = buildScopedSearchScope({ projectPath, claudeProjectsRoot: root, includeWorktrees: true });
      expect(scope.projects.map(context => context.role)).toEqual(['main']);
      expect(scope.projects[0]!.projectRef.project).toBe(worktreeProject);
      expect(scope.projects[0]!.projectRef.claude_dir).toBe(join(root, worktreeProject));
    } finally {
      rmSync(join(SHORT_TMP_ROOT, unique), { recursive: true, force: true });
    }
  });

  test('buildScopedSearchScope tolerates a missing Claude projects root after main project resolves', () => {
    const unique = uniqueTempName('cc-session-tool-scope-missing-root');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'repo');
    mkdirSync(join(root, mangleProjectPath(projectPath)), { recursive: true });

    try {
      const scope = buildScopedSearchScope({
        projectPath,
        claudeProjectsRoot: root,
        includeWorktrees: true,
      });
      expect(scope.projects).toHaveLength(1);
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('listSearchTargetsForContext includes context on targets', () => {
    const unique = uniqueTempName('cc-session-tool-target-context');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'repo');
    const claudeDir = join(root, mangleProjectPath(projectPath));
    const session = '11111111-2222-3333-4444-555555555555';
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, `${session}.jsonl`), JSON.stringify({ type: 'user' }) + '\n');

    try {
      const context = buildScopedSearchScope({ projectPath, claudeProjectsRoot: root, includeWorktrees: false }).projects[0]!;
      const targets = listSearchTargetsForContext(context);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({
        filePath: join(claudeDir, `${session}.jsonl`),
        sessionId: session,
        context,
        projectRef: context.projectRef,
      });
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('scanProjectContexts skips missing Claude project directories', async () => {
    const context = {
      role: 'global' as const,
      projectRoot: null,
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-missing-project',
        claude_dir: join(tmpdir(), uniqueTempName('cc-session-tool-missing')),
        project_path_guess: '/tmp/missing/project',
      },
    };

    const result = await scanProjectContexts([context], { tool: 'Read' }, null);
    expect(result).toEqual({ matches: [] });
  });

  test('projectMatchesGlob supports wildcards and escapes regex metacharacters', () => {
    const ref = {
      project: '-tmp-cc-session-tool-[literal]-project',
      claude_dir: '/tmp/claude/projects/-tmp-cc-session-tool-[literal]-project',
      project_path_guess: '/tmp/cc-session-tool/[literal]/project',
    };

    expect(projectMatchesGlob(ref, '*[literal]-project')).toBe(true);
    expect(projectMatchesGlob(ref, '*[literal]*')).toBe(true);
    expect(projectMatchesGlob(ref, '*literal.-project')).toBe(false);
  });

  test('selectProjectContexts filters all-project contexts and reports skipped projects', () => {
    const unique = uniqueTempName('cc-session-tool-selection');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectA = '/tmp/project-alpha';
    const projectB = '/tmp/project-beta';
    const projectADir = mangleProjectPath(projectA);
    const projectBDir = mangleProjectPath(projectB);

    mkdirSync(join(root, projectADir), { recursive: true });
    mkdirSync(join(root, projectBDir), { recursive: true });

    try {
      const selection = selectProjectContexts({
        mode: 'all-projects',
        claudeProjectsRoot: root,
        projectGlob: '*alpha',
      });
      expect(selection.contexts.map(context => context.projectRef.project)).toEqual([projectADir]);
      expect(buildProjectScanMeta(selection, { includeLists: true }).included_projects).toEqual([{
        project: projectADir,
        project_path_guess: projectPathGuessFromClaudeProject(projectADir),
        project_role: 'global',
      }]);
      expect(selection.skippedProjects).toEqual([{
        project: projectBDir,
        project_path_guess: projectPathGuessFromClaudeProject(projectBDir),
        project_role: 'global',
      }]);
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('extractSessionCwd returns the first transcript cwd', () => {
    expect(extractSessionCwd([
      { type: 'summary' },
      { type: 'user', cwd: '/tmp/repo/.claude/worktrees/feature-a' },
      { type: 'assistant', cwd: '/tmp/other' },
    ])).toBe('/tmp/repo/.claude/worktrees/feature-a');
  });

  test('extractWorktreeStatePaths accepts worktree-state and worktreeState top-level shapes', () => {
    expect(extractWorktreeStatePaths([
      {
        type: 'system',
        'worktree-state': {
          originalCwd: '/tmp/repo',
          worktreePath: '/tmp/repo/.claude/worktrees/feature-a',
        },
      } as any,
    ])).toEqual({
      originalCwd: '/tmp/repo',
      worktreePath: '/tmp/repo/.claude/worktrees/feature-a',
    });

    expect(extractWorktreeStatePaths([
      {
        type: 'system',
        worktreeState: {
          originalCwd: '/tmp/repo-b',
          worktreePath: '/tmp/repo-b/.claude/worktrees/feature-b',
        },
      } as any,
    ])).toEqual({
      originalCwd: '/tmp/repo-b',
      worktreePath: '/tmp/repo-b/.claude/worktrees/feature-b',
    });
  });

  test('extractWorktreeStatePaths ignores malformed and nested worktree metadata', () => {
    expect(extractWorktreeStatePaths([
      { type: 'system', 'worktree-state': 'bad' } as any,
      { type: 'system', worktreeState: { originalCwd: 42, worktreePath: '' } } as any,
      {
        type: 'user',
        message: {
          content: [{
            type: 'text',
            text: JSON.stringify({ worktreeState: { originalCwd: '/tmp/repo' } }),
          }],
        },
      },
    ])).toEqual({
      originalCwd: null,
      worktreePath: null,
    });
  });

  test('buildSearchSessionContext derives accepted roots from cwd, worktree-state, and observed tool paths', () => {
    const projectRoot = '/tmp/repo';
    const cwdWorktreeRoot = '/tmp/repo/.claude/worktrees/cwd-feature';
    const stateWorktreeRoot = '/tmp/repo/.claude/worktrees/state-feature';
    const observedWorktreeRoot = '/tmp/repo/.claude/worktrees/observed-feature';
    const context = buildSearchSessionContext({
      role: 'worktree',
      projectRoot,
      worktreeRoot: null,
      projectRef: {
        project: mangleProjectPath(stateWorktreeRoot),
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/not-authoritative',
      },
    }, [
      { type: 'user', cwd: join(cwdWorktreeRoot, 'src') },
      {
        type: 'system',
        worktreeState: {
          originalCwd: projectRoot,
          worktreePath: join(stateWorktreeRoot, 'nested'),
        },
      } as any,
      {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: join(observedWorktreeRoot, '.claude-tracking/010/plan.md') },
          }],
        },
      },
    ]);

    expect(context.sessionCwd).toBe(join(cwdWorktreeRoot, 'src'));
    expect(context.worktreeStateOriginalCwd).toBe(projectRoot);
    expect(context.worktreeStateWorktreePath).toBe(join(stateWorktreeRoot, 'nested'));
    expect(context.queryAnchorRoot).toBeNull();
    expect(context.normalizedProjectRoots).toContain(projectRoot);
    expect(context.normalizedWorktreeRoots).toContain(cwdWorktreeRoot);
    expect(context.normalizedWorktreeRoots).toContain(stateWorktreeRoot);
    expect(context.normalizedWorktreeRoots).toContain(observedWorktreeRoot);
    expect(context.normalizedWorktreeRoots.indexOf(cwdWorktreeRoot))
      .toBeLessThan(context.normalizedWorktreeRoots.indexOf(stateWorktreeRoot));
    expect(context.normalizedWorktreeRoots.indexOf(stateWorktreeRoot))
      .toBeLessThan(context.normalizedWorktreeRoots.indexOf(observedWorktreeRoot));
    expect(context.pathCandidateCache).toBeInstanceOf(Map);
  });

  test('buildSearchSessionContext ignores out-of-scope metadata and project_path_guess roots', () => {
    const context = buildSearchSessionContext({
      role: 'global',
      projectRoot: null,
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-unrelated',
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/project-path-guess',
      },
    }, [
      { type: 'user', cwd: '/tmp/project-path-guess/.claude/worktrees/feature-a' },
      {
        type: 'system',
        'worktree-state': {
          originalCwd: '/tmp/project-path-guess',
          worktreePath: '/tmp/project-path-guess/.claude/worktrees/feature-a',
        },
      } as any,
      {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/tmp/project-path-guess/.claude/worktrees/feature-a/src/index.ts' },
          }],
        },
      },
    ]);

    expect(context.normalizedProjectRoots).toEqual([]);
    expect(context.normalizedWorktreeRoots).toEqual([]);
  });

  test('collectObservedWorktreeRoots accepts only absolute tool paths under the scoped worktrees directory', () => {
    const projectRoot = '/tmp/repo';
    const observedWorktreeRoot = '/tmp/repo/.claude/worktrees/feature-a';

    expect(collectObservedWorktreeRoots([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: join(observedWorktreeRoot, 'src/index.ts') } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/repo-other/.claude/worktrees/feature-a/src/index.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: 'relative/path.ts' } },
          ],
        },
      },
    ], projectRoot)).toEqual([observedWorktreeRoot]);
  });

  test('collectObservedWorktreeRoots ignores malformed non-string file inputs', () => {
    expect(collectObservedWorktreeRoots([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 42 } },
            { type: 'tool_use', name: 'Write', input: { file_path: '' } },
            { type: 'tool_use', name: 'Grep', input: { path: ['src'] } },
          ],
        },
      },
    ], '/tmp/repo')).toEqual([]);
  });

  test('logical file matching equates main-tree queries with transcript cwd worktree accesses', () => {
    const projectRoot = '/tmp/repo';
    const worktreeRoot = '/tmp/repo/.claude/worktrees/feature-a';
    const context = buildSearchSessionContext({
      role: 'worktree',
      projectRoot,
      worktreeRoot: null,
      projectRef: {
        project: mangleProjectPath(worktreeRoot),
        claude_dir: '/tmp/claude',
        project_path_guess: null,
      },
    }, [{ type: 'user', cwd: worktreeRoot }]);

    const query = normalizeFileQuery('/tmp/repo/.claude-tracking/009/plan.md', context);
    const access = normalizeFileAccess('/tmp/repo/.claude/worktrees/feature-a/.claude-tracking/009/plan.md', 'write', context);

    expect(query.logicalPath).toBe('.claude-tracking/009/plan.md');
    expect(access.logicalPath).toBe('.claude-tracking/009/plan.md');
    expect(matchFileAccess(query, access)).toEqual({
      matched: true,
      matchedBy: 'logical',
      logicalPath: '.claude-tracking/009/plan.md',
    });
  });

  test('deriveWorktreeRootFromPath finds the worktree root from nested cwd or file access paths', () => {
    const projectRoot = '/tmp/hyphen-repo/main-app';
    const worktreeRoot = '/tmp/hyphen-repo/main-app/.claude/worktrees/feature-a';

    expect(deriveWorktreeRootFromPath(projectRoot, join(worktreeRoot, 'src'))).toBe(worktreeRoot);
    expect(deriveWorktreeRootFromPath(projectRoot, join(worktreeRoot, '.claude-tracking/009/plan.md'))).toBe(worktreeRoot);
    expect(deriveWorktreeRootFromPath(projectRoot, '/tmp/hyphen-repo/main-app2/.claude/worktrees/feature-a/src')).toBeNull();
  });

  test('logical file matching derives worktree root from nested transcript cwd', () => {
    const projectRoot = '/tmp/hyphen-repo/main-app';
    const worktreeRoot = '/tmp/hyphen-repo/main-app/.claude/worktrees/feature-a';
    const context = buildSearchSessionContext({
      role: 'worktree',
      projectRoot,
      worktreeRoot: null,
      projectRef: {
        project: mangleProjectPath(worktreeRoot),
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/hyphen/repo/main/app/.claude/worktrees/feature/a',
      },
    }, [{ type: 'user', cwd: join(worktreeRoot, 'src') }]);

    const query = normalizeFileQuery(join(projectRoot, '.claude-tracking/009/plan.md'), context);
    const access = normalizeFileAccess(join(worktreeRoot, '.claude-tracking/009/plan.md'), 'write', context);

    expect(access.logicalPath).toBe('.claude-tracking/009/plan.md');
    expect(matchFileAccess(query, access).matched).toBe(true);
  });

  test('logical file matching derives worktree root from file access when transcript cwd is absent', () => {
    const projectRoot = '/tmp/hyphen-repo/main-app';
    const worktreeRoot = '/tmp/hyphen-repo/main-app/.claude/worktrees/feature-a';
    const context = buildSearchSessionContext({
      role: 'worktree',
      projectRoot,
      worktreeRoot: null,
      projectRef: {
        project: mangleProjectPath(worktreeRoot),
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/hyphen/repo/main/app/.claude/worktrees/feature/a',
      },
    }, [{ type: 'user' }]);

    const query = normalizeFileQuery(join(projectRoot, '.claude-tracking/009/plan.md'), context);
    const access = normalizeFileAccess(join(worktreeRoot, '.claude-tracking/009/plan.md'), 'write', context);

    expect(access.logicalPath).toBe('.claude-tracking/009/plan.md');
    expect(matchFileAccess(query, access).matched).toBe(true);
  });

  test('logical file matching uses realpath candidates for supplied project roots', () => {
    const unique = uniqueTempName('cc-session-tool-realpath');
    const root = join(tmpdir(), unique);
    const realProject = join(root, 'real-project');
    const linkedProject = join(root, 'linked-project');
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realProject, linkedProject);

    try {
      const context = buildSearchSessionContext({
        role: 'main',
        projectRoot: linkedProject,
        worktreeRoot: null,
        projectRef: {
          project: mangleProjectPath(linkedProject),
          claude_dir: '/tmp/claude',
          project_path_guess: linkedProject,
        },
      }, []);

      const query = normalizeFileQuery(join(realProject, 'src', 'index.ts'), context);
      expect(query.logicalPath).toBe('src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical file matching equates symlinked main and worktree paths', () => {
    const unique = uniqueTempName('cc-session-tool-canonical');
    const root = join(tmpdir(), unique);
    const projectRoot = join(root, 'repo');
    const worktreeRoot = join(projectRoot, '.claude', 'worktrees', 'feature-a');
    const sharedTracking = join(root, 'shared-tracking');
    const sharedPlan = join(sharedTracking, '010', 'plan.md');

    mkdirSync(join(projectRoot, '.claude', 'worktrees'), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(join(sharedTracking, '010'), { recursive: true });
    writeFileSync(sharedPlan, 'plan');
    symlinkSync(sharedTracking, join(projectRoot, '.claude-tracking'));
    symlinkSync(sharedTracking, join(worktreeRoot, '.claude-tracking'));

    try {
      const context = buildSearchSessionContext({
        role: 'worktree',
        projectRoot,
        worktreeRoot,
        projectRef: {
          project: mangleProjectPath(worktreeRoot),
          claude_dir: '/tmp/claude',
          project_path_guess: null,
        },
      }, []);

      const query = normalizeFileQuery(join(projectRoot, '.claude-tracking/010/plan.md'), context);
      const access = normalizeFileAccess(join(worktreeRoot, '.claude-tracking/010/plan.md'), 'write', context);

      const sharedCandidates = pathContainmentCandidates(sharedPlan);
      expect(query.absoluteCandidates.some(candidate => sharedCandidates.includes(candidate))).toBe(true);
      expect(access.absoluteCandidates.some(candidate => sharedCandidates.includes(candidate))).toBe(true);
      expect(matchFileAccess(query, access)).toEqual({
        matched: true,
        matchedBy: 'canonical',
        logicalPath: '.claude-tracking/010/plan.md',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical file matching requires exact candidate equality, not shared suffixes', () => {
    const context = buildSearchSessionContext({
      role: 'global',
      projectRoot: null,
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-global',
        claude_dir: '/tmp/claude',
        project_path_guess: null,
      },
    }, []);

    const query = normalizeFileQuery('/tmp/repo-a/src/file.ts', context);
    const access = normalizeFileAccess('/tmp/repo-b/src/file.ts', 'write', context);

    expect(query.logicalPath).toBeNull();
    expect(access.logicalPath).toBeNull();
    expect(matchFileAccess(query, access)).toEqual({
      matched: false,
      matchedBy: 'substring',
      logicalPath: null,
    });
  });

  test('logical file matching falls back when canonical candidates cannot resolve', () => {
    const projectRoot = '/tmp/missing-main-repo';
    const worktreeRoot = '/tmp/missing-main-repo/.claude/worktrees/feature-a';
    const context = buildSearchSessionContext({
      role: 'worktree',
      projectRoot,
      worktreeRoot,
      projectRef: {
        project: mangleProjectPath(worktreeRoot),
        claude_dir: '/tmp/claude',
        project_path_guess: null,
      },
    }, []);

    const query = normalizeFileQuery(join(projectRoot, 'src/missing.ts'), context);
    const access = normalizeFileAccess(join(worktreeRoot, 'src/missing.ts'), 'edit', context);

    expect(query.absoluteCandidates).toContain(join(projectRoot, 'src/missing.ts'));
    expect(access.absoluteCandidates).toContain(join(worktreeRoot, 'src/missing.ts'));
    expect(matchFileAccess(query, access)).toEqual({
      matched: true,
      matchedBy: 'logical',
      logicalPath: 'src/missing.ts',
    });
  });

  test('logical file matching is separator-safe and blocks substring fallback for absolute logical queries', () => {
    const context = buildSearchSessionContext({
      role: 'main',
      projectRoot: '/tmp/repo',
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-repo',
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/repo',
      },
    }, []);

    const query = normalizeFileQuery('/tmp/repo/src/file.ts', context);
    const siblingAccess = normalizeFileAccess('/tmp/repo2/src/file.ts', 'write', context);
    const differentLogicalAccess = normalizeFileAccess('/tmp/repo/src/file.ts.bak', 'write', context);

    expect(query.logicalPath).toBe('src/file.ts');
    expect(siblingAccess.logicalPath).toBeNull();
    expect(matchFileAccess(query, siblingAccess).matched).toBe(false);
    expect(matchFileAccess(query, differentLogicalAccess)).toEqual({
      matched: false,
      matchedBy: 'logical',
      logicalPath: null,
    });
  });

  test('non-normalizable file queries retain substring matching', () => {
    const context = buildSearchSessionContext({
      role: 'main',
      projectRoot: '/tmp/repo',
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-repo',
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/repo',
      },
    }, []);

    const query = normalizeFileQuery('src/file.ts', context);
    const access = normalizeFileAccess('/tmp/repo/src/file.ts', 'read', context);

    expect(query.logicalPath).toBeNull();
    expect(matchFileAccess(query, access)).toEqual({
      matched: true,
      matchedBy: 'substring',
      logicalPath: 'src/file.ts',
    });
  });

  test('absolute candidate normalization is cached per session context', () => {
    const context = buildSearchSessionContext({
      role: 'main',
      projectRoot: '/tmp/repo',
      worktreeRoot: null,
      projectRef: {
        project: '-tmp-repo',
        claude_dir: '/tmp/claude',
        project_path_guess: '/tmp/repo',
      },
    }, []);
    const pathname = '/tmp/repo/src/file.ts';

    const first = absolutePathCandidatesFor(pathname, context);
    const second = absolutePathCandidatesFor(pathname, context);
    const query = normalizeFileQuery(pathname, context);
    const access = normalizeFileAccess(pathname, 'read', context);

    expect(second).toBe(first);
    expect(context.pathCandidateCache.size).toBe(1);
    expect(query.absoluteCandidates).toBe(first);
    expect(access.absoluteCandidates).toBe(first);
  });
});

// ============================================================================
// Write-all primitive
// ============================================================================

describe('writeAll', () => {
  type Step = 'ok' | 'EAGAIN' | 'EWOULDBLOCK' | 'EINTR' | 'zero' | 'EPIPE' | 'boom';

  /** Scripted io: each call consumes one step; 'ok' writes up to `chunk` bytes. Steps run out into 'ok'. */
  function scriptedIo(steps: Step[], chunk = Infinity) {
    const received: number[] = [];
    const log = { writes: 0, waits: 0 };
    const io: WriteAllIo = {
      write: (buffer, offset) => {
        log.writes++;
        const step = steps.shift() ?? 'ok';
        if (step === 'zero') return 0;
        if (step === 'boom') throw new Error('boom');
        if (step !== 'ok') throw Object.assign(new Error(step), { code: step });
        const n = Math.min(chunk, buffer.length - offset);
        for (let i = 0; i < n; i++) received.push(buffer[offset + i]!);
        return n;
      },
      wait: () => { log.waits++; },
    };
    return { io, log, bytes: () => Buffer.from(received) };
  }

  const text = 'héllo ☃ wörld \u{1F600} done';

  test('short writes concatenate to the exact UTF-8 bytes, splitting multi-byte characters', () => {
    for (const chunk of [1, 2, 3, 5]) {
      const s = scriptedIo([], chunk);
      writeAll(s.io, text);
      expect(s.bytes().equals(Buffer.from(text))).toBe(true);
      expect(s.bytes().toString('utf8')).toBe(text);
    }
  });

  test('EAGAIN and EWOULDBLOCK call wait once per occurrence and finish the output', () => {
    const s = scriptedIo(['EAGAIN', 'ok', 'EWOULDBLOCK', 'EAGAIN', 'ok'], 4);
    writeAll(s.io, text);
    expect(s.log.waits).toBe(3);
    expect(s.bytes().equals(Buffer.from(text))).toBe(true);
  });

  test('EINTR retries without wait', () => {
    const s = scriptedIo(['EINTR', 'EINTR', 'ok'], 4);
    writeAll(s.io, text);
    expect(s.log.waits).toBe(0);
    expect(s.bytes().equals(Buffer.from(text))).toBe(true);
  });

  test('a zero-byte return waits and retries', () => {
    const s = scriptedIo(['zero', 'zero', 'ok'], 4);
    writeAll(s.io, text);
    expect(s.log.waits).toBe(2);
    expect(s.bytes().equals(Buffer.from(text))).toBe(true);
  });

  test('EPIPE propagates unchanged and no write follows it', () => {
    const s = scriptedIo(['ok', 'EPIPE', 'ok', 'ok'], 4);
    let caught: unknown;
    try { writeAll(s.io, text); } catch (err) { caught = err; }
    expect(errnoCode(caught)).toBe('EPIPE');
    expect(s.log.writes).toBe(2);
    expect(s.log.waits).toBe(0);
  });

  test('a non-errno throw propagates unchanged', () => {
    const s = scriptedIo(['boom']);
    expect(() => writeAll(s.io, text)).toThrow('boom');
    expect(s.log.writes).toBe(1);
  });

  test('an empty string makes no write calls', () => {
    const s = scriptedIo([]);
    writeAll(s.io, '');
    expect(s.log.writes).toBe(0);
    expect(s.log.waits).toBe(0);
  });
});

describe('writeAllToFd', () => {
  test('writes multi-byte text to a real fd; the bytes read back match', () => {
    const dir = join(SHORT_TMP_ROOT, uniqueTempName('write-all-fd'));
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, 'out.txt');
      const text = ('héllo ☃ \u{1F600}\n').repeat(50_000);
      const fd = openSync(file, 'w');
      try {
        writeAllToFd(fd, text);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(file).equals(Buffer.from(text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('errnoCode', () => {
  test('returns the code of errno-style errors', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe('EPIPE');
    expect(errnoCode({ code: 'EAGAIN' })).toBe('EAGAIN');
  });

  test('returns undefined for a plain Error, a string, null and a non-string code', () => {
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode('EPIPE')).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
    expect(errnoCode({ code: 32 })).toBeUndefined();
  });
});

// ============================================================================
// Concurrent mapping helper
// ============================================================================

describe('mapConcurrent', () => {
  test('runs work with a global concurrency ceiling', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(1);
      active--;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

// ============================================================================
// resolveClaudeProjectDir (string logic only)
// ============================================================================

describe('resolveClaudeProjectDir', () => {
  test('throws NOT_FOUND for non-existent path', () => {
    expect(() => resolveClaudeProjectDir('/nonexistent/path/12345')).toThrow('not found');
  });

  test('resolves against an explicit Claude projects root', () => {
    const unique = uniqueTempName('cc-session-tool-resolve-root');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'project');
    const claudeDir = join(root, mangleProjectPath(projectPath));
    mkdirSync(claudeDir, { recursive: true });

    try {
      expect(resolveClaudeProjectDir(projectPath, root)).toBe(claudeDir);
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('resolves project paths with trailing slashes to the same Claude directory', () => {
    const unique = uniqueTempName('cc-session-tool-resolve-trailing');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'project');
    const claudeDir = join(root, mangleProjectPath(projectPath));
    mkdirSync(claudeDir, { recursive: true });

    try {
      expect(resolveClaudeProjectDir(`${projectPath}/`, root)).toBe(claudeDir);
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });
});

// ============================================================================
// CLI Integration
// ============================================================================

describe('CLI', () => {
  test('shows help with no arguments', async () => {
    const proc = Bun.spawn(['bun', 'run', 'index.ts', '--help'], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});

// ============================================================================
// Integration Tests with Fixture Data
// ============================================================================

const FIXTURE_DIR = join(SHORT_TMP_ROOT, uniqueTempName('cc-session-test'));
const FIXTURE_HOME = join(FIXTURE_DIR, 'home');
const FIXTURE_CLAUDE_PROJECTS_ROOT = claudeProjectsRoot(FIXTURE_HOME);
const FAKE_PROJECT = join(FIXTURE_DIR, 'fake-project');
const SECOND_FAKE_PROJECT = join(FIXTURE_DIR, 'fake-project-worktree');
const SUMMARY_PROJECT = join(FIXTURE_DIR, 'summary-project');
const RELATED_PROJECT = join(SHORT_TMP_ROOT, `ccsessionrelated${randomUUID().replace(/-/g, '')}`);
const RELATED_WORKTREE_ROOT = join(RELATED_PROJECT, '.claude', 'worktrees', 'feature');
const fakeDirName = mangleProjectPath(FAKE_PROJECT);
const secondFakeDirName = mangleProjectPath(SECOND_FAKE_PROJECT);
const summaryDirName = mangleProjectPath(SUMMARY_PROJECT);
const relatedDirName = mangleProjectPath(RELATED_PROJECT);
// Hand-built on purpose: only the '--claude-worktrees-' part is literal. The self-check test below pins
// mangleProjectPath(RELATED_WORKTREE_ROOT) to it.
const relatedWorktreeDirName = `${relatedDirName}--claude-worktrees-feature`;
const relatedSiblingWorktreeDirName = `${relatedDirName}--claude-worktrees-feature-b`;
const CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  fakeDirName,
);
const SECOND_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  secondFakeDirName,
);
const SUMMARY_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  summaryDirName,
);
const RELATED_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedDirName,
);
const RELATED_WORKTREE_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedWorktreeDirName,
);
const RELATED_SIBLING_WORKTREE_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedSiblingWorktreeDirName,
);

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID_2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const SESSION_ID_3 = 'cccccccc-1111-2222-3333-444444444444';
const SESSION_ID_4 = 'dddddddd-1111-2222-3333-444444444444';
const SESSION_ID_5 = 'eeeeeeee-1111-2222-3333-444444444444';
const SESSION_ID_6 = 'ffffffaa-1111-2222-3333-444444444444';
const SESSION_ID_7 = 'ffffffee-1111-2222-3333-444444444444';
const SESSION_ID_8 = 'ffffffbb-1111-2222-3333-444444444444';
const SESSION_ID_9 = 'ffffffcc-1111-2222-3333-444444444444';
const SESSION_ID_10 = 'ffffffdd-1111-2222-3333-444444444444';
const SESSION_ID_11 = 'ffffff11-1111-2222-3333-444444444444';
const SESSION_ID_12 = 'ffffff22-1111-2222-3333-444444444444';
const SESSION_ID_13 = 'ffffff33-1111-2222-3333-444444444444';
const BASH_MARKER_COMMAND = `npm install express ${'x'.repeat(30)} raw-bash-marker-in-elided-middle ${'y'.repeat(50)} tail-end-of-command`;
const CROSS_PROJECT_FILE = 'cross-project-fixture-target.ts';
const RELATED_PROJECT_FILE = 'related-origin-warning.ts';
const RELATED_MISSING_CWD_FILE = 'related-missing-cwd.ts';
const LATE_SLUG_FIRST_LINE = JSON.stringify({
  type: 'user',
  sessionId: SESSION_ID_5,
  timestamp: '2026-03-05T10:00:00.000Z',
  gitBranch: 'main',
  version: '2.1.0',
  message: { role: 'user', content: 'x'.repeat(8300) },
});

function makeFixtureLines(): string[] {
  const ts1 = '2026-03-01T10:00:00.000Z';
  const ts2 = '2026-03-01T10:01:00.000Z';
  const ts3 = '2026-03-01T10:02:00.000Z';
  const ts4 = '2026-03-01T10:03:00.000Z';
  const ts5 = '2026-03-01T10:04:00.000Z';
  const ts6 = '2026-03-01T10:05:00.000Z';

  return [
    // Turn 1: user message
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: ts1,
      gitBranch: 'main',
      version: '2.1.0',
      slug: 'test-slug-fixture',
      message: { role: 'user', content: 'Hello, please help me' },
    }),
    // Turn 2: assistant with thinking + tool_use
    JSON.stringify({
      type: 'assistant',
      timestamp: ts2,
      slug: 'parent-subagent-test',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'thinking', thinking: 'Let me think about this carefully and determine the best approach for the user.' },
          { type: 'tool_use', name: 'Grep', id: 'tool_1', input: { pattern: 'hello', path: 'src/' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
      },
    }),
    // Turn 3: user with tool_result
    JSON.stringify({
      type: 'user',
      timestamp: ts3,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', is_error: false, content: 'src/hello.ts\nsrc/hello.test.ts' },
        ],
      },
    }),
    // Turn 4: assistant with Edit tool_use
    JSON.stringify({
      type: 'assistant',
      timestamp: ts4,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', id: 'tool_2', input: { file_path: '/a/b/hello.ts', old_string: 'legacy raw old marker', new_string: 'new raw replacement marker' } },
        ],
        usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 150, cache_creation_input_tokens: 10 },
      },
    }),
    // Turn 5: user with failed tool_result
    JSON.stringify({
      type: 'user',
      timestamp: ts5,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_2', is_error: true, content: 'old_string not found in file' },
        ],
      },
    }),
    // Turn 6: assistant text response
    JSON.stringify({
      type: 'assistant',
      timestamp: ts6,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I see the edit failed. Let me try a different approach.' }],
        usage: { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 5 },
      },
    }),
  ];
}

const SUBAGENT_ID = 'a8361bc';

beforeAll(() => {
  mkdirSync(FAKE_PROJECT, { recursive: true });
  mkdirSync(SECOND_FAKE_PROJECT, { recursive: true });
  mkdirSync(SUMMARY_PROJECT, { recursive: true });
  mkdirSync(RELATED_PROJECT, { recursive: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  mkdirSync(SECOND_CLAUDE_DIR, { recursive: true });
  mkdirSync(SUMMARY_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_WORKTREE_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_SIBLING_WORKTREE_CLAUDE_DIR, { recursive: true });
  const lines = makeFixtureLines();
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
  const fullTimingSummaryLines = [
    JSON.stringify({
      type: 'system',
      sessionId: SESSION_ID_13,
      timestamp: '2026-03-01T09:59:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-01T10:00:00.000Z',
      message: { role: 'user', content: 'Summarize full timing' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T10:02:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Full timing response' }] },
    }),
    JSON.stringify({
      type: 'summary',
      timestamp: '2026-03-01T10:03:00.000Z',
    }),
  ];
  writeFileSync(join(SUMMARY_CLAUDE_DIR, `${SESSION_ID_13}.jsonl`), fullTimingSummaryLines.join('\n') + '\n');

  // Subagent fixture: create subagents dir within the parent session UUID dir
  const subagentDir = join(CLAUDE_DIR, SESSION_ID, 'subagents');
  mkdirSync(subagentDir, { recursive: true });
  const subagentLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-03-01T10:10:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: 'Subagent task' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T10:11:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Subagent response' }],
        usage: { input_tokens: 40, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(subagentDir, `agent-${SUBAGENT_ID}.jsonl`), subagentLines.join('\n') + '\n');
  writeFileSync(join(subagentDir, `agent-${SUBAGENT_ID}.meta.json`), JSON.stringify({
    agentType: 'test-agent',
    description: 'Test subagent',
  }));

  // Second subagent fixture WITHOUT .meta.json (for missing metadata tests)
  const subagent2Id = 'b9472cd';
  const subagent2Lines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-03-01T10:05:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: 'Second subagent task' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T10:06:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second subagent response' }],
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(join(subagentDir, `agent-${subagent2Id}.jsonl`), subagent2Lines.join('\n') + '\n');
  // Intentionally no .meta.json for subagent2

  // Third subagent fixture with metadata beyond the old 8192-byte extraction window.
  const subagent3Id = 'c0583de';
  const lateSubagentMetadataFirstLine = JSON.stringify({
    type: 'summary',
    summary: 'x'.repeat(8300),
  });
  const subagent3Lines = [
    lateSubagentMetadataFirstLine,
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-03-01T10:20:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: 'Late metadata subagent task' },
    }),
  ];
  expect(Buffer.byteLength(lateSubagentMetadataFirstLine)).toBeGreaterThan(8192);
  writeFileSync(join(subagentDir, `agent-${subagent3Id}.jsonl`), subagent3Lines.join('\n') + '\n');

  // Second fixture with same slug for ambiguous slug tests
  const lines2 = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_2,
      timestamp: '2026-03-02T10:00:00.000Z',
      gitBranch: 'feature',
      version: '2.1.0',
      slug: 'test-slug-fixture',
      message: { role: 'user', content: [{ type: 'text', text: 'User array content marker for text search.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-02T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'TodoWrite', id: 'tool_todo_1', input: { todos: [{ status: 'pending', content: 'stable json audit marker' }] } },
          { type: 'text', text: 'Response from second session' },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    }),
  ];
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID_2}.jsonl`), lines2.join('\n') + '\n');
  // Third fixture: multi-block assistant turn (thinking + text, no tool_use)
  const lines3 = [
    JSON.stringify({
      type: 'user', sessionId: SESSION_ID_3, timestamp: '2026-03-03T10:00:00.000Z',
      gitBranch: 'main', version: '2.1.0', slug: 'multi-block-test',
      message: { role: 'user', content: 'Test multi-block /plan intent' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-03-03T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `Considering the approach... ${'x'.repeat(260)}` },
          { type: 'text', text: 'Here is my answer.' },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    }),
  ];
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID_3}.jsonl`), lines3.join('\n') + '\n');
  // Fourth fixture: session with Bash tool_use for --bash testing
  const lines4 = [
    JSON.stringify({
      type: 'user', sessionId: SESSION_ID_4, timestamp: '2026-03-04T10:00:00.000Z',
      gitBranch: 'main', version: '2.1.0', slug: 'bash-test-session',
      message: { role: 'user', content: '/plan Install express' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-03-04T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tool_bash_1', input: { command: BASH_MARKER_COMMAND } },
          { type: 'tool_use', name: 'Read', id: 'tool_read_1', input: { file_path: '/workspace/hello.ts' } },
          { type: 'tool_use', name: 'Read', id: 'tool_cross_read_1', input: { file_path: `/workspace/${CROSS_PROJECT_FILE}` } },
          { type: 'tool_use', name: 'Write', id: 'tool_write_1', input: { file_path: '/workspace/other.ts', content: 'export const other = true; // raw write content marker' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
    JSON.stringify({
      type: 'user', timestamp: '2026-03-04T10:02:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_bash_1', is_error: false, content: 'added 57 packages' },
        ],
      },
    }),
  ];
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID_4}.jsonl`), lines4.join('\n') + '\n');
  const counterSubagentDir = join(CLAUDE_DIR, SESSION_ID_4, 'subagents');
  mkdirSync(counterSubagentDir, { recursive: true });
  const counterSubagentLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_4,
      timestamp: '2026-03-04T10:03:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: 'Count tracking usage' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-04T10:04:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tool_counter_bash_1', input: { command: 'rg .claude-tracking implementation.md' } },
        ],
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(join(counterSubagentDir, `agent-counter_agent.jsonl`), counterSubagentLines.join('\n') + '\n');

  const lateSlugLines = [
    LATE_SLUG_FIRST_LINE,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-05T10:01:00.000Z',
      slug: 'late-slug-test',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Late slug response' }],
        usage: { input_tokens: 40, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID_5}.jsonl`), lateSlugLines.join('\n') + '\n');

  const secondProjectLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_6,
      timestamp: '2026-03-06T10:00:00.000Z',
      gitBranch: 'worktree',
      version: '2.1.0',
      slug: 'cross-project-writer',
      message: { role: 'user', content: 'Create cross-project fixture file' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-06T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Write', id: 'tool_cross_write_1', input: { file_path: `/worktree/${CROSS_PROJECT_FILE}`, content: 'export const crossProject = true; // cross audit content marker' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(SECOND_CLAUDE_DIR, `${SESSION_ID_6}.jsonl`), secondProjectLines.join('\n') + '\n');

  const relatedProjectLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_7,
      timestamp: '2026-03-07T10:00:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      slug: 'related-project-reader',
      message: { role: 'user', content: 'Read a file whose writer may be in a worktree' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-07T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool_related_read_1', input: { file_path: join(RELATED_PROJECT, RELATED_PROJECT_FILE) } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_CLAUDE_DIR, `${SESSION_ID_7}.jsonl`), relatedProjectLines.join('\n') + '\n');

  const relatedWorktreeWriterLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_8,
      timestamp: '2026-03-08T10:00:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      cwd: join(RELATED_WORKTREE_ROOT, 'src'),
      slug: 'related-worktree-writer',
      message: { role: 'user', content: 'Write equivalent file from worktree' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-08T10:01:00.000Z',
      cwd: join(RELATED_WORKTREE_ROOT, 'src'),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Write', id: 'tool_related_worktree_write_1', input: { file_path: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE), content: 'export const related = true;' } },
          { type: 'tool_use', name: 'Bash', id: 'tool_related_worktree_bash_1', input: { command: 'bun test related' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_WORKTREE_CLAUDE_DIR, `${SESSION_ID_8}.jsonl`), relatedWorktreeWriterLines.join('\n') + '\n');

  const relatedWorktreeSubagentDir = join(RELATED_WORKTREE_CLAUDE_DIR, SESSION_ID_8, 'subagents');
  mkdirSync(relatedWorktreeSubagentDir, { recursive: true });
  const relatedWorktreeSubagentLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_8,
      timestamp: '2026-03-08T10:10:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      cwd: RELATED_WORKTREE_ROOT,
      message: { role: 'user', content: 'Inspect the worktree follow-up session' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-08T10:11:00.000Z',
      cwd: RELATED_WORKTREE_ROOT,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Worktree follow-up subagent response' }],
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(join(relatedWorktreeSubagentDir, `agent-${SUBAGENT_ID}.jsonl`), relatedWorktreeSubagentLines.join('\n') + '\n');
  writeFileSync(join(relatedWorktreeSubagentDir, `agent-${SUBAGENT_ID}.meta.json`), JSON.stringify({
    agentType: 'worktree-agent',
    description: 'Worktree subagent',
  }));

  const relatedWorktreeSameBasenameLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_9,
      timestamp: '2026-03-08T11:00:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      cwd: RELATED_WORKTREE_ROOT,
      slug: 'related-worktree-same-basename',
      message: { role: 'user', content: 'Read target but write another same-named file' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-08T11:01:00.000Z',
      cwd: RELATED_WORKTREE_ROOT,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool_related_worktree_read_1', input: { file_path: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE) } },
          { type: 'tool_use', name: 'Write', id: 'tool_related_worktree_write_2', input: { file_path: join(RELATED_WORKTREE_ROOT, 'nested', RELATED_PROJECT_FILE), content: 'export const nested = true;' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_WORKTREE_CLAUDE_DIR, `${SESSION_ID_9}.jsonl`), relatedWorktreeSameBasenameLines.join('\n') + '\n');

  const relatedWorktreeEarlierOriginLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_10,
      timestamp: '2026-03-09T10:00:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      cwd: RELATED_WORKTREE_ROOT,
      slug: 'related-worktree-earliest-origin',
      message: { role: 'user', content: 'Write equivalent file from a later session with older tool evidence' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-06T09:01:00.000Z',
      cwd: RELATED_WORKTREE_ROOT,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Write', id: 'tool_related_worktree_write_3', input: { file_path: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE), content: 'export const earlierOrigin = true;' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_WORKTREE_CLAUDE_DIR, `${SESSION_ID_10}.jsonl`), relatedWorktreeEarlierOriginLines.join('\n') + '\n');

  const relatedWorktreeMissingCwdLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_11,
      timestamp: '2026-03-10T10:00:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      slug: 'related-worktree-missing-cwd',
      message: { role: 'user', content: 'Write equivalent file from worktree without cwd metadata' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-10T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Write', id: 'tool_related_worktree_write_4', input: { file_path: join(RELATED_WORKTREE_ROOT, RELATED_MISSING_CWD_FILE), content: 'export const missingCwd = true;' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_WORKTREE_CLAUDE_DIR, `${SESSION_ID_11}.jsonl`), relatedWorktreeMissingCwdLines.join('\n') + '\n');

  const relatedWorktreeMalformedFileLines = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_12,
      timestamp: '2026-03-11T10:00:00.000Z',
      gitBranch: 'feature-worktree',
      version: '2.1.0',
      cwd: RELATED_WORKTREE_ROOT,
      slug: 'related-worktree-malformed-file-input',
      message: { role: 'user', content: 'Run a tool after malformed file input' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-11T10:01:00.000Z',
      cwd: RELATED_WORKTREE_ROOT,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool_malformed_read_1', input: { file_path: 42 } },
          { type: 'tool_use', name: 'Bash', id: 'tool_malformed_bash_1', input: { command: 'bun test malformed-file-input-survives' } },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
    }),
  ];
  writeFileSync(join(RELATED_WORKTREE_CLAUDE_DIR, `${SESSION_ID_12}.jsonl`), relatedWorktreeMalformedFileLines.join('\n') + '\n');
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(RELATED_PROJECT, { recursive: true, force: true });
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
  rmSync(SECOND_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(SUMMARY_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(RELATED_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(RELATED_WORKTREE_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(RELATED_SIBLING_WORKTREE_CLAUDE_DIR, { recursive: true, force: true });
});

function runCli(args: string[], extraEnv: Record<string, string> = {}, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const entry = cwd === undefined ? 'index.ts' : join(import.meta.dir, 'index.ts');
    const proc = Bun.spawn(['bun', 'run', entry, ...args], {
      cwd: cwd ?? import.meta.dir,
      env: { ...process.env, HOME: FIXTURE_HOME, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    resolve({ exitCode, stdout, stderr });
  });
}

function runCliHelp(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const proc = Bun.spawn(['bun', 'run', 'index.ts', ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: FIXTURE_HOME, NODE_ENV: 'development' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    resolve({ exitCode, stdout, stderr });
  });
}

function parseOutput(stdout: string) {
  try { return JSON.parse(stdout); }
  catch (e) { throw new Error(`Failed to parse CLI output: ${stdout.slice(0, 500)}\n${e}`); }
}

describe('scanSearchTarget', () => {
  test('no-context file filters require a matching raw file access', async () => {
    const unique = uniqueTempName('cc-session-tool-no-context-search');
    const root = join(tmpdir(), unique);
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const sessionFile = join(root, `${sessionId}.jsonl`);
    mkdirSync(root, { recursive: true });

    try {
      writeFileSync(sessionFile, [
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-01T10:00:00.000Z',
          message: { role: 'user', content: 'Run test command' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-03-01T10:01:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Bash', id: 'tool_bash_1', input: { command: 'bun test no-context-gate' } },
              { type: 'tool_use', name: 'Read', id: 'tool_read_1', input: { file_path: '/tmp/actual.ts' } },
            ],
          },
        }),
      ].join('\n') + '\n');

      const target = { filePath: sessionFile, sessionId };
      const missed = await scanSearchTarget(target, {
        file: '/tmp/missing.ts',
        tool: 'Bash',
      }, null);
      expect(missed.match).toBeNull();

      const matched = await scanSearchTarget(target, {
        file: '/tmp/actual.ts',
        tool: 'Bash',
      }, null);
      expect(matched.match?.session_id).toBe(sessionId);
      expect(matched.match?.matches.files).toEqual(['/tmp/actual.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scanSearchTarget result selectors', () => {
  const sessionId = '22222222-3333-4444-5555-666666666666';
  const writeSession = (root: string): string => {
    const sessionFile = join(root, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, [
      JSON.stringify({ type: 'user', sessionId, timestamp: '2026-03-01T10:00:00.000Z', message: { role: 'user', content: 'run things' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-03-01T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', id: 'ok_call', input: { command: 'echo hello' } },
            { type: 'tool_use', name: 'Bash', id: 'bad_call', input: { command: 'false' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-03-01T10:01:05.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'ok_call', content: 'Hello World Marker' },
            { type: 'tool_result', tool_use_id: 'bad_call', is_error: true, content: [null, {}, { type: 'text', text: 'exit code 1 boom' }] },
          ],
        },
      }),
    ].join('\n') + '\n');
    return sessionFile;
  };

  const withFixture = async (fn: (target: { filePath: string; sessionId: string }) => Promise<void>) => {
    const root = join(tmpdir(), uniqueTempName('cc-session-tool-output-scan'));
    mkdirSync(root, { recursive: true });
    try {
      await fn({ filePath: writeSession(root), sessionId });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('outputMatch is case-insensitive and emits tool_output evidence for the call', async () => {
    await withFixture(async target => {
      const { match } = await scanSearchTarget(target, { outputMatch: 'hello world marker' }, null);
      expect(match?.session_id).toBe(sessionId);
      const outputs = match!.matches.evidence.filter(e => e.kind === 'tool_output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({ tool_use_id: 'ok_call', turn: 2, block_index: 0, result_turn: 3, is_error: false });
      expect(match!.matches.evidence.some(e => e.kind === 'tool_input')).toBe(false);
    });
  });

  test('outputRegex is case-sensitive', async () => {
    await withFixture(async target => {
      expect((await scanSearchTarget(target, { outputRegex: 'Hello World' }, null)).match).not.toBeNull();
      expect((await scanSearchTarget(target, { outputRegex: 'hello world' }, null)).match).toBeNull();
    });
  });

  test('failed selects only failing calls and tolerates malformed result sub-blocks', async () => {
    await withFixture(async target => {
      const { match } = await scanSearchTarget(target, { failed: true }, null);
      const outputs = match!.matches.evidence.filter(e => e.kind === 'tool_output');
      expect(outputs.map(e => e.tool_use_id)).toEqual(['bad_call']);
      expect(outputs[0]).toMatchObject({ is_error: true, snippet: 'exit code 1 boom' });
    });
  });

  test('result selectors bind to the same call as --bash', async () => {
    await withFixture(async target => {
      expect((await scanSearchTarget(target, { bash: 'echo hello', failed: true }, null)).match).toBeNull();
      expect((await scanSearchTarget(target, { bash: 'false', failed: true }, null)).match).not.toBeNull();
    });
  });

  test('null content blocks do not drop the session under --failed, --text, or both', async () => {
    const root = join(tmpdir(), uniqueTempName('cc-session-tool-null-block-scan'));
    mkdirSync(root, { recursive: true });
    try {
      const nullSessionId = '33333333-4444-4555-8666-777777777777';
      const filePath = join(root, `${nullSessionId}.jsonl`);
      writeFileSync(filePath, [
        JSON.stringify({ type: 'user', sessionId: nullSessionId, timestamp: '2026-03-01T10:00:00.000Z', message: { role: 'user', content: [null, { type: 'text', text: 'please run things' }] } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-03-01T10:01:00.000Z',
          message: { role: 'assistant', content: [null, { type: 'text', text: 'running now' }, { type: 'tool_use', name: 'Bash', id: 'n_call', input: { command: 'false' } }] },
        }),
        JSON.stringify({ type: 'user', timestamp: '2026-03-01T10:01:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'n_call', is_error: true, content: 'boom' }] } }),
      ].join('\n') + '\n');
      const target = { filePath, sessionId: nullSessionId };
      for (const args of [{ failed: true }, { failed: true, text: 'running' }, { text: 'running' }]) {
        expect((await scanSearchTarget(target, args, null)).match?.session_id).toBe(nullSessionId);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('empty outputMatch does not enable bound mode', async () => {
    await withFixture(async target => {
      const { match } = await scanSearchTarget(target, { tool: 'Bash', outputMatch: '' }, null);
      expect(match).not.toBeNull();
      expect(match!.matches.evidence.some(e => e.kind === 'tool_output')).toBe(false);
      expect(match!.matches.evidence.filter(e => e.kind === 'tool_input')).toHaveLength(2);
    });
  });
});

describe('worktree project path resolution integration', () => {
  test('fixture worktree root encodes to the hand-built Claude project name', () => {
    expect(mangleProjectPath(RELATED_WORKTREE_ROOT)).toBe(relatedWorktreeDirName);
  });

  test('list --project <worktree> scopes to that worktree dir only', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', RELATED_WORKTREE_ROOT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(0);
    const ids = result.data.map((s: any) => s.session_id);
    expect(ids).toContain(SESSION_ID_8);
    expect(ids).not.toContain(SESSION_ID_7);
  });

  test('search --project <worktree> resolves the worktree dir and excludes the parent and sibling', async () => {
    const { exitCode, stdout } = await runCli(['search', '--bash-regex', 'bun test related', '--project', RELATED_WORKTREE_ROOT, '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID_8);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta.included_projects).toEqual([
      {
        project: relatedWorktreeDirName,
        project_path_guess: RELATED_WORKTREE_ROOT,
        project_role: 'main',
      },
    ]);
    expect(result._meta.skipped_projects).toEqual([]);
  });

  test('projects --project <worktree> returns exactly that worktree dir', async () => {
    const { exitCode, stdout } = await runCli(['projects', '--project', RELATED_WORKTREE_ROOT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      project: relatedWorktreeDirName,
      project_role: 'main',
      session_count: 5,
    });
  });

  test('summary <session> --project <worktree> resolves through the session selector path', async () => {
    const { exitCode, stdout } = await runCli(['summary', SESSION_ID_8, '--project', RELATED_WORKTREE_ROOT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
  });

  test('stats tokens --project <worktree> scopes to that worktree dir with a per-test db', async () => {
    const dbDir = join(FIXTURE_DIR, 'dbs-worktree');
    mkdirSync(dbDir, { recursive: true });
    const { exitCode, stdout } = await runCli(['stats', 'tokens', '--by', 'session', '--project', RELATED_WORKTREE_ROOT, '--db', join(dbDir, 'worktree.db'), '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.included_projects).toEqual([
      {
        project: relatedWorktreeDirName,
        project_path_guess: RELATED_WORKTREE_ROOT,
        project_role: 'main',
      },
    ]);
    expect(result._meta.skipped_projects).toEqual([]);
    const ids = result.data.map((r: any) => r.session_id);
    expect(ids).toContain(SESSION_ID_8);
    expect(ids).not.toContain(SESSION_ID_7);
  });
});

describe('worktree CWD default integration', () => {
  const unique = uniqueTempName('cc-session-tool-cwd-worktree');
  const realTmp = realpathSync(SHORT_TMP_ROOT);
  const base = join(realTmp, unique);
  const repoRoot = join(base, 'repo');
  const worktreeDir = join(repoRoot, '.claude', 'worktrees', 'feature-a');
  const home = join(base, 'home');
  // Only the '--claude-worktrees-' part is hand-built; the repo part comes from the encoder because it
  // depends on the machine's tmpdir, and the unit literals pin the encoder.
  const worktreeProject = `${mangleProjectPath(repoRoot)}--claude-worktrees-feature-a`;
  const sessionId = '12345678-aaaa-bbbb-cccc-1234567890ab';
  const dbPath = join(base, 'dbs', 'cwd.db');

  beforeAll(() => {
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(join(base, 'dbs'), { recursive: true });
    const projectDir = join(claudeProjectsRoot(home), worktreeProject);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: worktreeDir,
        timestamp: '2026-03-08T10:00:00.000Z',
        message: { role: 'user', content: 'Run the cwd default check' },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: worktreeDir,
        timestamp: '2026-03-08T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', id: 'tool_cwd_bash_1', input: { command: 'bun test cwd-default-marker' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('fixture worktree dir encodes to the hand-built Claude project name', () => {
    expect(mangleProjectPath(worktreeDir)).toBe(worktreeProject);
  });

  test('list from a worktree CWD finds the worktree session without flags', async () => {
    const { exitCode, stdout } = await runCli(['list'], { HOME: home }, worktreeDir);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(exitCode).toBe(0);
    expect(result.data.map((s: any) => s.session_id)).toContain(sessionId);
  });

  test('search from a worktree CWD finds the worktree session without flags', async () => {
    const { exitCode, stdout } = await runCli(['search', '--bash-regex', 'cwd-default-marker'], { HOME: home }, worktreeDir);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(exitCode).toBe(0);
    expect(result.data.map((s: any) => s.session_id)).toContain(sessionId);
  });

  test('summary from a worktree CWD resolves the session without flags', async () => {
    const { exitCode, stdout } = await runCli(['summary', sessionId], { HOME: home }, worktreeDir);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(exitCode).toBe(0);
    expect(result.data.session_id).toBe(sessionId);
  });

  test('stats tokens from a worktree CWD resolves the CWD scope with a per-test db', async () => {
    const { exitCode, stdout } = await runCli(['stats', 'tokens', '--by', 'session', '--db', dbPath, '--include-project-lists'], { HOME: home }, worktreeDir);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(exitCode).toBe(0);
    expect(result._meta.included_projects.map((p: any) => p.project)).toEqual([worktreeProject]);
    expect(result._meta.skipped_projects).toEqual([]);
    const row = result.data.find((r: any) => r.session_id === sessionId && r.agent_id === null);
    expect(row).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});

describe('list integration', () => {
  test('lists sessions in fixture dir', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(5);
    const session1 = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(session1).toBeDefined();
    expect(session1.branch).toBe('main');
    expect(session1.model).toBe('claude-sonnet-4-5');
    expect(session1.slug).toBe('test-slug-fixture');
  });

  test('filters by branch', async () => {
    const { stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--branch', 'nonexistent']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('filters by min-lines', async () => {
    const { stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--min-lines', '999']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('filters by after date', async () => {
    const { stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--after', '2026-04-01']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('--last 1 returns only the newest session', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--last', '1']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].session_id).toBe(SESSION_ID_5); // newest (2026-03-05)
    expect(result._meta.total).toBe(5);
    expect(result._meta.returned).toBe(1);
    expect(result._meta.hasMore).toBe(true);
  });

  test('--last 2 returns two newest sessions', async () => {
    const { stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--last', '2']);
    const result = parseOutput(stdout);
    expect(result.data.length).toBe(2);
  });

  test('--last larger than total returns all', async () => {
    const { stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--last', '100']);
    const result = parseOutput(stdout);
    expect(result.data.length).toBe(5);
    expect(result._meta.hasMore).toBe(false);
  });

  test('--last 0 returns error', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--last', '0']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  test('--since with large duration returns all sessions', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--since', '999d']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(5);
  });

  test('--since and --after together returns error', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--since', '1d', '--after', '2026-03-01']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('mutually exclusive');
  });

  test('scoped list includes associated worktree projects by default and exposes session_ref handles', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', RELATED_PROJECT, '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(3);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta.skipped_projects).toEqual([]);
    expect(result._meta.included_projects).toEqual([
      {
        project: relatedDirName,
        project_path_guess: RELATED_PROJECT,
        project_role: 'main',
      },
      {
        project: relatedWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedWorktreeDirName),
        project_role: 'worktree',
      },
      {
        project: relatedSiblingWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedSiblingWorktreeDirName),
        project_role: 'worktree',
      },
    ]);
    const worktreeSession = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(worktreeSession).toMatchObject({
      project: relatedWorktreeDirName,
      project_role: 'worktree',
      session_ref: { session_id: SESSION_ID_8, project: relatedWorktreeDirName },
    });
  });

  test('list --main-only skips associated worktree projects', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', RELATED_PROJECT, '--main-only']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_7]);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(0);
  });

  test('list intent filters inspect slug and first user message', async () => {
    const slugMatch = parseOutput((await runCli(['list', '--project', FAKE_PROJECT, '--intent-match', 'bash-test-session'])).stdout);
    expect(slugMatch.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_4]);

    const regexMatch = parseOutput((await runCli(['list', '--project', FAKE_PROJECT, '--intent-regex', '/plan\\s+Install'])).stdout);
    expect(regexMatch.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_4]);
  });

  test('list rejects documentation-sensitive flag conflicts', async () => {
    const mainOnlyAllProjects = parseOutput((await runCli(['list', '--all-projects', '--main-only'])).stdout);
    expect(mainOnlyAllProjects.ok).toBe(false);
    expect(mainOnlyAllProjects.error.code).toBe('INVALID_ARGS');
    expect(mainOnlyAllProjects.error.message).toContain('--main-only cannot be used with --all-projects');

    const intentConflict = parseOutput((await runCli(['list', '--project', FAKE_PROJECT, '--intent-match', 'x', '--intent-regex', 'x'])).stdout);
    expect(intentConflict.ok).toBe(false);
    expect(intentConflict.error.code).toBe('INVALID_ARGS');
    expect(intentConflict.error.message).toContain('--intent-match and --intent-regex are mutually exclusive');
  });

  test('--all-projects lists sessions with project metadata', async () => {
    const { exitCode, stdout } = await runCli(['list', '--all-projects', '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(4);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta.included_projects).toContainEqual({
      project: secondFakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(secondFakeDirName),
      project_role: 'global',
    });
    const secondary = result.data.find((s: any) => s.session_id === SESSION_ID_6);
    expect(secondary).toBeDefined();
    expect(secondary.project).toBe(secondFakeDirName);
    expect(secondary.project_path_guess).toBe(projectPathGuessFromClaudeProject(secondFakeDirName));
    expect(secondary.project_role).toBe('global');
  });

  test('list --all-projects --project-glob filters selected and skipped projects', async () => {
    const { exitCode, stdout } = await runCli(['list', '--all-projects', '--project-glob', '*fake-project-worktree', '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(result._meta.skipped_projects.length);
    expect(result._meta.included_projects).toEqual([{
      project: secondFakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(secondFakeDirName),
      project_role: 'global',
    }]);
    expect(result._meta.skipped_projects).toContainEqual({
      project: fakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(fakeDirName),
      project_role: 'global',
    });
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_6]);
  });

  test('list --all-projects --project-glob reports counts only by default', async () => {
    const { exitCode, stdout } = await runCli(['list', '--all-projects', '--project-glob', '*fake-project-worktree']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBeGreaterThanOrEqual(1);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_6]);

    // In all-projects mode, scanned + skipped accounts for every project directory.
    const unfiltered = await runCli(['list', '--all-projects']);
    expect(unfiltered.exitCode).toBe(0);
    const unfilteredMeta = parseOutput(unfiltered.stdout)._meta;
    expect(unfilteredMeta.projects_skipped).toBe(0);
    expect(result._meta.projects_scanned + result._meta.projects_skipped).toBe(unfilteredMeta.projects_scanned);
  });

  test('list --project-glob without --all-projects returns invalid args', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project-glob', '*fake*', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--project-glob requires --all-projects');
  });
});

describe('projects integration', () => {
  test('projects --glob returns deterministic raw project summaries', async () => {
    const { exitCode, stdout } = await runCli(['projects', '--glob', '*fake-project*']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(2);
    expect(result._meta.projects_skipped).toBeGreaterThanOrEqual(1);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
    expect(result.data.map((p: any) => p.project)).toEqual([fakeDirName, secondFakeDirName]);
    expect(result.data[0]).toMatchObject({
      project: fakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(fakeDirName),
      project_role: 'global',
      session_count: 5,
    });
    expect(result.data[1]).toMatchObject({
      project: secondFakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(secondFakeDirName),
      project_role: 'global',
      session_count: 1,
    });
  });

  test('projects --project summarizes main and associated worktree handles', async () => {
    const { exitCode, stdout } = await runCli(['projects', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((p: any) => p.project)).toEqual([
      relatedDirName,
      relatedWorktreeDirName,
      relatedSiblingWorktreeDirName,
    ]);
    expect(result.data.find((p: any) => p.project === relatedDirName)).toMatchObject({
      project_path_guess: RELATED_PROJECT,
      project_role: 'main',
      session_count: 1,
      first_session_at: '2026-03-07T10:00:00.000Z',
      last_session_at: '2026-03-07T10:00:00.000Z',
    });
    expect(result.data.find((p: any) => p.project === relatedWorktreeDirName)).toMatchObject({
      project_role: 'worktree',
      session_count: 5,
    });
  });

  test('unfiltered projects reports counts only by default', async () => {
    const { exitCode, stdout } = await runCli(['projects']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(4);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
  });

  test('projects --project --glob reports what the glob excluded', async () => {
    const args = ['projects', '--project', RELATED_PROJECT, '--glob', relatedWorktreeDirName];
    const run = await runCli(args);
    expect(run.exitCode).toBe(0);
    const result = parseOutput(run.stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((p: any) => p.project)).toEqual([relatedWorktreeDirName]);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(2);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');

    const runWithLists = await runCli([...args, '--include-project-lists']);
    expect(runWithLists.exitCode).toBe(0);
    const withLists = parseOutput(runWithLists.stdout);
    expect(withLists.ok).toBe(true);
    expect(withLists._meta.projects_scanned).toBe(1);
    expect(withLists._meta.projects_skipped).toBe(2);
    expect(withLists._meta.included_projects.map((p: any) => p.project)).toEqual([relatedWorktreeDirName]);
    expect(withLists._meta.skipped_projects).toEqual([
      { project: relatedDirName, project_path_guess: RELATED_PROJECT, project_role: 'main' },
      {
        project: relatedSiblingWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedSiblingWorktreeDirName),
        project_role: 'worktree',
      },
    ]);
  });

  test('projects --project --glob matching nothing is ok with zero projects scanned', async () => {
    const { exitCode, stdout } = await runCli(['projects', '--project', RELATED_PROJECT, '--glob', 'no-such-project-dir-zz']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result._meta.projects_scanned).toBe(0);
    expect(result._meta.projects_skipped).toBe(3);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
  });
});

describe('--include-project-lists across project-selecting leaves (integration)', () => {
  // Scoped rows run against RELATED_PROJECT (main + 2 worktrees). All-projects rows must scan every fixture
  // directory, counted by an unfiltered `list --all-projects` because later describes add directories to the root.
  const PROJECT_LIST_LEAVES: { name: string; args: string[]; usesDb?: boolean; allProjects?: boolean }[] = [
    { name: 'list', args: ['list', '--project', RELATED_PROJECT] },
    { name: 'projects', args: ['projects', '--project', RELATED_PROJECT] },
    { name: 'search', args: ['search', '--tool', 'Bash', '--project', RELATED_PROJECT] },
    { name: 'index status', args: ['index', 'status', '--project', RELATED_PROJECT], usesDb: true },
    { name: 'index rebuild', args: ['index', 'rebuild', '--project', RELATED_PROJECT], usesDb: true },
    { name: 'stats tokens', args: ['stats', 'tokens', '--project', RELATED_PROJECT], usesDb: true },
    { name: 'stats trajectories', args: ['stats', 'trajectories', '--project', RELATED_PROJECT], usesDb: true },
    { name: 'index status --all-projects', args: ['index', 'status', '--all-projects'], usesDb: true, allProjects: true },
    { name: 'index rebuild (all projects by default)', args: ['index', 'rebuild'], usesDb: true, allProjects: true },
    { name: 'stats tokens --all-projects', args: ['stats', 'tokens', '--all-projects'], usesDb: true, allProjects: true },
    { name: 'stats trajectories --all-projects', args: ['stats', 'trajectories', '--all-projects'], usesDb: true, allProjects: true },
  ];

  for (const leaf of PROJECT_LIST_LEAVES) {
    test(`'${leaf.name}' defaults to counts and adds arrays with --include-project-lists`, async () => {
      const tempDir = join(tmpdir(), uniqueTempName('cc-session-project-lists'));
      mkdirSync(tempDir, { recursive: true });
      try {
        const dbArgs = leaf.usesDb ? ['--db', join(tempDir, 'index.db')] : [];
        let expectedScanned = 3;
        if (leaf.allProjects) {
          const all = await runCli(['list', '--all-projects']);
          expect(all.exitCode).toBe(0);
          expectedScanned = parseOutput(all.stdout)._meta.projects_scanned;
          expect(expectedScanned).toBeGreaterThan(3);
        }

        const def = await runCli([...leaf.args, ...dbArgs]);
        expect(def.exitCode).toBe(0);
        const defResult = parseOutput(def.stdout);
        expect(defResult.ok).toBe(true);
        expect(defResult._meta.projects_scanned).toBe(expectedScanned);
        expect(defResult._meta.projects_skipped).toBe(0);
        expect(defResult._meta).not.toHaveProperty('included_projects');
        expect(defResult._meta).not.toHaveProperty('skipped_projects');
        expect(Object.keys(defResult._meta).slice(-2)).toEqual(['projects_scanned', 'projects_skipped']);

        const opt = await runCli([...leaf.args, '--include-project-lists', ...dbArgs]);
        expect(opt.exitCode).toBe(0);
        const optResult = parseOutput(opt.stdout);
        expect(optResult.ok).toBe(true);
        expect(optResult._meta.included_projects).toHaveLength(optResult._meta.projects_scanned);
        expect(optResult._meta.skipped_projects).toHaveLength(optResult._meta.projects_skipped);
        expect(optResult._meta.projects_scanned).toBe(expectedScanned);
        expect(optResult._meta.skipped_projects).toEqual([]);
        expect(Object.keys(optResult._meta).slice(-4)).toEqual(['projects_scanned', 'projects_skipped', 'included_projects', 'skipped_projects']);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

describe('help contract integration', () => {
  test('top-level help exposes projects and stable handle contract', async () => {
    const { exitCode, stdout, stderr } = await runCliHelp(['--help']);
    const help = stdout + stderr;
    expect(exitCode).toBe(0);
    expect(help).toContain('stable raw project/session_ref handles');
    expect(help).toContain('projects');
  });

  test('command help includes agent-facing contract phrases', async () => {
    const listProcess = await runCliHelp(['list', '--help']);
    const listHelp = listProcess.stdout + listProcess.stderr;
    expect(listHelp).toContain('associated Claude worktrees by default');
    expect(listHelp).toContain('--main-only');
    expect(listHelp).toContain('raw Claude project basename');

    const searchProcess = await runCliHelp(['search', '--help']);
    const searchHelp = searchProcess.stdout + searchProcess.stderr;
    expect(searchHelp).toContain('unified evidence');
    expect(searchHelp).toContain('worktrees and subagents by default');
    expect(searchHelp).toContain('same matching file access');
    expect(searchHelp).toContain('--output-match');
    expect(searchHelp).toContain('--failed');
    expect(searchHelp).toContain('does NOT search tool output');

    const toolsProcess = await runCliHelp(['tools', '--help']);
    const toolsHelp = toolsProcess.stdout + toolsProcess.stderr;
    expect(toolsHelp).toContain('raw structured inputs');
    expect(toolsHelp).toContain('input_summary');
    expect(toolsHelp).toContain('--max-outcome');
    expect(toolsHelp).toContain('outcome_hash');

    const projectsProcess = await runCliHelp(['projects', '--help']);
    const projectsHelp = projectsProcess.stdout + projectsProcess.stderr;
    expect(projectsHelp).toContain('raw project handles');
    expect(projectsHelp).toContain('project_path_guess');

    const summaryProcess = await runCliHelp(['summary', '--help']);
    const summaryHelp = summaryProcess.stdout + summaryProcess.stderr;
    expect(summaryHelp).toContain('session_ref.project');
    expect(summaryHelp).toContain('--claude-project');
  });
});

describe('shape integration', () => {
  test('returns shape for fixture session', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const data = result.data;
    expect(data.session_id).toBe(SESSION_ID);
    expect(data.agent_id).toBeNull();
    expect(data.summary.total_turns).toBe(6);
    expect(data.summary.user_messages).toBe(3);
    expect(data.summary.tool_calls.Grep).toBe(1);
    expect(data.summary.tool_calls.Edit).toBe(1);
    expect(data.summary.first_edit_turn).toBe(4);
    expect(data.summary.duration_minutes).toBe(5);
  });

  test('resolves session by prefix', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'aaaaaaaa', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.data.session_id).toBe(SESSION_ID);
  });

  test('resolves session by ordinary unique slug', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'multi-block-test', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_3);
    expect(result.data.agent_id).toBeNull();
  });

  test('resolves session by late slug', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'late-slug-test', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_5);
    expect(result.data.agent_id).toBeNull();
  });

  test('ambiguous slug returns error', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'test-slug-fixture', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ID');
    expect(result.error.message).toContain('Ambiguous slug');
  });
});

describe('summary integration', () => {
  test('returns one-call triage fields for a parent session without rolling up subagent activity', async () => {
    const { exitCode, stdout } = await runCli(['summary', SESSION_ID, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta).toEqual({ total: 1, returned: 1, hasMore: false });
    expect(result.data).toMatchObject({
      session_id: SESSION_ID,
      agent_id: null,
      branch: 'main',
      model: 'claude-sonnet-4-5',
      started_at: '2026-03-01T10:00:00.000Z',
      ended_at: '2026-03-01T10:05:00.000Z',
      duration_ms: 300000,
      turn_count: 6,
      lines: 6,
      slug: 'test-slug-fixture',
      first_user_prompt: { turn: 1, snippet: 'Hello, please help me' },
      last_assistant_text: { turn: 6, snippet: 'I see the edit failed. Let me try a different approach.' },
      tool_counts: { Grep: 1, Edit: 1 },
      files_touched: { read: 0, edit: 1, write: 0, grep: 1, glob: 0 },
    });
    expect(result.data.subagents.map((s: any) => s.agent_id)).toContain(SUBAGENT_ID);
    expect(result.data.tool_counts).not.toHaveProperty('Task');
  });

  test('returns subagent-target summary with agent_id and no nested subagents', async () => {
    const { exitCode, stdout } = await runCli(['summary', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.turn_count).toBe(2);
    expect(result.data.first_user_prompt).toEqual({ turn: 1, snippet: 'Subagent task' });
    expect(result.data.last_assistant_text).toEqual({ turn: 2, snippet: 'Subagent response' });
    expect(result.data.subagents).toEqual([]);
  });

  test('uses full transcript entries for timing while counting user and assistant turns', async () => {
    const { exitCode, stdout } = await runCli(['summary', SESSION_ID_13, '--project', SUMMARY_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      session_id: SESSION_ID_13,
      started_at: '2026-03-01T09:59:00.000Z',
      ended_at: '2026-03-01T10:03:00.000Z',
      duration_ms: 240000,
      turn_count: 2,
      lines: 4,
      first_user_prompt: { turn: 1, snippet: 'Summarize full timing' },
      last_assistant_text: { turn: 2, snippet: 'Full timing response' },
    });
  });
});

describe('tools integration', () => {
  test('returns all tool calls', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.agent_id).toBeNull();
    expect(result.data.tool_calls.length).toBe(2);
    expect(result.data.tool_calls[0].tool).toBe('Grep');
    expect(result.data.tool_calls[0].input_summary).toContain("pattern='hello'");
    expect(result.data.tool_calls[0].outcome).toBe('success (2 lines)');
  });

  test('filters by name', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--name', 'Edit']);
    const result = parseOutput(stdout);
    expect(result.data.tool_calls.length).toBe(1);
    expect(result.data.tool_calls[0].tool).toBe('Edit');
  });

  test('filters by --name-match', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID_4, '--project', FAKE_PROJECT, '--name-match', 'rea']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.tool_calls.map((call: any) => call.tool)).toEqual(['Read', 'Read']);
  });

  test('filters by raw --input-match beyond input_summary', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID_4, '--project', FAKE_PROJECT, '--name', 'Bash', '--input-match', 'raw-bash-marker-in-elided-middle']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.tool_calls).toHaveLength(1);
    // Read before toMatchObject: Bun's asymmetric matchers can overwrite the received property.
    const summary: string = result.data.tool_calls[0].input_summary;
    expect(result.data.tool_calls[0]).toMatchObject({
      tool: 'Bash',
      input_summary: expect.not.stringContaining('raw-bash-marker-in-elided-middle'),
    });
    expect(summary).toContain(`...[truncated, ${BASH_MARKER_COMMAND.length} chars]...`);
    expect(summary.endsWith(BASH_MARKER_COMMAND.slice(-40))).toBe(true);
    expect(result.data.tool_calls[0]).not.toHaveProperty('raw_input');
  });

  test('filters by --input-regex over raw structured input', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID_4, '--project', FAKE_PROJECT, '--input-regex', 'raw write content marker']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.tool_calls).toHaveLength(1);
    expect(result.data.tool_calls[0].tool).toBe('Write');
  });

  test('rejects invalid tools regex and mutually exclusive filters', async () => {
    const invalidRegex = parseOutput((await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--input-regex', '['])).stdout);
    expect(invalidRegex.ok).toBe(false);
    expect(invalidRegex.error.code).toBe('INVALID_ARGS');
    expect(invalidRegex.error.message).toContain('Invalid --input-regex regex');

    const nameConflict = parseOutput((await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--name', 'Read', '--name-match', 're'])).stdout);
    expect(nameConflict.ok).toBe(false);
    expect(nameConflict.error.code).toBe('INVALID_ARGS');

    const inputConflict = parseOutput((await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--input-match', 'x', '--input-regex', 'x'])).stdout);
    expect(inputConflict.ok).toBe(false);
    expect(inputConflict.error.code).toBe('INVALID_ARGS');
  });

  test('filters by --failed', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--failed']);
    const result = parseOutput(stdout);
    expect(result.data.tool_calls.length).toBe(1);
    expect(result.data.tool_calls[0].tool).toBe('Edit');
    expect(result.data.tool_calls[0].outcome).toContain('error:');
  });

  test('filters by turn range', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '4-6']);
    const result = parseOutput(stdout);
    expect(result.data.tool_calls.length).toBe(1);
    expect(result.data.tool_calls[0].turn).toBe(4);
  });
});

describe('tokens integration', () => {
  test('returns per-turn tokens', async () => {
    const { stdout } = await runCli(['tokens', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.agent_id).toBeNull();
    expect(result.data.turns.length).toBe(3);
    expect(result.data.turns[0].n).toBe(2);
    expect(result.data.turns[0].input).toBe(100);
    expect(result.data.totals.input).toBe(600);
    expect(result.data.totals.output).toBe(100);
  });

  test('cumulative mode', async () => {
    const { stdout } = await runCli(['tokens', SESSION_ID, '--project', FAKE_PROJECT, '--cumulative']);
    const result = parseOutput(stdout);
    const turns = result.data.turns;
    expect(turns[0].input).toBe(100);
    expect(turns[1].input).toBe(300);
    expect(turns[2].input).toBe(600);
    // Totals are always non-cumulative
    expect(result.data.totals.input).toBe(600);
  });
});

describe('messages integration', () => {
  test('returns all messages', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBeNull();
    expect(result.data.messages.length).toBe(6);
  });

  test('filters by role', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--role', 'user']);
    const result = parseOutput(stdout);
    expect(result.data.messages.every((m: any) => m.role === 'user')).toBe(true);
    expect(result.data.messages.length).toBe(3);
  });

  test('filters by type', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--type', 'tool_use']);
    const result = parseOutput(stdout);
    for (const msg of result.data.messages) {
      expect(msg.content.every((b: any) => b.type === 'tool_use')).toBe(true);
    }
  });

  test('filters by turn range', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-2']);
    const result = parseOutput(stdout);
    expect(result.data.messages.length).toBe(2);
    expect(result.data.messages[0].n).toBe(1);
    expect(result.data.messages[1].n).toBe(2);
  });

  test('truncates content', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--max-content', '10']);
    const result = parseOutput(stdout);
    const userMsg = result.data.messages.find((m: any) => m.n === 1);
    expect(userMsg.content[0].text).toContain('...[truncated,');
  });

  test('single-turn text and thinking are unbounded by default while tool results remain bounded', async () => {
    const textResult = parseOutput((await runCli(['messages', SESSION_ID_5, '--project', FAKE_PROJECT, '--turn', '1'])).stdout);
    expect(textResult.data.messages[0].content[0].text).toBe('x'.repeat(8300));

    const thinkingResult = parseOutput((await runCli(['messages', SESSION_ID_3, '--project', FAKE_PROJECT, '--turn', '2', '--type', 'thinking'])).stdout);
    expect(thinkingResult.data.messages[0].content[0].text).toBe(`Considering the approach... ${'x'.repeat(260)}`);

    const toolResult = parseOutput((await runCli(['messages', SESSION_ID_5, '--project', FAKE_PROJECT, '--turn', '1-2'])).stdout);
    expect(toolResult.data.messages[0].content[0].text).toContain('...[truncated, 8300 chars]');
  });

  test('--max-tool-result bounds tool results independently from single-turn text', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '3', '--max-tool-result', '5']);
    const result = parseOutput(stdout);
    expect(result.data.messages[0].content[0].content).toBe('src/h...[truncated, 30 chars]');
  });
});

describe('slice integration', () => {
  test('returns entries for turn range', async () => {
    const { stdout } = await runCli(['slice', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-2']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBeNull();
    expect(result.data.entries.length).toBe(2);
    expect(result.data.entries[0].type).toBe('user');
    expect(result.data.entries[1].type).toBe('assistant');
  });

  test('truncates content with max-content', async () => {
    const { stdout } = await runCli(['slice', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '2', '--max-content', '10']);
    const result = parseOutput(stdout);
    expect(result.data.entries.length).toBe(1);
    const blocks = result.data.entries[0].message.content;
    const thinking = blocks.find((b: any) => b.type === 'thinking');
    expect(thinking.thinking).toContain('...[truncated,');
  });

  test('applies explicit slice truncation policy including zero', async () => {
    const { stdout } = await runCli(['slice', SESSION_ID_5, '--project', FAKE_PROJECT, '--turn', '1', '--max-content', '0']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.entries[0].message.content).toBe('...[truncated, 8300 chars]');
  });
});

describe('stdout envelope bytes', () => {
  test('a success run prints the envelope as pretty JSON with one trailing newline', async () => {
    const { exitCode, stdout } = await runCli(['slice', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(JSON.stringify(JSON.parse(stdout), null, 2) + '\n');
  });

  test('an error run prints the envelope the same way and keeps its exit code', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'nonexistent-session-id', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(3);
    expect(parseOutput(stdout).error.code).toBe('NOT_FOUND');
    expect(stdout).toBe(JSON.stringify(JSON.parse(stdout), null, 2) + '\n');
  });
});

// `runCli` cannot see the pipe-truncation bug: its Bun.spawn pipe buffers far more than 64 KiB. These tests run the
// CLI inside `sh -c` so stdout is a real pipe(2) whose reader the script controls.
describe('stdout through a real pipe', () => {
  const PIPE_DIR = join(SHORT_TMP_ROOT, uniqueTempName('cc-session-pipe'));
  const PIPE_HOME = join(PIPE_DIR, 'home');
  const PIPE_PROJECT = `pipe-fixture-${randomUUID().replace(/-/g, '')}`;
  const PIPE_SESSION = randomUUID();
  const PIPE_ENTRY = join(import.meta.dir, 'index.ts');
  const PIPE_MESSAGE_CHARS = 200_000;
  const TEST_TIMEOUT_MS = 30_000;
  // Plain strings, not template literals: JS interpolation must not touch the shell variables.
  const SLICE = '"$BUN" "$ENTRY" slice "$SESSION" --claude-project "$PROJECT" --turn 1';

  beforeAll(() => {
    const projectDir = join(claudeProjectsRoot(PIPE_HOME), PIPE_PROJECT);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${PIPE_SESSION}.jsonl`), JSON.stringify({
      type: 'user',
      sessionId: PIPE_SESSION,
      timestamp: '2026-03-01T10:00:00.000Z',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: 'a'.repeat(PIPE_MESSAGE_CHARS) },
    }) + '\n');
  });

  afterAll(() => {
    rmSync(PIPE_DIR, { recursive: true, force: true });
  });

  /** Runs `script` under `sh -c` with the Bun binary, entry point and fixture identity in the environment. */
  async function runPipeScript(script: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: Buffer; exitCode: number }> {
    const proc = Bun.spawn(['sh', '-c', script], {
      env: {
        ...process.env,
        HOME: PIPE_HOME,
        BUN: process.execPath,
        ENTRY: PIPE_ENTRY,
        SESSION: PIPE_SESSION,
        PROJECT: PIPE_PROJECT,
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'ignore',
      // sh leads its own process group so a hung pipeline can be killed whole: killing only sh leaves the other
      // members holding its stdout open, and the read below never finishes.
      detached: true,
    });
    const killGroup = () => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    const killer = setTimeout(killGroup, TEST_TIMEOUT_MS - 5_000);
    try {
      const stdout = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    } finally {
      clearTimeout(killer);
      if (proc.exitCode === null && proc.signalCode === null) killGroup();
    }
  }

  /** `sh` can exit before every pipeline member's status file is written, so poll briefly for a non-empty one. */
  async function readStatusFile(path: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8').trim();
        if (text !== '') return text;
      }
      await Bun.sleep(50);
    }
    return '';
  }

  function pipePath(name: string): string {
    return join(PIPE_DIR, `${name}-${randomUUID()}`);
  }

  test('a late reader gets the complete output, byte-identical to redirect-to-file, and exit 0', async () => {
    const status = pipePath('status');
    const err = pipePath('err');
    const file = pipePath('file');

    // dd blocks until the CLI's first write, then the reader stalls while the CLI fills the pipe.
    const piped = await runPipeScript(
      '( ' + SLICE + ' 2> "$ERR"; echo $? > "$STATUS" ) | { dd bs=1 count=1 2>/dev/null; sleep 0.5; cat; }',
      { STATUS: status, ERR: err },
    );
    await runPipeScript(SLICE + ' > "$FILE"', { FILE: file });

    expect(readFileSync(err, 'utf8')).toBe('');
    const expected = readFileSync(file);
    expect(expected.length).toBeGreaterThan(PIPE_MESSAGE_CHARS);
    const envelope = JSON.parse(piped.stdout.toString('utf8'));
    expect(envelope.ok).toBe(true);
    expect(envelope.data.entries[0].message.content.length).toBe(PIPE_MESSAGE_CHARS);
    expect(piped.stdout.equals(expected)).toBe(true);
    expect(await readStatusFile(status)).toBe('0');
  }, TEST_TIMEOUT_MS);

  test('a reader that closes early gets exit 1 and nothing on stderr', async () => {
    const status = pipePath('status');
    const err = pipePath('err');

    await runPipeScript(
      '( ' + SLICE + ' 2> "$ERR"; echo $? > "$STATUS" ) | head -c 10 > /dev/null',
      { STATUS: status, ERR: err },
    );

    expect(await readStatusFile(status)).toBe('1');
    expect(readFileSync(err, 'utf8')).toBe('');
  }, TEST_TIMEOUT_MS);

  test.skipIf(!existsSync('/dev/full'))('a write error other than a closed reader reports OUTPUT_ERROR on stderr and exits 1', async () => {
    const status = pipePath('status');
    const err = pipePath('err');

    await runPipeScript(SLICE + ' > /dev/full 2> "$ERR"; echo $? > "$STATUS"', { STATUS: status, ERR: err });

    expect(await readStatusFile(status)).toBe('1');
    const report = JSON.parse(readFileSync(err, 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.error.code).toBe('OUTPUT_ERROR');
    expect(report.error.message).toContain('ENOSPC');
  }, TEST_TIMEOUT_MS);

  test('stdout opened read-only reports OUTPUT_ERROR on stderr and exits 1, on every OS', async () => {
    const status = pipePath('status');
    const err = pipePath('err');
    const readOnly = pipePath('readonly');
    writeFileSync(readOnly, '');

    // Unlike /dev/full this exists everywhere. A closed stdout (`>&-`) cannot stand in: Bun reopens fd 1 as /dev/null.
    await runPipeScript(
      SLICE + ' 1< "$READONLY" 2> "$ERR"; echo $? > "$STATUS"',
      { STATUS: status, ERR: err, READONLY: readOnly },
    );

    expect(await readStatusFile(status)).toBe('1');
    const report = JSON.parse(readFileSync(err, 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.error.code).toBe('OUTPUT_ERROR');
    expect(report.error.message).toContain('EBADF');
  }, TEST_TIMEOUT_MS);

  test('SIGTERM during a stalled write takes the default action and appends no second envelope', async () => {
    const status = pipePath('status');
    const err = pipePath('err');
    const pidFile = pipePath('pid');
    const ready = pipePath('ready');

    // The CLI runs in the background so `$!` is its own PID. The reader signals READY after the first byte, then
    // stalls, so the CLI is inside its synchronous write (200 KB cannot fit in the pipe) when the signal lands.
    let settled = false;
    const run = runPipeScript(
      '( ' + SLICE + ' 2> "$ERR" & echo $! > "$PIDFILE.tmp" && mv "$PIDFILE.tmp" "$PIDFILE"; wait $!; echo $? > "$STATUS" )'
        + ' | { dd bs=1 count=1 2>/dev/null; : > "$READY"; sleep 1.5; cat; }',
      { STATUS: status, ERR: err, PIDFILE: pidFile, READY: ready },
    ).finally(() => {
      settled = true;
    });

    let cliPid = 0;
    try {
      for (let i = 0; i < 200 && !(existsSync(ready) && cliPid > 0); i++) {
        if (existsSync(pidFile)) cliPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) || 0;
        if (!(existsSync(ready) && cliPid > 0)) await Bun.sleep(25);
      }
      // process.kill(0, ...) would signal the test runner's own process group.
      expect(cliPid).toBeGreaterThan(1);
      expect(existsSync(ready)).toBe(true);
      try {
        process.kill(cliPid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }

      const piped = await run;
      expect(readFileSync(err, 'utf8')).toBe('');
      expect(await readStatusFile(status)).toBe('143');
      expect(piped.stdout.toString('utf8')).not.toContain('TERMINATED');
    } finally {
      // Once `run` settles, sh has reaped the CLI and its PID may belong to an unrelated process.
      if (!settled && cliPid > 1) {
        try {
          process.kill(cliPid, 'SIGKILL');
        } catch {
          // Already exited.
        }
      }
    }
  }, TEST_TIMEOUT_MS);
});

// ============================================================================
// userAssistantEntries
// ============================================================================

describe('userAssistantEntries', () => {
  test('filters to user and assistant only', () => {
    const entries = [
      { type: 'system' as const },
      { type: 'user' as const, message: { role: 'user', content: 'hi' } },
      { type: 'summary' as const },
      { type: 'assistant' as const, message: { role: 'assistant', content: [] } },
    ];
    const result = userAssistantEntries(entries);
    expect(result.length).toBe(2);
    expect(result[0]!.type).toBe('user');
    expect(result[1]!.type).toBe('assistant');
  });
});

// ============================================================================
// transcript module foundation
// ============================================================================

describe('transcript module foundation', () => {
  test('contentBlocksForEntry normalizes string-shaped content into text blocks', () => {
    expect(contentBlocksForEntry({
      type: 'user',
      message: { role: 'user', content: 'plain prompt text' },
    })).toEqual([{ type: 'text', text: 'plain prompt text' }]);
  });

  test('contentBlocksForEntry preserves array-shaped content', () => {
    const blocks = [{ type: 'text' as const, text: 'array prompt' }];
    expect(contentBlocksForEntry({ type: 'user', message: { content: blocks } })).toBe(blocks);
  });

  test('normalizedBlocks numbers only user and assistant turns', () => {
    const entries = [
      { type: 'system' as const, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'user' as const, timestamp: '2026-01-01T00:00:01Z', message: { content: 'first' } },
      { type: 'summary' as const },
      {
        type: 'assistant' as const,
        timestamp: '2026-01-01T00:00:02Z',
        message: { content: [{ type: 'thinking' as const, thinking: 'hmm' }, { type: 'text' as const, text: 'second' }] },
      },
    ];

    expect(normalizedBlocks(entries)).toEqual([
      {
        turn: 1,
        block_index: 0,
        role: 'user',
        timestamp: '2026-01-01T00:00:01Z',
        block: { type: 'text', text: 'first' },
      },
      {
        turn: 2,
        block_index: 0,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:02Z',
        block: { type: 'thinking', thinking: 'hmm' },
      },
      {
        turn: 2,
        block_index: 1,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:02Z',
        block: { type: 'text', text: 'second' },
      },
    ]);
  });

  test('extractSessionMetadata returns bounded model metadata from transcript module', () => {
    const text = [
      JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'main', timestamp: '2026-01-01T00:00:00Z', version: '1.2.3' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-1', content: [] }, slug: 'model-test' }),
    ].join('\n');

    expect(extractTranscriptSessionMetadata(text)).toEqual({
      branch: 'main',
      timestamp: '2026-01-01T00:00:00Z',
      version: '1.2.3',
      slug: 'model-test',
      model: 'claude-opus-4-1',
    });
  });

  test('resolveSessionWithText returns raw text, filtered entries, metadata, and line count', async () => {
    const result = await resolveSessionWithText({
      session: SESSION_ID,
      project: FAKE_PROJECT,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.agentId).toBeNull();
    expect(result.filePath).toBe(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`));
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.allEntries.length).toBeGreaterThanOrEqual(result.entries.length);
    expect(result.entries.every(e => e.type === 'user' || e.type === 'assistant')).toBe(true);
    expect(result.lineCount).toBe(result.text.trim().split('\n').length);
    expect(result.metadata.branch).toBe('main');
  });

  test('transcript parser and line counter handle empty, malformed, and valid rows', async () => {
    expect(parseTranscriptSessionText('')).toEqual([]);
    expect(() => parseTranscriptSessionText('not json\n')).toThrow('Session file contains no valid entries');
    expect(countNonEmptyLines('\n one \n\n two')).toBe(2);

    const filePath = join(CLAUDE_DIR, 'transcript-module-parse.jsonl');
    writeFileSync(filePath, [
      '',
      'not json',
      JSON.stringify({ type: 'user', message: { content: 'valid row' } }),
      JSON.stringify({ nope: true }),
    ].join('\n'));

    expect(await parseTranscriptSessionLines(filePath)).toEqual([
      { type: 'user', message: { content: 'valid row' } },
    ]);
  });

  test('transcript intent extraction includes slug, first prompt token, and first message', () => {
    const intents = extractSessionIntent([
      { type: 'assistant', message: { content: 'ignored assistant first' } },
      { type: 'user', message: { content: '/plan install packages' } },
    ], { slug: 'module-slug' });

    expect(intents).toEqual([
      { source: 'slug', value: 'module-slug' },
      { source: 'first_prompt', value: '/plan' },
      { source: 'first_message', value: '/plan install packages' },
    ]);
  });

  test('transcript resolver handles prefix, slug, ambiguity, missing, and subagent targets', async () => {
    expect(await resolveTranscriptByIdOrSlug(CLAUDE_DIR, SESSION_ID.slice(0, 8)))
      .toBe(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`));
    expect(await resolveTranscriptByIdOrSlug(CLAUDE_DIR, 'late-slug-test'))
      .toBe(join(CLAUDE_DIR, `${SESSION_ID_5}.jsonl`));

    await expect(resolveTranscriptByIdOrSlug(CLAUDE_DIR, 'test-slug-fixture'))
      .rejects.toThrow('Ambiguous slug');
    await expect(resolveTranscriptByIdOrSlug(CLAUDE_DIR, 'no-such-session'))
      .rejects.toThrow('No session found');
    await expect(resolveTranscriptByIdOrSlug(CLAUDE_DIR, '../bad'))
      .rejects.toThrow('Invalid session ID');

    expect(await resolveTranscriptSessionFile(CLAUDE_DIR, `${SESSION_ID}:${SUBAGENT_ID}`)).toEqual({
      filePath: join(CLAUDE_DIR, SESSION_ID, 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
      sessionId: SESSION_ID,
      agentId: SUBAGENT_ID,
    });
    await expect(resolveTranscriptSessionFile(CLAUDE_DIR, `${SESSION_ID}:bad/id`))
      .rejects.toThrow('Invalid agent ID');
    await expect(resolveTranscriptSessionFile(CLAUDE_DIR, `${SESSION_ID}:missing`))
      .rejects.toThrow('No subagent');
  });

  test('buildSessionSummary computes snippets, timing, tool counts, file counts, and subagents', () => {
    const longPrompt = 'x'.repeat(450);
    const summary = buildSessionSummary({
      sessionId: SESSION_ID,
      agentId: null,
      lineCount: 4,
      metadata: {
        branch: 'main',
        timestamp: '2026-01-01T00:00:00.000Z',
        version: '1.0.0',
        slug: 'summary-slug',
        model: 'claude-sonnet-4-5',
      },
      subagents: [{ agent_id: SUBAGENT_ID, agent_type: 'worker', description: 'does work', lines: 5, timestamp: '2026-01-01T00:00:04.000Z' }],
      entries: [
        { type: 'system', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'user', timestamp: '2026-01-01T00:00:01.000Z', message: { content: longPrompt } },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:03.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', id: 'read_1', input: { file_path: 'a.ts' } },
              { type: 'tool_use', name: 'Edit', id: 'edit_1', input: { file_path: 'a.ts' } },
              { type: 'tool_use', name: 'Write', id: 'write_1', input: { file_path: 'b.ts' } },
              { type: 'tool_use', name: 'Grep', id: 'grep_1', input: { path: 'src' } },
              { type: 'tool_use', name: 'Glob', id: 'glob_1', input: { path: 'src' } },
              { type: 'tool_use', name: 'Bash', id: 'bash_1', input: { command: 'bun test' } },
              { type: 'text', text: 'done' },
            ],
          },
        },
      ],
    });

    expect(summary).toMatchObject({
      session_id: SESSION_ID,
      agent_id: null,
      branch: 'main',
      model: 'claude-sonnet-4-5',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:03.000Z',
      duration_ms: 3000,
      turn_count: 2,
      lines: 4,
      slug: 'summary-slug',
      last_assistant_text: { turn: 2, snippet: 'done' },
      tool_counts: { Read: 1, Edit: 1, Write: 1, Grep: 1, Glob: 1, Bash: 1 },
      files_touched: { read: 1, edit: 1, write: 1, grep: 1, glob: 1 },
      subagents: [{ agent_id: SUBAGENT_ID, agent_type: 'worker', description: 'does work', lines: 5, timestamp: '2026-01-01T00:00:04.000Z' }],
    });
    expect(summary.first_user_prompt).toEqual({
      turn: 1,
      snippet: `${'x'.repeat(400)}...[truncated, 450 chars]`,
    });
  });

  test('applyTruncationPolicy centralizes per-kind max character behavior', () => {
    expect(applyTruncationPolicy('hello world', { textMaxChars: 5 }, 'text'))
      .toBe('hello...[truncated, 11 chars]');
    expect(applyTruncationPolicy('hello world', { textMaxChars: null }, 'text'))
      .toBe('hello world');
    expect(applyTruncationPolicy('abcdef', { defaultMaxChars: 3 }, 'thinking'))
      .toBe('abc...[truncated, 6 chars]');
  });
});

describe('project-selection module foundation', () => {
  test('module project scope helpers preserve existing target shape', () => {
    const unique = uniqueTempName('cc-session-tool-module-target');
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'repo');
    const claudeDir = join(root, mangleProjectPathModule(projectPath));
    const session = '11111111-2222-3333-4444-555555555555';
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, `${session}.jsonl`), JSON.stringify({ type: 'user' }) + '\n');

    try {
      const context = buildScopedSearchScopeModule({ projectPath, claudeProjectsRoot: root, includeWorktrees: false }).projects[0]!;
      expect(listSearchTargetsForContextModule(context)).toEqual([{
        filePath: join(claudeDir, `${session}.jsonl`),
        sessionId: session,
        context,
        projectRef: context.projectRef,
      }]);
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  const globSelection = () => selectProjectContexts({
    mode: 'all-projects',
    claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    projectGlob: `*${fakeDirName}`,
  });

  test('buildProjectScanMeta returns only the two counts by default', () => {
    const selection = globSelection();
    expect(selection.skippedProjects.length).toBeGreaterThan(0);
    const scanMeta = buildProjectScanMeta(selection, { includeLists: false });
    expect(scanMeta).toEqual({
      projects_scanned: selection.contexts.length,
      projects_skipped: selection.skippedProjects.length,
    });
    expect(scanMeta).not.toHaveProperty('included_projects');
    expect(scanMeta).not.toHaveProperty('skipped_projects');
  });

  test('buildProjectScanMeta with includeLists derives included_projects from the scanned contexts', () => {
    const selection = globSelection();
    const scanMeta = buildProjectScanMeta(selection, { includeLists: true });
    expect(scanMeta.projects_scanned).toBe(selection.contexts.length);
    expect(scanMeta.projects_skipped).toBe(selection.skippedProjects.length);
    expect(scanMeta.included_projects?.map(ref => ref.project)).toEqual(selection.contexts.map(context => context.projectRef.project));
    expect(scanMeta.skipped_projects).toEqual(selection.skippedProjects);
  });

  test('selectProjectContexts scoped mode honors projectGlob and reports glob-excluded contexts as skipped', () => {
    const selection = selectProjectContexts({
      mode: 'scoped-with-worktrees',
      projectPath: RELATED_PROJECT,
      projectGlob: relatedWorktreeDirName,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });
    expect(selection.contexts.map(context => context.projectRef.project)).toEqual([relatedWorktreeDirName]);
    expect(selection.contexts.map(context => [context.projectRef.project, context.role])).toEqual([
      [relatedWorktreeDirName, 'worktree'],
    ]);
    expect(selection.skippedProjects.map(ref => [ref.project, ref.project_role])).toEqual([
      [relatedDirName, 'main'],
      [relatedSiblingWorktreeDirName, 'worktree'],
    ]);
  });

  test('selectProjectContexts scoped mode without projectGlob skips nothing', () => {
    const selection = selectProjectContexts({
      mode: 'scoped-with-worktrees',
      projectPath: RELATED_PROJECT,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });
    expect(selection.contexts).toHaveLength(3);
    expect(selection.skippedProjects).toEqual([]);
  });
});

// ============================================================================
// parseSessionLines
// ============================================================================

describe('parseSessionText', () => {
  test('skips malformed lines and returns valid ones', () => {
    const entries = parseSessionText([
      'not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '{ broken',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
    ].join('\n') + '\n');
    expect(entries.length).toBe(2);
    expect(entries[0]!.type).toBe('user');
    expect(entries[1]!.type).toBe('assistant');
  });

  test('throws FORMAT_ERROR when text has only malformed lines', () => {
    try {
      parseSessionText('not json\nalso not json\n');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('FORMAT_ERROR');
      expect(err.message).toContain('no valid entries');
    }
  });

  test('returns empty array for empty text', () => {
    expect(parseSessionText('\n\n')).toEqual([]);
  });
});

describe('parseSessionLines', () => {
  test('skips malformed lines and returns valid ones', async () => {
    const filePath = join(CLAUDE_DIR, 'parse-test-1.jsonl');
    writeFileSync(filePath, [
      'not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '{ broken',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
    ].join('\n') + '\n');
    const entries = await parseSessionLines(filePath);
    expect(entries.length).toBe(2);
    expect(entries[0]!.type).toBe('user');
    expect(entries[1]!.type).toBe('assistant');
  });

  test('skips empty lines', async () => {
    const filePath = join(CLAUDE_DIR, 'parse-test-2.jsonl');
    writeFileSync(filePath, [
      '',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '  ',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
      '',
    ].join('\n'));
    const entries = await parseSessionLines(filePath);
    expect(entries.length).toBe(2);
  });

  test('throws FORMAT_ERROR when all lines are invalid', async () => {
    const filePath = join(CLAUDE_DIR, 'parse-test-3.jsonl');
    writeFileSync(filePath, 'not json\nalso not json\n');
    try {
      await parseSessionLines(filePath);
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.errorCode).toBe('FORMAT_ERROR');
      expect(err.message).toContain('no valid entries');
    }
  });

  test('rejects objects without type field', async () => {
    const filePath = join(CLAUDE_DIR, 'parse-test-4.jsonl');
    writeFileSync(filePath, [
      JSON.stringify({ noType: true }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    ].join('\n') + '\n');
    const entries = await parseSessionLines(filePath);
    expect(entries.length).toBe(1);
    expect(entries[0]!.type).toBe('user');
  });
});

// ============================================================================
// resolveSessionFile
// ============================================================================

describe('resolveSessionFile', () => {
  test('empty input throws INVALID_ARGS', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, '');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ARGS');
    }
  });

  test('invalid characters throws INVALID_ID', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, '../etc/passwd');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
    }
  });

  test('exact UUID match resolves', async () => {
    const result = await resolveSessionFile(CLAUDE_DIR, SESSION_ID);
    expect(result.filePath).toBe(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`));
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.agentId).toBeNull();
  });

  test('UUID prefix match resolves', async () => {
    const result = await resolveSessionFile(CLAUDE_DIR, SESSION_ID_3.slice(0, 8));
    expect(result.filePath).toBe(join(CLAUDE_DIR, `${SESSION_ID_3}.jsonl`));
    expect(result.sessionId).toBe(SESSION_ID_3);
    expect(result.agentId).toBeNull();
  });

  test('late slug after 8192 bytes resolves', async () => {
    expect(Buffer.byteLength(LATE_SLUG_FIRST_LINE)).toBeGreaterThan(8192);

    const result = await resolveSessionFile(CLAUDE_DIR, 'late-slug-test');
    expect(result.filePath).toBe(join(CLAUDE_DIR, `${SESSION_ID_5}.jsonl`));
    expect(result.sessionId).toBe(SESSION_ID_5);
    expect(result.agentId).toBeNull();
  });

  test('non-existent session throws NOT_FOUND', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, 'zzzzzzzz-0000-0000-0000-000000000000');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('NOT_FOUND');
    }
  });

  test('ambiguous slug throws INVALID_ID', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, 'test-slug-fixture');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
      expect(err.message).toContain('Ambiguous slug');
    }
  });

  // Colon notation tests
  test('colon notation resolves to ResolvedFile with correct fields', async () => {
    const result = await resolveSessionFile(CLAUDE_DIR, `${SESSION_ID}:${SUBAGENT_ID}`);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.agentId).toBe(SUBAGENT_ID);
    expect(result.filePath).toBe(join(CLAUDE_DIR, SESSION_ID, 'subagents', `agent-${SUBAGENT_ID}.jsonl`));
  });

  test('empty agent ID throws INVALID_ID', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, `${SESSION_ID}:`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
      expect(err.message).toContain('Invalid agent ID');
    }
  });

  test('empty session part throws INVALID_ID', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, ':some-agent');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
      expect(err.message).toContain('Invalid session ID portion');
    }
  });

  test('multiple colons throws INVALID_ID (agent part contains colon)', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, 'a:b:c');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
      expect(err.message).toContain('Invalid agent ID');
    }
  });

  test('underscore in agent ID is valid (validates regex but throws NOT_FOUND)', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, `${SESSION_ID}:aprompt_suggestion-b96624`);
      expect(true).toBe(false);
    } catch (err: any) {
      // Passes regex validation (underscores allowed in agent IDs) but file doesn't exist
      expect(err.errorCode).toBe('NOT_FOUND');
      expect(err.message).toContain('No subagent');
    }
  });

  test('non-existent subagent throws NOT_FOUND', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, `${SESSION_ID}:nonexistent-agent`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('NOT_FOUND');
      expect(err.message).toContain('No subagent');
    }
  });

  test('rejects path traversal in agent ID', async () => {
    try {
      await resolveSessionFile(CLAUDE_DIR, `${SESSION_ID}:../../../etc`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
    }
  });
});

// ============================================================================
// resolveSession
// ============================================================================

describe('resolveSession', () => {
  test('returns sessionId, agentId, and filtered entries', async () => {
    const result = await resolveSession({ session: SESSION_ID, project: FAKE_PROJECT, claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT });
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.agentId).toBeNull();
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every(e => e.type === 'user' || e.type === 'assistant')).toBe(true);
  });

  test('throws NOT_FOUND for non-existent session', async () => {
    try {
      await resolveSession({ session: 'zzzzzzzz-0000-0000-0000-000000000000', project: FAKE_PROJECT, claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('NOT_FOUND');
    }
  });

  test('throws NOT_FOUND for non-existent project', async () => {
    try {
      await resolveSession({ session: SESSION_ID, project: '/nonexistent/project/path' });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('NOT_FOUND');
    }
  });

  test('resolves subagent with colon notation', async () => {
    const result = await resolveSession({ session: `${SESSION_ID}:${SUBAGENT_ID}`, project: FAKE_PROJECT, claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT });
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.agentId).toBe(SUBAGENT_ID);
    expect(result.entries.length).toBe(2);
    expect(result.entries.every(e => e.type === 'user' || e.type === 'assistant')).toBe(true);
  });
});

// ============================================================================
// extractFilePath
// ============================================================================

describe('extractFilePath', () => {
  test('Read extracts file_path as read', () => {
    expect(extractFilePath('Read', { file_path: '/a/b/c.ts' }))
      .toEqual({ path: '/a/b/c.ts', operation: 'read' });
  });

  test('Edit extracts file_path as edit', () => {
    expect(extractFilePath('Edit', { file_path: '/a/b/c.ts', old_string: 'x', new_string: 'y' }))
      .toEqual({ path: '/a/b/c.ts', operation: 'edit' });
  });

  test('Write extracts file_path as write', () => {
    expect(extractFilePath('Write', { file_path: '/x/y.txt', content: 'hello' }))
      .toEqual({ path: '/x/y.txt', operation: 'write' });
  });

  test('Grep extracts path as grep', () => {
    expect(extractFilePath('Grep', { pattern: 'foo', path: 'src/' }))
      .toEqual({ path: 'src/', operation: 'grep' });
  });

  test('Grep without path returns null', () => {
    expect(extractFilePath('Grep', { pattern: 'foo' })).toBeNull();
  });

  test('file tools with malformed or blank paths return null', () => {
    expect(extractFilePath('Read', { file_path: 42 })).toBeNull();
    expect(extractFilePath('Write', { file_path: '' })).toBeNull();
    expect(extractFilePath('Edit', { file_path: '   ' })).toBeNull();
    expect(extractFilePath('Grep', { path: ['src'] })).toBeNull();
    expect(extractFilePath('Glob', { path: null })).toBeNull();
  });

  test('Glob extracts path as glob', () => {
    expect(extractFilePath('Glob', { pattern: '*.ts', path: 'lib/' }))
      .toEqual({ path: 'lib/', operation: 'glob' });
  });

  test('Glob without path returns null', () => {
    expect(extractFilePath('Glob', { pattern: '*.ts' })).toBeNull();
  });

  test('Bash returns null', () => {
    expect(extractFilePath('Bash', { command: 'ls' })).toBeNull();
  });

  test('unknown tool returns null', () => {
    expect(extractFilePath('WebSearch', { query: 'test' })).toBeNull();
  });
});

// ============================================================================
// buildResultLookup
// ============================================================================

describe('buildResultLookup', () => {
  test('returns empty map for entries with no tool_results', () => {
    const entries = [
      { type: 'assistant' as const, message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu1' }] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.size).toBe(0);
  });

  test('maps tool_use_id to correct result info', () => {
    const entries = [
      { type: 'user' as const, timestamp: '2025-01-01T00:00:00Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'file contents' },
      ] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.get('tu1')).toEqual({
      is_error: false,
      content: 'file contents',
      result_ts: '2025-01-01T00:00:00Z',
    });
  });

  test('handles multiple tool_results in a single user entry', () => {
    const entries = [
      { type: 'user' as const, timestamp: '2025-01-01T00:00:00Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'fail' },
      ] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.size).toBe(2);
    expect(lookup.get('tu2')!.is_error).toBe(true);
  });

  test('skips non-user entries', () => {
    const entries = [
      { type: 'assistant' as const, message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'x' },
      ] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.size).toBe(0);
  });

  test('defaults is_error to false when undefined', () => {
    const entries = [
      { type: 'user' as const, message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
      ] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.get('tu1')!.is_error).toBe(false);
  });

  test('sets result_ts from entry timestamp', () => {
    const entries = [
      { type: 'user' as const, timestamp: '2025-06-15T12:00:00Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
      ] } },
    ];
    const lookup = buildResultLookup(entries as any);
    expect(lookup.get('tu1')!.result_ts).toBe('2025-06-15T12:00:00Z');
  });
});

// ============================================================================
// extractSessionMetadata
// ============================================================================

describe('extractSessionMetadata', () => {
  test('extracts all fields from valid first entry', () => {
    const text = JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'main', timestamp: '2025-01-01T00:00:00Z', version: '1.0' });
    const meta = extractSessionMetadata(text);
    expect(meta).toEqual({ branch: 'main', timestamp: '2025-01-01T00:00:00Z', version: '1.0', slug: null, model: null });
  });

  test('returns all nulls when no sessionId in first 5 lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `msg${i}` } }));
    const meta = extractSessionMetadata(lines.join('\n'));
    expect(meta).toEqual({ branch: null, timestamp: null, version: null, slug: null, model: null });
  });

  test('finds slug deeper in text via regex', () => {
    const header = JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'dev', timestamp: '2025-01-01T00:00:00Z' });
    const filler = Array.from({ length: 10 }, () => JSON.stringify({ type: 'user', message: { content: 'hi' } }));
    const slugLine = JSON.stringify({ type: 'assistant', slug: 'my-cool-slug' });
    const text = [header, ...filler, slugLine].join('\n');
    const meta = extractSessionMetadata(text);
    expect(meta.slug).toBe('my-cool-slug');
  });

  test('can skip slug extraction', () => {
    const header = JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'dev', timestamp: '2025-01-01T00:00:00Z' });
    const slugLine = JSON.stringify({ type: 'assistant', slug: 'my-cool-slug' });
    const meta = extractSessionMetadata([header, slugLine].join('\n'), { includeSlug: false });
    expect(meta.branch).toBe('dev');
    expect(meta.timestamp).toBe('2025-01-01T00:00:00Z');
    expect(meta.slug).toBeNull();
  });

  test('returns null slug when no slug pattern exists', () => {
    const text = JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'main', timestamp: '2025-01-01T00:00:00Z' });
    const meta = extractSessionMetadata(text);
    expect(meta.slug).toBeNull();
  });

  test('handles malformed JSON in first lines gracefully', () => {
    const text = 'not json\n{bad\n' + JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'fix', timestamp: '2025-06-01T00:00:00Z', version: '2.0' });
    const meta = extractSessionMetadata(text);
    expect(meta.branch).toBe('fix');
    expect(meta.version).toBe('2.0');
  });
});

// ============================================================================
// shape block_index
// ============================================================================

describe('shape block_index', () => {
  test('all rows include block_index', async () => {
    const { stdout } = await runCli(['shape', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    for (const row of result.data.turns) {
      expect(typeof row.block_index).toBe('number');
      expect(row.block_index).toBeGreaterThanOrEqual(0);
    }
  });

  test('single-block and collapsed turns have block_index 0', async () => {
    const { stdout } = await runCli(['shape', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.data.turns.every((r: any) => r.block_index === 0)).toBe(true);
  });

  test('multi-block assistant turns without tool_use get incrementing block_index', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID_3, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    const turns = result.data.turns;
    // Turn 1: user string -> block_index: 0
    expect(turns[0].block_index).toBe(0);
    // Turn 2: assistant [thinking, text] -> two rows with block_index 0 and 1
    expect(turns[1].type).toBe('thinking');
    expect(turns[1].block_index).toBe(0);
    expect(turns[2].type).toBe('text');
    expect(turns[2].block_index).toBe(1);
  });
});

// ============================================================================
// files integration
// ============================================================================

describe('files integration', () => {
  test('returns files grouped by file (default)', async () => {
    const { exitCode, stdout } = await runCli(['files', SESSION_ID, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.agent_id).toBeNull();
    expect(result.data.group_by).toBe('file');
    expect(result.data.files.length).toBe(2);

    const grepFile = result.data.files.find((f: any) => f.path === 'src/');
    expect(grepFile).toBeDefined();
    expect(grepFile.operations).toEqual(['grep']);
    expect(grepFile.turns).toEqual([2]);
    expect(grepFile.errored).toBe(false);

    const editFile = result.data.files.find((f: any) => f.path === '/a/b/hello.ts');
    expect(editFile).toBeDefined();
    expect(editFile.operations).toEqual(['edit']);
    expect(editFile.turns).toEqual([4]);
    expect(editFile.errored).toBe(true);
  });

  test('returns file accesses grouped by turn', async () => {
    const { exitCode, stdout } = await runCli(['files', SESSION_ID, '--project', FAKE_PROJECT, '--group-by', 'turn']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.data.group_by).toBe('turn');
    expect(result.data.accesses.length).toBe(2);
    expect(result.data.accesses[0].turn).toBe(2);
    expect(result.data.accesses[0].path).toBe('src/');
    expect(result.data.accesses[0].operation).toBe('grep');
    expect(result.data.accesses[1].turn).toBe(4);
    expect(result.data.accesses[1].path).toBe('/a/b/hello.ts');
    expect(result.data.accesses[1].operation).toBe('edit');
    expect(result.data.accesses[1].errored).toBe(true);
  });

  test('filters by turn range', async () => {
    const { stdout } = await runCli(['files', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-3']);
    const result = parseOutput(stdout);
    expect(result.data.files.length).toBe(1);
    expect(result.data.files[0].path).toBe('src/');
  });

  test('filters by operation', async () => {
    const { stdout } = await runCli(['files', SESSION_ID, '--project', FAKE_PROJECT, '--operation', 'edit']);
    const result = parseOutput(stdout);
    expect(result.data.files.length).toBe(1);
    expect(result.data.files[0].path).toBe('/a/b/hello.ts');
  });

  test('invalid group-by returns error', async () => {
    const { exitCode, stdout } = await runCli(['files', SESSION_ID, '--project', FAKE_PROJECT, '--group-by', 'invalid']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  test('session with no file tools returns empty', async () => {
    const { stdout } = await runCli(['files', SESSION_ID_2, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.files.length).toBe(0);
  });
});

// ============================================================================
// Error Cases (CLI)
// ============================================================================

describe('error cases', () => {
  test('invalid session ID characters', async () => {
    const { exitCode, stdout } = await runCli(['shape', '../etc/passwd', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ID');
  });

  test('non-existent session', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'nonexistent-session-id', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  test('non-existent project dir', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', '/tmp/nonexistent-project-12345']);
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// Search Integration
// ============================================================================

describe('search integration', () => {
  test('--tool Grep finds session with Grep tool', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Grep', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.tools).toContain('Grep');
  });

  test('--tool Edit finds session with Edit tool', async () => {
    const { stdout } = await runCli(['search', '--tool', 'Edit', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.tools).toContain('Edit');
  });

  test('--tool grep is case-insensitive', async () => {
    const { stdout } = await runCli(['search', '--tool', 'grep', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.tools).toContain('Grep');
  });

  test('--file hello.ts finds session', async () => {
    const { stdout } = await runCli(['search', '--file', 'hello.ts', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.files.some((f: string) => f.includes('hello.ts'))).toBe(true);
  });

  test('scoped --file results omit cross-project fields', async () => {
    const { stdout } = await runCli(['search', '--file', 'hello.ts', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match).not.toHaveProperty('project');
    expect(match).not.toHaveProperty('project_path_guess');
  });

  test('--file hello.ts --operation edit binds operation to matching file access', async () => {
    const { stdout } = await runCli(['search', '--file', 'hello.ts', '--operation', 'edit', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.files).toEqual(['/a/b/hello.ts']);
    expect(match.matches.operations).toEqual(['edit']);
  });

  test('--operation write does not match writes to different files', async () => {
    const { stdout } = await runCli(['search', '--file', 'hello.ts', '--operation', 'write', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_4)).toBeUndefined();
    expect(result.data.every((s: any) => s.matches.files.every((f: string) => f.includes('hello.ts')))).toBe(true);
  });

  test('--file other.ts --operation write finds same-file write access', async () => {
    const { stdout } = await runCli(['search', '--file', 'other.ts', '--operation', 'write', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(match).toBeDefined();
    expect(match.matches.files).toEqual(['/workspace/other.ts']);
    expect(match.matches.operations).toEqual(['write']);
  });

  test('--all-projects --file returns matches from both fixture projects with project fields', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(2);

    const primary = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    const secondary = result.data.find((s: any) => s.session_id === SESSION_ID_6);
    expect(primary).toBeDefined();
    expect(primary.project).toBe(fakeDirName);
    expect(primary.project_path_guess).toBe(projectPathGuessFromClaudeProject(fakeDirName));
    expect(primary.project_role).toBe('global');
    expect(secondary).toBeDefined();
    expect(secondary.project).toBe(secondFakeDirName);
    expect(secondary.project_path_guess).toBe(projectPathGuessFromClaudeProject(secondFakeDirName));
    expect(secondary.project_role).toBe('global');
  });

  test('--all-projects --file --operation write returns only same-file writer fixture', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE, '--operation', 'write']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_4)).toBeUndefined();
    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_6);
    expect(writer).toBeDefined();
    expect(writer.matches.files).toEqual([`/worktree/${CROSS_PROJECT_FILE}`]);
    expect(writer.matches.operations).toEqual(['write']);
  });

  test('--all-projects composes with metadata filters', async () => {
    const { stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE, '--branch', 'worktree']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_4)).toBeUndefined();
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_6);
    expect(match).toBeDefined();
    expect(match.branch).toBe('worktree');
  });

  test('--all-projects --last applies after merged newest-first sorting', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE, '--last', '1']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].session_id).toBe(SESSION_ID_6);
    expect(result._meta.total).toBeGreaterThan(result._meta.returned);
    expect(result._meta.returned).toBe(1);
    expect(result._meta.hasMore).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(2);
  });

  test('--all-projects empty search succeeds with projects_scanned metadata', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', 'cc-session-tool-no-such-cross-project-file']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result._meta.total).toBe(0);
    expect(result._meta.returned).toBe(0);
    expect(result._meta.hasMore).toBe(false);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(2);
  });

  test('search --all-projects defaults to project counts without arrays', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(2);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
  });

  test('search --all-projects --include-project-lists adds both arrays', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE, '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.included_projects).toHaveLength(result._meta.projects_scanned);
    expect(result._meta.skipped_projects).toEqual([]);
  });

  test('search --aggregate counters --bucket counts bucket rows and keeps project counts by default', async () => {
    // RELATED_PROJECT has three Read sessions (2026-03-07, 03-08, 03-11) spanning two Monday-anchored weeks,
    // so total/returned only equal 2 if they are recomputed from the bucket rows rather than the session matches.
    const { exitCode, stdout } = await runCli([
      'search',
      '--tool', 'Read',
      '--counter', 'missing=no-such-counter-marker',
      '--aggregate', 'counters',
      '--bucket', 'week',
      '--project', RELATED_PROJECT,
    ]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.reduce((sum: number, row: any) => sum + row.sessions, 0)).toBe(3);
    expect(result._meta.total).toBe(2);
    expect(result._meta.returned).toBe(2);
    expect(result._meta.projects_scanned).toBe(3);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta).not.toHaveProperty('included_projects');
    expect(result._meta).not.toHaveProperty('skipped_projects');
  });

  test('search --all-projects --project-glob filters selected and skipped projects', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--project-glob', '*fake-project-worktree', '--file', CROSS_PROJECT_FILE, '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result._meta.projects_skipped).toBe(result._meta.skipped_projects.length);
    expect(result._meta.included_projects).toEqual([{
      project: secondFakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(secondFakeDirName),
      project_role: 'global',
    }]);
    expect(result._meta.skipped_projects).toContainEqual({
      project: fakeDirName,
      project_path_guess: projectPathGuessFromClaudeProject(fakeDirName),
      project_role: 'global',
    });
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_6]);
    expect(result.data[0].project).toBe(secondFakeDirName);
    expect(result.data[0].project_role).toBe('global');
  });

  test('search --project-glob without --all-projects returns invalid args', async () => {
    const { exitCode, stdout } = await runCli(['search', '--project-glob', '*fake*', '--file', CROSS_PROJECT_FILE, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--project-glob requires --all-projects');
  });

  test('scoped --file omits old cross-project warning when matching results contain no writes', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', CROSS_PROJECT_FILE, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('scoped --file omits warning for empty results', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', 'cc-session-tool-no-such-scoped-file', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('scoped explicit --operation write omits warning for empty results', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', CROSS_PROJECT_FILE, '--operation', 'write', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('non-file search omits scoped file warning', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Bash', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('all-project file search omits scoped file warning', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('scoped --file includes related worktree project metadata', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', RELATED_PROJECT_FILE, '--project', RELATED_PROJECT, '--include-project-lists']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_7)).toBeDefined();
    expect(result._meta.projects_scanned).toBe(3);
    expect(result._meta.projects_skipped).toBe(0);
    expect(result._meta.skipped_projects).toEqual([]);
    expect(result._meta.included_projects).toEqual([
      {
        project: relatedDirName,
        project_path_guess: RELATED_PROJECT,
        project_role: 'main',
      },
      {
        project: relatedWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedWorktreeDirName),
        project_role: 'worktree',
      },
      {
        project: relatedSiblingWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedSiblingWorktreeDirName),
        project_role: 'worktree',
      },
    ]);
    expect(result._meta).not.toHaveProperty('related_projects');
    expect(result._meta).not.toHaveProperty('warning');
  });

  test('scoped absolute main-path file search finds equivalent worktree writer without --all-projects', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);

    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(writer).toBeDefined();
    expect(writer.matches.files).toEqual([join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE)]);
    expect(writer.matches.normalized_files).toEqual([RELATED_PROJECT_FILE]);
    expect(writer.matches.operations).toEqual(['write']);
    expect(writer.project).toBe(relatedWorktreeDirName);
    expect(writer.project_role).toBe('worktree');
    expect(writer.session_ref).toEqual({
      session_id: SESSION_ID_8,
      project: relatedWorktreeDirName,
    });
  });

  test('--all-projects with explicit --project anchor matches equivalent worktree writer', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(4);

    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(writer).toBeDefined();
    expect(writer.matches.files).toEqual([join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE)]);
    expect(writer.matches.normalized_files).toEqual([RELATED_PROJECT_FILE]);
    expect(writer.matches.operations).toEqual(['write']);
    expect(writer.project).toBe(relatedWorktreeDirName);
    expect(writer.project_role).toBe('global');
    expect(writer.session_ref).toEqual({
      session_id: SESSION_ID_8,
      project: relatedWorktreeDirName,
    });
  });

  test('--all-projects without explicit anchor does not infer main/worktree identity from cwd', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_8)).toBeUndefined();
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_10)).toBeUndefined();
  });

  test('scoped absolute main-path file search derives worktree root when transcript cwd is absent', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_MISSING_CWD_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);

    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_11);
    expect(writer).toBeDefined();
    expect(writer.matches.files).toEqual([join(RELATED_WORKTREE_ROOT, RELATED_MISSING_CWD_FILE)]);
    expect(writer.matches.normalized_files).toEqual([RELATED_MISSING_CWD_FILE]);
    expect(writer.project).toBe(relatedWorktreeDirName);
    expect(writer.project_role).toBe('worktree');
  });

  test('scoped --tool search includes associated worktree sessions by default', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Bash', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);

    const worktreeMatch = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(worktreeMatch).toBeDefined();
    expect(worktreeMatch.project).toBe(relatedWorktreeDirName);
    expect(worktreeMatch.project_role).toBe('worktree');
  });

  test('search includes subagent transcript text under parent session by default', async () => {
    const { exitCode, stdout } = await runCli(['search', '--text', 'Subagent response', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.session_ref).toEqual({
      session_id: SESSION_ID,
      project: fakeDirName,
    });
    expect(match.matches.evidence.find((e: any) => e.kind === 'text' && e.is_subagent)).toMatchObject({
      kind: 'text',
      agent_id: SUBAGENT_ID,
      parent_session_id: SESSION_ID,
      is_subagent: true,
      snippet: expect.stringContaining('Subagent response'),
    });
  });

  test('search --no-subagents excludes subagent transcript matches', async () => {
    const { exitCode, stdout } = await runCli(['search', '--text', 'Subagent response', '--no-subagents', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID)).toBeUndefined();
  });

  test('parent and subagent evidence can satisfy one grouped search match', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Grep', '--text', 'Subagent response', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.tools).toContain('Grep');
    expect(match.matches.evidence.find((e: any) => e.kind === 'tool_input' && e.tool === 'Grep')).toBeDefined();
    expect(match.matches.evidence.find((e: any) => e.kind === 'text' && e.is_subagent)).toBeDefined();
  });

  test('malformed file tool input does not suppress unrelated tool search matches', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Bash', '--input-match', 'malformed-file-input-survives', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);

    const malformedInputMatch = result.data.find((s: any) => s.session_id === SESSION_ID_12);
    expect(malformedInputMatch).toBeDefined();
    expect(malformedInputMatch.project).toBe(relatedWorktreeDirName);
    expect(malformedInputMatch.project_role).toBe('worktree');
  });

  test('logical file operation binding rejects writes to same basename at a different logical path', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_8)).toBeDefined();
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_9)).toBeUndefined();
  });

  test('file search includes per-access evidence for matching file accesses', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);

    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(writer.matches).not.toHaveProperty('file_evidence');
    expect(writer.matches.evidence.filter((e: any) => e.kind === 'file')).toEqual([{
      kind: 'file',
      rawPath: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE),
      logicalPath: RELATED_PROJECT_FILE,
      operation: 'write',
      turn: 2,
      block_index: 0,
      timestamp: '2026-03-08T10:01:00.000Z',
    }]);
  });

  test('--origin implies write matching and returns the earliest matching write evidence by default', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--origin', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_10]);
    expect(result._meta.total).toBeGreaterThan(1);
    expect(result._meta.returned).toBe(1);
    expect(result._meta.hasMore).toBe(true);
    expect(result.data[0].matches.operations).toEqual(['write']);
    expect(result.data[0].matches.evidence.find((e: any) => e.kind === 'file')).toMatchObject({
      rawPath: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE),
      logicalPath: RELATED_PROJECT_FILE,
      operation: 'write',
      timestamp: '2026-03-06T09:01:00.000Z',
    });
  });

  test('--origin honors --last after earliest-write ordering', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--origin', '--last', '2', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_10, SESSION_ID_8]);
    expect(result._meta.returned).toBe(2);
  });

  test('--origin still applies additional candidate filters before earliest-write ordering', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--origin', '--text', 'no matching response phrase', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
  });

  test('--sort match-earliest and match-newest order by matching file evidence', async () => {
    const earliest = parseOutput((await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--sort', 'match-earliest', '--project', RELATED_PROJECT])).stdout);
    expect(earliest.ok).toBe(true);
    expect(earliest.data.map((s: any) => s.session_id).slice(0, 2)).toEqual([SESSION_ID_10, SESSION_ID_8]);

    const newest = parseOutput((await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--sort', 'match-newest', '--project', RELATED_PROJECT])).stdout);
    expect(newest.ok).toBe(true);
    expect(newest.data.map((s: any) => s.session_id).slice(0, 2)).toEqual([SESSION_ID_8, SESSION_ID_10]);
  });

  test('--sort project orders merged all-project results by raw project identity', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--file', CROSS_PROJECT_FILE, '--sort', 'project']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id).slice(0, 2)).toEqual([SESSION_ID_4, SESSION_ID_6]);
  });

  test('--origin rejects invalid combinations', async () => {
    const invalidOperation = parseOutput((await runCli(['search', '--file', RELATED_PROJECT_FILE, '--origin', '--operation', 'read', '--project', RELATED_PROJECT])).stdout);
    expect(invalidOperation.ok).toBe(false);
    expect(invalidOperation.error.code).toBe('INVALID_ARGS');
    expect(invalidOperation.error.message).toContain('--origin implies --operation write');

    const invalidSort = parseOutput((await runCli(['search', '--file', RELATED_PROJECT_FILE, '--origin', '--sort', 'match-newest', '--project', RELATED_PROJECT])).stdout);
    expect(invalidSort.ok).toBe(false);
    expect(invalidSort.error.code).toBe('INVALID_ARGS');
    expect(invalidSort.error.message).toContain('--origin uses --sort match-earliest');
  });

  test('--operation without --file returns INVALID_ARGS', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Grep', '--operation', 'write', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  test('invalid --operation value returns INVALID_ARGS', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', 'hello.ts', '--operation', 'delete', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  test('--text "different approach" finds session (matches assistant text block)', async () => {
    const { stdout } = await runCli(['search', '--text', 'different approach', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
    expect(match.matches.evidence.find((e: any) => e.kind === 'text')).toMatchObject({
      kind: 'text',
      role: 'assistant',
      turn: 6,
      snippet: expect.stringContaining('different approach'),
    });
    expect(match.session_ref).toEqual({
      session_id: SESSION_ID,
      project: fakeDirName,
    });
    expect(match.model).toBe('claude-sonnet-4-5');
  });

  test('--text "think about this carefully" finds session (matches thinking block)', async () => {
    const { stdout } = await runCli(['search', '--text', 'think about this carefully', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
  });

  test('--text searches string user content and array user text blocks by default', async () => {
    const stringUser = parseOutput((await runCli(['search', '--text', 'please help me', '--project', FAKE_PROJECT])).stdout);
    expect(stringUser.ok).toBe(true);
    const stringMatch = stringUser.data.find((s: any) => s.session_id === SESSION_ID);
    expect(stringMatch).toBeDefined();
    expect(stringMatch.matches.evidence.find((e: any) => e.kind === 'text' && e.role === 'user')).toMatchObject({
      kind: 'text',
      role: 'user',
      turn: 1,
      snippet: expect.stringContaining('please help me'),
    });

    const arrayUser = parseOutput((await runCli(['search', '--text', 'array content marker', '--text-role', 'user', '--project', FAKE_PROJECT])).stdout);
    expect(arrayUser.ok).toBe(true);
    const arrayMatch = arrayUser.data.find((s: any) => s.session_id === SESSION_ID_2);
    expect(arrayMatch).toBeDefined();
    expect(arrayMatch.matches.evidence.find((e: any) => e.kind === 'text' && e.role === 'user')).toMatchObject({
      kind: 'text',
      role: 'user',
      turn: 1,
      block_index: 0,
    });
  });

  test('--text-regex matches text and invalid text regex returns INVALID_ARGS', async () => {
    const { exitCode, stdout } = await runCli(['search', '--text-regex', 'different\\s+approach', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID);

    const invalid = parseOutput((await runCli(['search', '--text-regex', '[', '--project', FAKE_PROJECT])).stdout);
    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe('INVALID_ARGS');
    expect(invalid.error.message).toContain('Invalid --text-regex regex');
  });

  test('--intent-match /plan emits intent evidence', async () => {
    const { exitCode, stdout } = await runCli(['search', '--intent-match', '/plan', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_3);
    expect(match).toBeDefined();
    expect(match.matches.evidence.find((e: any) => e.kind === 'intent')).toMatchObject({
      kind: 'intent',
      intent_source: 'first_message',
      snippet: expect.stringContaining('/plan'),
    });
  });

  test('--bash "npm install" finds Bash fixture session', async () => {
    const { stdout } = await runCli(['search', '--bash', 'npm install', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
    expect(match.matches.evidence.find((e: any) => e.kind === 'bash')).toMatchObject({
      kind: 'bash',
      tool: 'Bash',
      snippet: expect.stringContaining('npm install'),
    });
  });

  test('--bash-regex and --input-regex match raw structured values', async () => {
    const bash = parseOutput((await runCli(['search', '--bash-regex', 'npm\\s+install', '--project', FAKE_PROJECT])).stdout);
    expect(bash.ok).toBe(true);
    expect(bash.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);

    const input = parseOutput((await runCli(['search', '--tool', 'Write', '--input-regex', 'raw write content marker', '--project', FAKE_PROJECT])).stdout);
    expect(input.ok).toBe(true);
    expect(input.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
  });

  test('--input-match searches raw Bash commands beyond input summary truncation', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Bash', '--input-match', 'raw-bash-marker-in-elided-middle', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(match.matches.tools).toEqual(['Bash']);
    expect(match.matches).not.toHaveProperty('tool_inputs');
    const bashSummary: string = match.matches.evidence.find((e: any) => e.kind === 'tool_input').input_summary;
    expect(bashSummary).toContain(`...[truncated, ${BASH_MARKER_COMMAND.length} chars]...`);
    expect(bashSummary.endsWith(BASH_MARKER_COMMAND.slice(-40))).toBe(true);
    expect(match.matches.evidence.filter((e: any) => e.kind === 'tool_input')).toMatchObject([{
      kind: 'tool_input',
      tool: 'Bash',
      input_summary: expect.not.stringContaining('raw-bash-marker-in-elided-middle'),
      snippet: expect.stringContaining('raw-bash-marker-in-elided-middle'),
      turn: 2,
      block_index: 0,
      timestamp: '2026-03-04T10:01:00.000Z',
    }]);
  });

  test('--input-match searches raw file paths and content fields', async () => {
    const editResult = parseOutput((await runCli(['search', '--tool', 'Edit', '--input-match', 'legacy raw old marker', '--project', FAKE_PROJECT])).stdout);
    expect(editResult.ok).toBe(true);
    expect(editResult.data.map((s: any) => s.session_id)).toContain(SESSION_ID);
    expect(editResult.data.find((s: any) => s.session_id === SESSION_ID).matches.evidence.find((e: any) => e.kind === 'tool_input')).toMatchObject({
      kind: 'tool_input',
      tool: 'Edit',
      input_summary: "file='hello.ts' old=(21 chars) new=(26 chars)",
      turn: 4,
    });

    const writeResult = parseOutput((await runCli(['search', '--tool', 'Write', '--input-match', 'raw write content marker', '--project', FAKE_PROJECT])).stdout);
    expect(writeResult.ok).toBe(true);
    expect(writeResult.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
  });

  test('--input-match uses stable JSON serialization for other tool inputs', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'TodoWrite', '--input-match', '"content":"stable json audit marker"', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_2]);
    expect(result.data[0].matches.evidence.filter((e: any) => e.kind === 'tool_input')).toMatchObject([{
      kind: 'tool_input',
      tool: 'TodoWrite',
      input_summary: expect.stringContaining('stable json audit marker'),
      snippet: expect.stringContaining('stable json audit marker'),
      turn: 2,
      block_index: 0,
      timestamp: '2026-03-02T10:01:00.000Z',
    }]);
  });

  test('--input-match composes with branch and time filters', async () => {
    const matching = parseOutput((await runCli(['search', '--input-match', 'raw write content marker', '--branch', 'main', '--after', '2026-03-04T00:00:00.000Z', '--project', FAKE_PROJECT])).stdout);
    expect(matching.ok).toBe(true);
    expect(matching.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);

    const excluded = parseOutput((await runCli(['search', '--input-match', 'raw write content marker', '--branch', 'feature', '--project', FAKE_PROJECT])).stdout);
    expect(excluded.ok).toBe(true);
    expect(excluded.data).toEqual([]);
  });

  test('scoped --input-match includes associated worktree sessions by default', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Write', '--input-match', 'earlierOrigin', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const worktreeMatch = result.data.find((s: any) => s.session_id === SESSION_ID_10);
    expect(worktreeMatch).toBeDefined();
    expect(worktreeMatch.project).toBe(relatedWorktreeDirName);
    expect(worktreeMatch.project_role).toBe('worktree');
  });

  test('--all-projects --project-glob supports input-match audits', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--project-glob', '*fake-project-worktree', '--tool', 'Write', '--input-match', 'cross audit content marker']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_6]);
    expect(result.data[0].project).toBe(secondFakeDirName);
  });

  test('--aggregate count-per-session returns counts and sample matches', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Read', '--aggregate', 'count-per-session', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(aggregate).toEqual({
      session_id: SESSION_ID_4,
      branch: 'main',
      timestamp: '2026-03-04T10:00:00.000Z',
      slug: 'bash-test-session',
      counts: { tool_inputs: 2 },
      sample_matches: [
        { tool: 'Read', input_summary: "file='hello.ts'", turn: 2 },
        { tool: 'Read', input_summary: "file='cross-project-fixture-target.ts'", turn: 2 },
      ],
    });
  });

  test('--aggregate count-per-session composes with input-match', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Write', '--input-match', 'raw write content marker', '--aggregate', 'count-per-session', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
    const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(aggregate.counts.tool_inputs).toBe(1);
    expect(aggregate.sample_matches).toEqual([
      { tool: 'Write', input_summary: "file='other.ts' (54 chars)", turn: 2 },
    ]);
  });

  test('--aggregate count-per-session counts --bash and --bash-regex matches', async () => {
    for (const selector of [['--bash', 'npm install'], ['--bash-regex', 'npm\\s+install']]) {
      const result = parseOutput((await runCli(['search', ...selector, '--aggregate', 'count-per-session', '--project', FAKE_PROJECT])).stdout);
      expect(result.ok).toBe(true);
      const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
      expect(aggregate.counts.tool_inputs).toBe(1);
      expect(aggregate.sample_matches).toEqual([
        { tool: 'Bash', input_summary: expect.stringContaining('npm install express'), turn: 2 },
      ]);
    }
  });

  test('--aggregate count-per-session counts only calls matching both --tool and --bash', async () => {
    const count = async (...selectors: string[]) => {
      const result = parseOutput((await runCli(['search', ...selectors, '--aggregate', 'count-per-session', '--project', FAKE_PROJECT])).stdout);
      expect(result.ok).toBe(true);
      return result.data.find((s: any) => s.session_id === SESSION_ID_4).counts.tool_inputs;
    };
    expect(await count('--tool', 'Bash')).toBe(2);
    expect(await count('--tool', 'Bash', '--bash', 'npm install')).toBe(1);
  });

  test('--aggregate counters uses counters as selector and returns nonzero rows', async () => {
    const { exitCode, stdout } = await runCli(['search', '--counter', 'tracking=.claude-tracking', '--aggregate', 'counters', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
    const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(aggregate).toMatchObject({
      session_id: SESSION_ID_4,
      project: basename(CLAUDE_DIR),
      project_path_guess: null,
      project_role: 'main',
      session_ref: { session_id: SESSION_ID_4, project: basename(CLAUDE_DIR) },
      counts: { tracking: 1 },
      total_matches: 1,
    });
    expect(result.data.every((row: any) => row.total_matches > 0)).toBe(true);
  });

  test('--aggregate counters preserves selected zero-count rows and supports bucket day', async () => {
    const { exitCode, stdout } = await runCli([
      'search',
      '--tool', 'Read',
      '--counter', 'missing=no-such-counter-marker',
      '--aggregate', 'counters',
      '--bucket', 'day',
      '--project', FAKE_PROJECT,
    ]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const day = result.data.find((bucket: any) => bucket.bucket === '2026-03-04');
    expect(day).toEqual({
      bucket: '2026-03-04',
      sessions: 1,
      counts: { missing: 0 },
      total_matches: 0,
    });
  });

  test('--aggregate counters supports regex counters, week buckets, and all-project audit shape', async () => {
    const { exitCode, stdout } = await runCli([
      'search',
      '--all-projects',
      '--project-glob', '*fake-project-worktree',
      '--tool', 'Write',
      '--input-match', 'cross audit content marker',
      '--counter', 'cross=cross audit',
      '--counter-regex', 'write_file="file_path":".*cross-project',
      '--aggregate', 'counters',
      '--bucket', 'week',
    ]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
    expect(result.data).toEqual([
      {
        bucket: '2026-03-02',
        sessions: 1,
        counts: { cross: 1, write_file: 1 },
        total_matches: 2,
      },
    ]);
  });

  test('--aggregate counters can roll up subagent Bash evidence selected by parent /plan intent', async () => {
    const { exitCode, stdout } = await runCli([
      'search',
      '--intent-match', '/plan',
      '--counter', 'tracking=.claude-tracking',
      '--aggregate', 'counters',
      '--project', FAKE_PROJECT,
    ]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(aggregate).toMatchObject({
      session_id: SESSION_ID_4,
      counts: { tracking: 1 },
      total_matches: 1,
      session_ref: { session_id: SESSION_ID_4, project: basename(CLAUDE_DIR) },
    });
  });

  test('--aggregate counters --per-subagent emits transcript-level rows', async () => {
    const { exitCode, stdout } = await runCli([
      'search',
      '--intent-match', '/plan',
      '--counter', 'tracking=.claude-tracking',
      '--aggregate', 'counters',
      '--per-subagent',
      '--project', FAKE_PROJECT,
    ]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const rows = result.data.filter((s: any) => s.session_id === SESSION_ID_4);
    const subagentRow = rows.find((s: any) => s.agent_id === 'counter_agent');
    expect(rows.some((s: any) => s.agent_id === undefined && s.total_matches === 0)).toBe(true);
    expect(subagentRow).toMatchObject({
      session_id: SESSION_ID_4,
      agent_id: 'counter_agent',
      parent_session_id: SESSION_ID_4,
      is_subagent: true,
      session_ref: { session_id: SESSION_ID_4, project: basename(CLAUDE_DIR), agent_id: 'counter_agent' },
      counts: { tracking: 1 },
      total_matches: 1,
    });
  });

  test('--aggregate rejects invalid usage', async () => {
    const withoutToolInput = parseOutput((await runCli(['search', '--file', 'hello.ts', '--aggregate', 'count-per-session', '--project', FAKE_PROJECT])).stdout);
    expect(withoutToolInput.ok).toBe(false);
    expect(withoutToolInput.error.code).toBe('INVALID_ARGS');
    expect(withoutToolInput.error.message).toContain('--aggregate requires --tool, --input-match, --input-regex, --bash, --bash-regex, --output-match, --output-regex, or --failed');

    const invalidMode = parseOutput((await runCli(['search', '--tool', 'Read', '--aggregate', 'totals', '--project', FAKE_PROJECT])).stdout);
    expect(invalidMode.ok).toBe(false);
    expect(invalidMode.error.code).toBe('INVALID_ARGS');
    expect(invalidMode.error.message).toContain('--aggregate must be one of: count-per-session, counters');

    const countersWithoutAggregate = parseOutput((await runCli(['search', '--counter', 'x=y', '--project', FAKE_PROJECT])).stdout);
    expect(countersWithoutAggregate.ok).toBe(false);
    expect(countersWithoutAggregate.error.code).toBe('INVALID_ARGS');
    expect(countersWithoutAggregate.error.message).toContain('--counter and --counter-regex require --aggregate counters');

    const countersWithoutCounter = parseOutput((await runCli(['search', '--tool', 'Read', '--aggregate', 'counters', '--project', FAKE_PROJECT])).stdout);
    expect(countersWithoutCounter.ok).toBe(false);
    expect(countersWithoutCounter.error.code).toBe('INVALID_ARGS');
    expect(countersWithoutCounter.error.message).toContain('--aggregate counters requires at least one --counter or --counter-regex');

    const bucketWithoutCounters = parseOutput((await runCli(['search', '--tool', 'Read', '--aggregate', 'count-per-session', '--bucket', 'day', '--project', FAKE_PROJECT])).stdout);
    expect(bucketWithoutCounters.ok).toBe(false);
    expect(bucketWithoutCounters.error.code).toBe('INVALID_ARGS');
    expect(bucketWithoutCounters.error.message).toContain('--bucket requires --aggregate counters');
  });

  test('--tool Grep --branch main combines content + metadata filters', async () => {
    const { stdout } = await runCli(['search', '--tool', 'Grep', '--branch', 'main', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.branch).toBe('main');
  });

  test('--tool Grep --branch feature returns no results (Grep only in main branch)', async () => {
    const { stdout } = await runCli(['search', '--tool', 'Grep', '--branch', 'feature', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('--tool Grep --file hello.ts both match same session (multi-content AND)', async () => {
    const { stdout } = await runCli(['search', '--tool', 'Grep', '--file', 'hello.ts', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.tools).toContain('Grep');
    expect(match.matches.files.some((f: string) => f.includes('hello.ts'))).toBe(true);
  });

  test('--tool Grep --text "nonexistent" returns no results (AND semantics)', async () => {
    const { stdout } = await runCli(['search', '--tool', 'Grep', '--text', 'nonexistent', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('no search filters returns INVALID_ARGS error', async () => {
    const { exitCode, stdout } = await runCli(['search', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  test('non-existent project returns NOT_FOUND error', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Grep', '--project', '/tmp/nonexistent-project-12345']);
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  test('no matches returns empty data array with ok true', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'NonExistentTool', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('--last 1 limits results and _meta reflects total', async () => {
    // --text "e" is broad enough to match multiple sessions (session 1 has "different approach",
    // session 2 has "Response from second session", session 3 has "Here is my answer.")
    const { exitCode, stdout } = await runCli(['search', '--text', 'e', '--project', FAKE_PROJECT, '--last', '1']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result._meta.total).toBeGreaterThan(result._meta.returned);
    expect(result._meta.returned).toBe(1);
    expect(result._meta.hasMore).toBe(true);
  });
});

// ============================================================================
// listSubagents unit tests
// ============================================================================

describe('search tool output integration', () => {
  const OUTPUT_FIXTURE_ROOT = join(tmpdir(), uniqueTempName('cc-session-output-fixture'));
  const OUTPUT_FIXTURE_HOME = join(OUTPUT_FIXTURE_ROOT, 'home');
  const OUTPUT_PROJECT = join(OUTPUT_FIXTURE_ROOT, 'output-project');
  const OUTPUT_CLAUDE_DIR = join(claudeProjectsRoot(OUTPUT_FIXTURE_HOME), mangleProjectPath(OUTPUT_PROJECT));
  const OUT_A = 'a0a0a0a0-0000-4000-8000-00000000000a';
  const OUT_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
  const OUT_C = 'c0c0c0c0-0000-4000-8000-00000000000c';
  const OUT_D = 'd0d0d0d0-0000-4000-8000-00000000000d';
  const run = (args: string[]) => runCli(['search', ...args, '--project', OUTPUT_PROJECT], { HOME: OUTPUT_FIXTURE_HOME });
  const search = async (args: string[]) => parseOutput((await run(args)).stdout);
  const ids = (result: any): string[] => result.data.map((s: any) => s.session_id);
  const evidenceOf = (result: any, sessionId: string): any[] => result.data.find((s: any) => s.session_id === sessionId)?.matches.evidence ?? [];
  const f = (name: string) => join(OUTPUT_PROJECT, 'src', name);
  const minute = (n: number) => `2026-04-01T10:0${n}:00.000Z`;
  const user = (turn: number, content: unknown) => JSON.stringify({
    type: 'user', sessionId: OUT_A, timestamp: minute(turn - 1), cwd: OUTPUT_PROJECT, gitBranch: 'main', message: { role: 'user', content },
  });
  const assistant = (turn: number, content: unknown[]) => JSON.stringify({
    type: 'assistant', timestamp: minute(turn - 1), cwd: OUTPUT_PROJECT, message: { role: 'assistant', content },
  });
  const use = (name: string, id: string, input: Record<string, unknown>) => ({ type: 'tool_use', name, id, input });
  const result = (id: string, content: unknown, is_error?: boolean) => ({
    type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}),
  });

  beforeAll(() => {
    mkdirSync(OUTPUT_CLAUDE_DIR, { recursive: true });
    writeFileSync(join(OUTPUT_CLAUDE_DIR, `${OUT_A}.jsonl`), [
      user(1, 'Install deps and fix tests'),
      assistant(2, [use('Bash', 'bash_a', { command: 'npm install' }), use('Bash', 'bash_b', { command: 'npm test' })]),
      user(3, [result('bash_a', 'ok added 3 packages SHARED_NEEDLE'), result('bash_b', 'FAIL x expected 1', true)]),
      assistant(4, [
        use('Read', 'read_x', { file_path: f('x.ts') }),
        use('Edit', 'edit_y', { file_path: f('y.ts'), old_string: 'a', new_string: 'b' }),
        use('Read', 'read_z', { file_path: f('z.ts') }),
        use('Write', 'write_w1', { file_path: f('w.ts'), content: 'one' }),
      ]),
      user(5, [
        result('read_x', 'x contents'),
        result('edit_y', 'old_string not found', true),
        result('write_w1', 'File created successfully'),
      ]),
      assistant(6, [{ type: 'text', text: 'retrying the install' }]),
      assistant(7, [use('Write', 'write_w2', { file_path: f('w.ts'), content: 'two' })]),
      user(8, [result('write_w2', 'File has not been read yet', true)]),
    ].join('\n') + '\n');

    const subDir = join(OUTPUT_CLAUDE_DIR, OUT_A, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-out_sub.jsonl'), [
      JSON.stringify({ type: 'user', sessionId: OUT_A, timestamp: '2026-04-01T10:10:00.000Z', cwd: OUTPUT_PROJECT, message: { role: 'user', content: 'Build it' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:11:00.000Z', cwd: OUTPUT_PROJECT, message: { role: 'assistant', content: [use('Bash', 'sub_bash', { command: 'swift build' })] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:11:05.000Z', cwd: OUTPUT_PROJECT, message: { role: 'user', content: [result('sub_bash', 'error: build failed SUBAGENT_MARKER', true)] } }),
    ].join('\n') + '\n');
    writeFileSync(join(subDir, 'agent-out_sub.meta.json'), JSON.stringify({ agentType: 'builder', description: 'Build subagent' }));

    writeFileSync(join(OUTPUT_CLAUDE_DIR, `${OUT_B}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: OUT_B, timestamp: '2026-03-31T08:00:00.000Z', cwd: OUTPUT_PROJECT, gitBranch: 'main', message: { role: 'user', content: 'Late session' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-03T09:00:00.000Z', cwd: OUTPUT_PROJECT, message: { role: 'assistant', content: [use('Bash', 'late_bash', { command: 'echo late' })] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-03T09:00:05.000Z', cwd: OUTPUT_PROJECT, message: { role: 'user', content: [result('late_bash', 'SHARED_NEEDLE seen late')] } }),
    ].join('\n') + '\n');

    writeFileSync(join(OUTPUT_CLAUDE_DIR, `${OUT_C}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: OUT_C, timestamp: '2026-04-02T12:00:00.000Z', cwd: OUTPUT_PROJECT, gitBranch: 'main', message: { role: 'user', content: 'Find docs' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-02T12:01:00.000Z', cwd: OUTPUT_PROJECT, message: { role: 'assistant', content: [use('Glob', 'glob_hit', { pattern: '**/*.md' }), use('Glob', 'glob_empty', { pattern: '**/*.rst' })] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-02T12:01:05.000Z', cwd: OUTPUT_PROJECT, message: { role: 'user', content: [result('glob_hit', 'README.md'), result('glob_empty', '')] } }),
    ].join('\n') + '\n');

    // Null content blocks in both roles: scoped search builds a worktree context over every block.
    writeFileSync(join(OUTPUT_CLAUDE_DIR, `${OUT_D}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: OUT_D, timestamp: '2026-04-02T14:00:00.000Z', cwd: OUTPUT_PROJECT, gitBranch: 'main', message: { role: 'user', content: [null, { type: 'text', text: 'Check nulls' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-02T14:01:00.000Z', cwd: OUTPUT_PROJECT, message: { role: 'assistant', content: [null, { type: 'text', text: 'nullblock prose' }, use('Bash', 'null_bash', { command: 'make nulls' })] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-02T14:01:05.000Z', cwd: OUTPUT_PROJECT, message: { role: 'user', content: [result('null_bash', 'NULLBLOCK_ERR exit 2', true)] } }),
    ].join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(OUTPUT_FIXTURE_ROOT, { recursive: true, force: true });
  });

  describe('binding', () => {
    // Each half matches OUT_A on its own, on different calls; only the bound combination must miss it.
    const expectBoundMiss = async (callSelector: string[], resultSelector: string[]) => {
      expect(ids(await search(callSelector))).toContain(OUT_A);
      expect(ids(await search(resultSelector))).toContain(OUT_A);
      const bound = await search([...callSelector, ...resultSelector]);
      expect(bound.ok).toBe(true);
      expect(ids(bound)).not.toContain(OUT_A);
    };

    test('--bash with --output-match binds to the same call', async () => {
      await expectBoundMiss(['--bash', 'npm install'], ['--output-match', 'FAIL']);
    });

    test('--input-match with --failed binds to the same call', async () => {
      await expectBoundMiss(['--input-match', 'npm install'], ['--failed']);
    });

    test('--file with --failed binds to the same call', async () => {
      await expectBoundMiss(['--file', 'src/x.ts'], ['--failed']);
    });

    test('--tool Read --failed does not match a successful read or a read with no result', async () => {
      await expectBoundMiss(['--tool', 'Read'], ['--failed']);
    });

    test('--file src/y.ts --failed matches with exactly file + tool_output evidence for the failed edit', async () => {
      const r = await search(['--file', 'src/y.ts', '--failed']);
      expect(ids(r)).toContain(OUT_A);
      const evidence = evidenceOf(r, OUT_A);
      expect(evidence.map(e => e.kind).sort()).toEqual(['file', 'tool_output']);
      expect(evidence.find(e => e.kind === 'tool_output')).toMatchObject({ tool_use_id: 'edit_y', tool: 'Edit', is_error: true });
      expect(evidence.find(e => e.kind === 'file')).toMatchObject({ operation: 'edit', turn: 4, block_index: 1 });
    });

    test('positive control: --tool Bash --input-match "npm test" --failed matches', async () => {
      expect(ids(await search(['--tool', 'Bash', '--input-match', 'npm test', '--failed']))).toContain(OUT_A);
    });

    test('evidence lists only the bound call', async () => {
      const r = await search(['--tool', 'Bash', '--output-match', 'FAIL x']);
      const evidence = evidenceOf(r, OUT_A);
      expect(evidence.map(e => e.kind).sort()).toEqual(['tool_input', 'tool_output']);
      for (const item of evidence) {
        expect(item).toMatchObject({ turn: 2, block_index: 1, timestamp: minute(1) });
      }
      expect(evidence.find(e => e.kind === 'tool_output')).toMatchObject({
        tool_use_id: 'bash_b',
        result_turn: 3,
        result_timestamp: minute(2),
        is_error: true,
        snippet: 'FAIL x expected 1',
      });
      expect(r.data.find((s: any) => s.session_id === OUT_A).matches.turns).toEqual([2]);
    });

    test('parallel results are distinguished by tool_use_id', async () => {
      const r = await search(['--output-match', 'added 3 packages']);
      const outputs = evidenceOf(r, OUT_A).filter(e => e.kind === 'tool_output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({ tool_use_id: 'bash_a', block_index: 0, result_turn: 3 });
    });

    test('null content blocks do not drop a session from scoped search', async () => {
      const r = await search(['--output-match', 'NULLBLOCK_ERR']);
      expect(r.ok).toBe(true);
      expect(ids(r)).toEqual([OUT_D]);
      expect(evidenceOf(r, OUT_D).find(e => e.kind === 'tool_output')).toMatchObject({ tool_use_id: 'null_bash', block_index: 2, is_error: true });
      expect(ids(await search(['--text', 'nullblock prose', '--failed']))).toEqual([OUT_D]);
    });

    test('--text and --failed stay session-level', async () => {
      expect(ids(await search(['--text', 'retrying the install', '--failed']))).toContain(OUT_A);
    });
  });

  describe('matching', () => {
    test('--output-regex is validated and case-sensitive; --output-match is case-insensitive', async () => {
      expect(ids(await search(['--output-regex', 'added \\d+ packages']))).toContain(OUT_A);
      expect(ids(await search(['--output-regex', 'expected \\d']))).toContain(OUT_A);
      expect(ids(await search(['--output-regex', 'EXPECTED']))).not.toContain(OUT_A);
      expect(ids(await search(['--output-match', 'EXPECTED']))).toContain(OUT_A);
    });

    test('--failed matches a non-error empty result and omits the empty snippet', async () => {
      const r = await search(['--tool', 'Glob', '--failed']);
      expect(ids(r)).toEqual([OUT_C]);
      const outputs = evidenceOf(r, OUT_C).filter(e => e.kind === 'tool_output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({ tool_use_id: 'glob_empty', tool: 'Glob', is_error: false, result_turn: 3 });
      expect(outputs[0]).not.toHaveProperty('snippet');
    });

    test('--failed snippet is the leading output text', async () => {
      const r = await search(['--failed', '--tool', 'Edit']);
      const output = evidenceOf(r, OUT_A).find(e => e.kind === 'tool_output');
      expect(output.snippet).toBe('old_string not found');
    });
  });

  describe('--origin', () => {
    test('--file --origin keeps all write evidence and sorts by the earliest', async () => {
      const r = await search(['--file', 'src/w.ts', '--origin']);
      expect(ids(r)).toEqual([OUT_A]);
      const turns = evidenceOf(r, OUT_A).filter(e => e.kind === 'file').map(e => e.turn).sort();
      expect(turns).toEqual([4, 7]);
    });

    test('--file --origin --failed keeps only the failed write call', async () => {
      const r = await search(['--file', 'src/w.ts', '--origin', '--failed']);
      expect(ids(r)).toEqual([OUT_A]);
      const evidence = evidenceOf(r, OUT_A);
      expect(evidence.map(e => e.kind).sort()).toEqual(['file', 'tool_output']);
      expect(evidence.every(e => e.turn === 7)).toBe(true);
      expect(evidence.find(e => e.kind === 'tool_output').tool_use_id).toBe('write_w2');
    });
  });

  describe('subagents', () => {
    test('--output-match finds subagent tool output with provenance', async () => {
      const r = await search(['--output-match', 'SUBAGENT_MARKER']);
      expect(ids(r)).toEqual([OUT_A]);
      const output = evidenceOf(r, OUT_A).find(e => e.kind === 'tool_output');
      expect(output).toMatchObject({ agent_id: 'out_sub', is_subagent: true, parent_session_id: OUT_A, tool_use_id: 'sub_bash' });
    });

    test('--no-subagents excludes subagent output', async () => {
      expect((await search(['--output-match', 'SUBAGENT_MARKER', '--no-subagents'])).data).toEqual([]);
    });
  });

  describe('count-per-session', () => {
    test('counts matched calls under result selectors', async () => {
      const r = await search(['--tool', 'Bash', '--failed', '--aggregate', 'count-per-session']);
      expect(r.ok).toBe(true);
      const row = r.data.find((s: any) => s.session_id === OUT_A);
      expect(row.counts.tool_inputs).toBe(2);
      expect(row.sample_matches.map((m: any) => m.tool)).toEqual(['Bash', 'Bash']);
      expect(r.data.find((s: any) => s.session_id === OUT_B)).toBeUndefined();
    });

    test('--failed alone is an accepted selector', async () => {
      const r = await search(['--failed', '--aggregate', 'count-per-session']);
      expect(r.ok).toBe(true);
      expect(r.data.find((s: any) => s.session_id === OUT_A).counts.tool_inputs).toBe(4);
    });
  });

  describe('validation', () => {
    test('--output-match and --output-regex are mutually exclusive', async () => {
      const r = await search(['--output-match', 'x', '--output-regex', 'y']);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.message).toContain('--output-match and --output-regex are mutually exclusive');
    });

    test('invalid --output-regex is rejected', async () => {
      const r = await search(['--output-regex', '(']);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.message).toContain('Invalid --output-regex regex');
    });

    test.each(['--output-match', '--output-regex'])('empty %s is rejected instead of turning bound mode off', async flag => {
      const r = await search([flag, '']);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.message).toBe(`flag ${flag} for command search requires a non-empty value`);
    });
  });

  describe('match-* sort', () => {
    test('--sort match-earliest orders by the time of the matching call, not the session start', async () => {
      expect(ids(await search(['--output-match', 'SHARED_NEEDLE', '--sort', 'match-earliest']))).toEqual([OUT_A, OUT_B]);
    });

    test('--sort match-newest orders by the time of the matching call, not the session start', async () => {
      expect(ids(await search(['--output-match', 'SHARED_NEEDLE', '--sort', 'match-newest']))).toEqual([OUT_B, OUT_A]);
    });
  });

  describe('never-matching bound combinations', () => {
    const rejected: Array<[string, string[], string]> = [
      ['--bash with --file', ['--bash', 'npm', '--file', 'x', '--failed'], '--bash and --file can never match the same tool call'],
      ['--bash with a non-Bash --tool', ['--bash', 'npm', '--tool', 'Read', '--failed'], '--tool Read can never name a Bash call'],
      ['--file with a non-file --tool', ['--file', 'x', '--tool', 'Bash', '--failed'], '--tool Bash can never name a file tool'],
      ['--operation contradicting --tool', ['--file', 'x', '--operation', 'edit', '--tool', 'Write', '--failed'], '--tool Write contradicts --operation edit'],
      ['--origin (implies write) contradicting --tool', ['--file', 'x', '--origin', '--tool', 'Read', '--failed'], '--tool Read contradicts --origin (implies --operation write)'],
      ['--output-regex with --bash-regex and --file', ['--bash-regex', 'npm', '--file', 'x', '--output-regex', 'y'], '--bash and --file can never match the same tool call'],
    ];
    for (const [name, args, message] of rejected) {
      test(`rejects ${name}`, async () => {
        const r = await search(args);
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe('INVALID_ARGS');
        expect(r.error.message).toContain(message);
      });
    }

    test('rejects --aggregate counters with result selectors', async () => {
      const r = await search(['--failed', '--aggregate', 'counters', '--counter', 'a=b']);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.message).toContain('--aggregate counters does not support --output-match, --output-regex, or --failed');
    });

    test('still accepts compatible bound combinations', async () => {
      for (const args of [
        ['--bash', 'npm', '--tool', 'Bash', '--failed'],
        ['--file', 'x', '--tool', 'Edit', '--failed'],
        ['--file', 'x', '--tool', 'Write', '--operation', 'write', '--failed'],
        ['--file', 'x', '--origin', '--tool', 'Write', '--failed'],
      ]) {
        const r = await search(args);
        expect(r.ok).toBe(true);
      }
    });

    test('session-level --tool Bash --file without result selectors is still accepted', async () => {
      const r = await search(['--tool', 'Bash', '--file', 'x']);
      expect(r.ok).toBe(true);
    });
  });
});

describe('search tool output on shared fixture (read-only)', () => {
  test('--output-match finds tool output that --text cannot see', async () => {
    const output = parseOutput((await runCli(['search', '--output-match', 'old_string not found', '--project', FAKE_PROJECT])).stdout);
    expect(output.data.map((s: any) => s.session_id)).toContain(SESSION_ID);
    const text = parseOutput((await runCli(['search', '--text', 'old_string not found', '--project', FAKE_PROJECT])).stdout);
    expect(text.data.map((s: any) => s.session_id)).not.toContain(SESSION_ID);
  });

  test('at-least-one-filter message lists the result selectors and --failed alone satisfies it', async () => {
    const none = parseOutput((await runCli(['search', '--project', FAKE_PROJECT])).stdout);
    expect(none.ok).toBe(false);
    expect(none.error.code).toBe('INVALID_ARGS');
    expect(none.error.message).toContain('--output-match, --output-regex, --failed');

    const failed = parseOutput((await runCli(['search', '--failed', '--project', FAKE_PROJECT])).stdout);
    expect(failed.ok).toBe(true);
    expect(failed.data.map((s: any) => s.session_id)).toContain(SESSION_ID);
  });
});

describe('listSubagents', () => {
  test('returns empty array when subagents directory does not exist', async () => {
    const result = await listSubagents(CLAUDE_DIR, SESSION_ID_2);
    expect(result).toEqual([]);
  });

  test('returns correct metadata from .meta.json', async () => {
    const result = await listSubagents(CLAUDE_DIR, SESSION_ID);
    const agent = result.find(a => a.agent_id === 'a8361bc');
    expect(agent).toBeDefined();
    expect(agent!.agent_type).toBe('test-agent');
    expect(agent!.description).toBe('Test subagent');
    expect(agent!.lines).toBe(2);
    expect(agent!.timestamp).toBe('2026-03-01T10:10:00.000Z');
  });

  test('missing .meta.json returns null agent_type and description', async () => {
    const result = await listSubagents(CLAUDE_DIR, SESSION_ID);
    const agent = result.find(a => a.agent_id === 'b9472cd');
    expect(agent).toBeDefined();
    expect(agent!.agent_type).toBeNull();
    expect(agent!.description).toBeNull();
    expect(agent!.lines).toBe(2);
  });

  test('extracts timestamp from subagent metadata after first 8192 bytes', async () => {
    const result = await listSubagents(CLAUDE_DIR, SESSION_ID);
    const agent = result.find(a => a.agent_id === 'c0583de');
    expect(agent).toBeDefined();
    expect(agent!.lines).toBe(2);
    expect(agent!.timestamp).toBe('2026-03-01T10:20:00.000Z');
  });

  test('results are sorted by timestamp descending (newest first)', async () => {
    const result = await listSubagents(CLAUDE_DIR, SESSION_ID);
    expect(result.length).toBe(3);
    // c0583de has timestamp 2026-03-01T10:20:00.000Z (newest)
    // a8361bc has timestamp 2026-03-01T10:10:00.000Z (newer)
    // b9472cd has timestamp 2026-03-01T10:05:00.000Z (older)
    expect(result[0]!.agent_id).toBe('c0583de');
    expect(result[1]!.agent_id).toBe('a8361bc');
    expect(result[2]!.agent_id).toBe('b9472cd');
  });

  test('rejects invalid session UUID', async () => {
    try {
      await listSubagents(CLAUDE_DIR, '../etc');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.errorCode).toBe('INVALID_ID');
    }
  });
});

// ============================================================================
// subagents integration tests
// ============================================================================

describe('subagents integration', () => {
  test('returns correct metadata for session with subagents', async () => {
    const { exitCode, stdout } = await runCli(['subagents', SESSION_ID, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.subagents.length).toBe(3);
    const agent = result.data.subagents.find((a: any) => a.agent_id === 'a8361bc');
    expect(agent).toBeDefined();
    expect(agent.agent_type).toBe('test-agent');
    expect(agent.description).toBe('Test subagent');
    expect(agent.lines).toBe(2);
  });

  test('returns success with empty subagents array for session without subagents', async () => {
    const { exitCode, stdout } = await runCli(['subagents', SESSION_ID_2, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_2);
    expect(result.data.subagents).toEqual([]);
    expect(result._meta.total).toBe(0);
  });

  test('rejects colon notation with INVALID_ARGS error', async () => {
    const { exitCode, stdout } = await runCli(['subagents', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('parent session ID');
  });

  test('non-existent session returns NOT_FOUND', async () => {
    const { exitCode, stdout } = await runCli(['subagents', 'zzzzzzzz-0000-0000-0000-000000000000', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// --claude-project session follow-up integration
// ============================================================================

describe('--claude-project session follow-up integration', () => {
  test('worktree search hit exposes stable session_ref identity', async () => {
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--operation', 'write', '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    const writer = result.data.find((s: any) => s.session_id === SESSION_ID_8);
    expect(writer).toBeDefined();
    expect(writer.project).toBe(relatedWorktreeDirName);
    expect(writer.project_path_guess).toBe(projectPathGuessFromClaudeProject(relatedWorktreeDirName));
    expect(writer.session_ref).toEqual({
      session_id: SESSION_ID_8,
      project: relatedWorktreeDirName,
    });
  });

  test('shape resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.summary.tool_calls.Write).toBe(1);
    expect(result.data.summary.tool_calls.Bash).toBe(1);
  });

  test('tools resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['tools', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.tool_calls.map((call: any) => call.tool)).toEqual(['Write', 'Bash']);
  });

  test('files resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['files', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.files.map((file: any) => file.path)).toEqual([join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE)]);
  });

  test('messages resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['messages', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.messages.length).toBe(2);
  });

  test('tokens resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['tokens', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.totals.input).toBe(60);
    expect(result.data.totals.output).toBe(15);
  });

  test('slice resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['slice', SESSION_ID_8, '--claude-project', relatedWorktreeDirName, '--turn', '1-2']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.entries.length).toBe(2);
  });

  test('subagents resolves a worktree session with --claude-project', async () => {
    const { exitCode, stdout } = await runCli(['subagents', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID_8);
    expect(result.data.subagents).toEqual([
      {
        agent_id: SUBAGENT_ID,
        agent_type: 'worktree-agent',
        description: 'Worktree subagent',
        lines: 2,
        timestamp: '2026-03-08T10:10:00.000Z',
      },
    ]);
  });

  test('invalid --claude-project basename returns INVALID_ARGS', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID_8, '--claude-project', '.']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--claude-project');
  });

  test('path traversal in --claude-project returns INVALID_ARGS', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID_8, '--claude-project', '../project']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--claude-project');
  });

  test('valid missing --claude-project basename returns NOT_FOUND even when it contains flag text', async () => {
    const { exitCode, stdout } = await runCli(['shape', SESSION_ID_8, '--claude-project=--claude-project']);
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('Claude project directory not found');
  });

  const conflictingCommandArgs = [
    ['shape', SESSION_ID_8],
    ['tools', SESSION_ID_8],
    ['files', SESSION_ID_8],
    ['messages', SESSION_ID_8],
    ['tokens', SESSION_ID_8],
    ['slice', SESSION_ID_8, '--turn', '1-2'],
    ['subagents', SESSION_ID_8],
  ];

  for (const commandArgs of conflictingCommandArgs) {
    test(`${commandArgs[0]} rejects --project with --claude-project`, async () => {
      const { exitCode, stdout } = await runCli([...commandArgs, '--project', RELATED_PROJECT, '--claude-project', relatedWorktreeDirName]);
      expect(exitCode).toBe(2);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(result.error.message).toContain('mutually exclusive');
    });
  }
});

// ============================================================================
// Colon notation with session-scoped commands
// ============================================================================

describe('colon notation integration', () => {
  test('shape <session>:<agent> processes subagent JSONL with correct agent_id', async () => {
    const { exitCode, stdout } = await runCli(['shape', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.summary.total_turns).toBe(2);
    expect(result.data.summary.user_messages).toBe(1);
  });

  test('tools <session>:<agent> works with agent_id', async () => {
    const { exitCode, stdout } = await runCli(['tools', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.tool_calls.length).toBe(0); // subagent fixture has no tool_use blocks
  });

  test('messages <session>:<agent> has structured output with session_id and agent_id', async () => {
    const { exitCode, stdout } = await runCli(['messages', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.messages.length).toBe(2);
  });

  test('slice <session>:<agent> has structured output with session_id and agent_id', async () => {
    const { exitCode, stdout } = await runCli(['slice', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT, '--turn', '1-2']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.entries.length).toBe(2);
  });

  test('tokens <session>:<agent> works with agent_id', async () => {
    const { exitCode, stdout } = await runCli(['tokens', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
  });

  test('files <session>:<agent> works with agent_id', async () => {
    const { exitCode, stdout } = await runCli(['files', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
  });

  test('shape <slug>:<agent> resolves parent slug before subagent lookup', async () => {
    const { exitCode, stdout } = await runCli(['shape', `parent-subagent-test:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.session_id).toBe(SESSION_ID);
    expect(result.data.agent_id).toBe(SUBAGENT_ID);
    expect(result.data.summary.total_turns).toBe(2);
  });

  test('slug-based resolution with colon notation works', async () => {
    const { exitCode, stdout } = await runCli(['shape', `multi-block-test:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    // multi-block-test slug resolves to SESSION_ID_3 which has no subagents dir,
    // so this should fail with NOT_FOUND
    expect(exitCode).toBe(3);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('No subagent');
  });
});

// ============================================================================
// list --include-subagents integration tests
// ============================================================================

describe('list --include-subagents integration', () => {
  test('includes subagent_count on all sessions when flag is set', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--include-subagents']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    // Every session should have subagent_count field
    for (const session of result.data) {
      expect('subagent_count' in session).toBe(true);
      expect(typeof session.subagent_count).toBe('number');
    }
    // SESSION_ID has 3 subagent JSONL files in its subagents directory
    const sessionWithSubagents = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(sessionWithSubagents).toBeDefined();
    expect(sessionWithSubagents.subagent_count).toBe(3);
    // Sessions without subagents directory should have count 0
    const sessionWithout = result.data.find((s: any) => s.session_id === SESSION_ID_2);
    expect(sessionWithout).toBeDefined();
    expect(sessionWithout.subagent_count).toBe(0);
  });

  test('omits subagent_count entirely when flag is not set', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    // No session should have subagent_count field
    for (const session of result.data) {
      expect('subagent_count' in session).toBe(false);
    }
  });
});

// ============================================================================
// SQLite transcript index
// ============================================================================

describe('index db path resolution', () => {
  test('--db flag wins over env and default', () => {
    expect(resolveIndexDbPath('/explicit/path.db', { [INDEX_DB_ENV_VAR]: '/env/path.db' })).toBe('/explicit/path.db');
  });

  test('env var wins over default', () => {
    expect(resolveIndexDbPath(undefined, { [INDEX_DB_ENV_VAR]: '/env/path.db' })).toBe('/env/path.db');
  });

  test('falls back to platform cache directory', () => {
    expect(resolveIndexDbPath(undefined, {})).toBe(defaultIndexDbPath());
    expect(defaultIndexDbPath('/home/u', 'darwin')).toBe('/home/u/Library/Caches/cc-session-tool/index.db');
    expect(defaultIndexDbPath('/home/u', 'linux')).toBe('/home/u/.cache/cc-session-tool/index.db');
  });
});

describe('transcript index module', () => {
  const fixtureSelection = () => selectProjectContexts({
    mode: 'scoped',
    projectPath: FAKE_PROJECT,
    claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
  });

  test('schema version mismatch drops and rebuilds tables', () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', `${uniqueTempName('schema')}.db`);
    const fileDb = openIndexDb(dbPath);
    fileDb.exec('UPDATE schema_version SET version = 999');
    fileDb.exec("INSERT INTO session (project, session_id, agent_id, file_path, file_mtime_ms, file_size, indexed_at, turn_count, line_count) VALUES ('p', 's', '', '/f', 1, 1, 'now', 0, 0)");
    fileDb.close();

    const reopened = openIndexDb(dbPath);
    const version = reopened.query('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(INDEX_SCHEMA_VERSION);
    const count = reopened.query('SELECT COUNT(*) AS n FROM session').get() as { n: number };
    expect(count.n).toBe(0);
    reopened.close();
  });

  test('indexes parent and subagent transcripts as separate rows', () => {
    const selection = fixtureSelection();
    const targets = listIndexTargetsForContext(selection.contexts[0]!);
    const parent = targets.find(t => t.sessionId === SESSION_ID && t.agentId === '');
    const subagent = targets.find(t => t.sessionId === SESSION_ID && t.agentId === SUBAGENT_ID);
    expect(parent).toBeDefined();
    expect(subagent).toBeDefined();
    expect(subagent!.parentSessionId).toBe(SESSION_ID);

    const db = openIndexDb(':memory:');
    const stats = refreshIndexForContexts(db, selection.contexts);
    // Earlier parse tests may have written intentionally unparseable .jsonl
    // files into this fixture dir; those count as failed, never as indexed.
    expect(stats.indexed + stats.failed).toBe(targets.length);
    expect(stats.indexed).toBeGreaterThanOrEqual(targets.length - 1);
    const rows = db.query('SELECT agent_id, parent_session_id FROM session WHERE session_id = ? ORDER BY agent_id').all(SESSION_ID) as Array<{ agent_id: string; parent_session_id: string | null }>;
    expect(rows.length).toBe(4); // parent + 3 subagents
    expect(rows[0]!.agent_id).toBe('');
    expect(rows[0]!.parent_session_id).toBeNull();
    db.close();
  });

  test('second refresh is a no-op when files are unchanged', () => {
    const selection = fixtureSelection();
    const db = openIndexDb(':memory:');
    const first = refreshIndexForContexts(db, selection.contexts);
    expect(first.indexed).toBeGreaterThan(0);
    const second = refreshIndexForContexts(db, selection.contexts);
    expect(second.indexed).toBe(0);
    expect(second.fresh).toBe(first.indexed + first.fresh);
    expect(second.removed).toBe(0);
    db.close();
  });

  test('stores NULL token fields, never zero, when usage is absent', () => {
    const selection = selectProjectContexts({
      mode: 'scoped',
      projectPath: SUMMARY_PROJECT,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });
    const db = openIndexDb(':memory:');
    refreshIndexForContexts(db, selection.contexts);

    // SESSION_ID_13's assistant turn has no usage data at all.
    const turn = db.query("SELECT input_tokens, output_tokens FROM turn WHERE session_id = ? AND role = 'assistant'").get(SESSION_ID_13) as { input_tokens: number | null; output_tokens: number | null };
    expect(turn.input_tokens).toBeNull();
    expect(turn.output_tokens).toBeNull();
    const session = db.query('SELECT input_tokens_total, output_tokens_total FROM session WHERE session_id = ?').get(SESSION_ID_13) as { input_tokens_total: number | null; output_tokens_total: number | null };
    expect(session.input_tokens_total).toBeNull();
    expect(session.output_tokens_total).toBeNull();

    const rows = queryTokenStats(db, {
      projects: selection.contexts.map(c => c.projectRef.project),
      by: 'session',
      includeSubagents: true,
    });
    const statRow = rows.find(r => r.session_id === SESSION_ID_13);
    expect(statRow).toBeDefined();
    expect(statRow!.input_tokens).toBeNull();
    expect(statRow!.turns).toBe(1);
    expect(statRow!.turns_with_usage).toBe(0);
    expect(statRow!.cache_hit_rate).toBeNull();
    db.close();
  });

  test('turn rows exclude system and summary entries, matching live turn numbering', () => {
    const selection = selectProjectContexts({
      mode: 'scoped',
      projectPath: SUMMARY_PROJECT,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });
    const db = openIndexDb(':memory:');
    refreshIndexForContexts(db, selection.contexts);
    // SESSION_ID_13 has system + user + assistant + summary entries; only user/assistant get turn rows.
    const rows = db.query('SELECT turn, role FROM turn WHERE session_id = ? ORDER BY turn').all(SESSION_ID_13) as Array<{ turn: number; role: string }>;
    expect(rows).toEqual([
      { turn: 1, role: 'user' },
      { turn: 2, role: 'assistant' },
    ]);
    db.close();
  });

  test('queryToolPairs orders by sequence and respects filters', () => {
    const selection = fixtureSelection();
    const db = openIndexDb(':memory:');
    refreshIndexForContexts(db, selection.contexts);
    const projects = selection.contexts.map(c => c.projectRef.project);

    // Fixture session: Grep (turn 2) then Edit (turn 4).
    const pairs = queryToolPairs(db, { projects, prev: 'Grep', next: 'Edit', limit: 10, includeSubagents: false });
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.prev_tool).toBe('Grep');
    expect(pairs[0]!.tool).toBe('Edit');
    expect(pairs[0]!.count).toBeGreaterThanOrEqual(1);

    const editOps = queryToolPairs(db, { projects, operation: 'edit', limit: 10, includeSubagents: false });
    expect(editOps.every(p => p.tool === 'Edit')).toBe(true);

    const noMatch = queryToolPairs(db, { projects, pathMatch: 'no-such-path-fragment', limit: 10, includeSubagents: false });
    expect(noMatch.length).toBe(0);
    db.close();
  });

  test('tool_use rows capture operation, file_path, logical_path, and is_error', () => {
    const selection = fixtureSelection();
    const db = openIndexDb(':memory:');
    refreshIndexForContexts(db, selection.contexts);
    const rows = db.query(
      "SELECT tool, operation, file_path, logical_path, is_error FROM tool_use WHERE session_id = ? AND agent_id = '' ORDER BY turn, block_index",
    ).all(SESSION_ID) as Array<{ tool: string; operation: string | null; file_path: string | null; logical_path: string | null; is_error: number | null }>;
    const grep = rows.find(r => r.tool === 'Grep');
    const edit = rows.find(r => r.tool === 'Edit');
    // Successful Grep (tool_1) over path 'src/'; failed Edit (tool_2) on an absolute path.
    // The fixture sets no cwd, so logical_path is null for both.
    expect(grep).toMatchObject({ operation: 'grep', file_path: 'src/', logical_path: null, is_error: 0 });
    expect(edit).toMatchObject({ operation: 'edit', file_path: '/a/b/hello.ts', logical_path: null, is_error: 1 });
    db.close();
  });

  test('cache_hit_rate is cache_read / (input + cache_read + cache_creation)', () => {
    const selection = fixtureSelection();
    const db = openIndexDb(':memory:');
    refreshIndexForContexts(db, selection.contexts);
    const rows = queryTokenStats(db, {
      projects: selection.contexts.map(c => c.projectRef.project),
      by: 'session',
      includeSubagents: false,
    });
    const row = rows.find(r => r.session_id === SESSION_ID && r.agent_id === null);
    expect(row).toBeDefined();
    // Parent usage totals: input 600, cache_read 430, cache_creation 35 -> 430 / 1065 = 0.4038.
    expect(row!.cache_hit_rate).toBe(0.4038);
    db.close();
  });
});

describe('stats integration (token oracle)', () => {
  const ORACLE_DB = join(FIXTURE_DIR, 'dbs', 'oracle.db');

  test('per-session totals from the index match the tokens command', async () => {
    const statsRun = await runCli(['stats', 'tokens', '--by', 'session', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    expect(statsRun.exitCode).toBe(0);
    const stats = parseOutput(statsRun.stdout);
    expect(stats.ok).toBe(true);
    expect(stats._meta.index.mode).toBe('cache');

    const tokensRun = await runCli(['tokens', SESSION_ID, '--project', FAKE_PROJECT]);
    const tokens = parseOutput(tokensRun.stdout);
    expect(tokens.ok).toBe(true);

    const row = stats.data.find((r: any) => r.session_id === SESSION_ID && r.agent_id === null);
    expect(row).toBeDefined();
    // The tokens command zero-fills absent usage; the index stores NULL. Coalesce for comparison.
    expect(row.input_tokens ?? 0).toBe(tokens.data.totals.input);
    expect(row.output_tokens ?? 0).toBe(tokens.data.totals.output);
    expect(row.cache_read_input_tokens ?? 0).toBe(tokens.data.totals.cache_read);
    expect(row.cache_creation_input_tokens ?? 0).toBe(tokens.data.totals.cache_create);
    expect(row.turns).toBe(tokens.data.turns.length);
  });

  test('subagent totals from the index match tokens on the subagent transcript', async () => {
    const statsRun = await runCli(['stats', 'tokens', '--by', 'session', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    const stats = parseOutput(statsRun.stdout);
    const tokensRun = await runCli(['tokens', `${SESSION_ID}:${SUBAGENT_ID}`, '--project', FAKE_PROJECT]);
    const tokens = parseOutput(tokensRun.stdout);
    expect(tokens.ok).toBe(true);

    const row = stats.data.find((r: any) => r.session_id === SESSION_ID && r.agent_id === SUBAGENT_ID);
    expect(row).toBeDefined();
    expect(row.input_tokens ?? 0).toBe(tokens.data.totals.input);
    expect(row.output_tokens ?? 0).toBe(tokens.data.totals.output);
    expect(row.cache_read_input_tokens ?? 0).toBe(tokens.data.totals.cache_read);
    expect(row.cache_creation_input_tokens ?? 0).toBe(tokens.data.totals.cache_create);
  });

  test('--no-subagents excludes subagent rows', async () => {
    const statsRun = await runCli(['stats', 'tokens', '--by', 'session', '--no-subagents', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    const stats = parseOutput(statsRun.stdout);
    expect(stats.ok).toBe(true);
    expect(stats.data.every((r: any) => r.agent_id === null)).toBe(true);
  });

  test('bucketed rollup by model uses day buckets and per-turn models', async () => {
    const statsRun = await runCli(['stats', 'tokens', '--bucket', 'day', '--by', 'model', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    const stats = parseOutput(statsRun.stdout);
    expect(stats.ok).toBe(true);
    const row = stats.data.find((r: any) => r.model === 'claude-sonnet-4-5');
    expect(row).toBeDefined();
    expect(row.bucket).toBe('2026-03-01');
  });

  test('rejects invalid --bucket and --by values', async () => {
    const badBucket = await runCli(['stats', 'tokens', '--bucket', 'month', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    expect(badBucket.exitCode).toBe(2);
    expect(parseOutput(badBucket.stdout).error.code).toBe('INVALID_ARGS');
    const badBy = await runCli(['stats', 'tokens', '--by', 'branch', '--project', FAKE_PROJECT, '--db', ORACLE_DB]);
    expect(badBy.exitCode).toBe(2);
    expect(parseOutput(badBy.stdout).error.code).toBe('INVALID_ARGS');
  });

  test('date-only --before includes the whole named UTC day', async () => {
    // The fixture session has assistant turns on 2026-03-01 (e.g. 2026-03-01T10:00:00.000Z).
    // A bare-date --before must include them; lexicographic `ts <= '2026-03-01'` would not.
    const dbPath = join(FIXTURE_DIR, 'dbs', `${uniqueTempName('before-day')}.db`);
    const included = parseOutput((await runCli(['stats', 'tokens', '--by', 'session', '--before', '2026-03-01', '--project', FAKE_PROJECT, '--db', dbPath])).stdout);
    expect(included.ok).toBe(true);
    const row = included.data.find((r: any) => r.session_id === SESSION_ID && r.agent_id === null);
    expect(row).toBeDefined();
    expect(row.turns).toBeGreaterThan(0);

    // A bare date before any of the session's turns excludes it entirely.
    const excluded = parseOutput((await runCli(['stats', 'tokens', '--by', 'session', '--before', '2026-02-28', '--project', FAKE_PROJECT, '--db', dbPath])).stdout);
    expect(excluded.data.find((r: any) => r.session_id === SESSION_ID)).toBeUndefined();

    // A time without a timezone is rejected rather than compared ambiguously.
    const badTz = await runCli(['stats', 'tokens', '--before', '2026-03-01T10:00', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(badTz.exitCode).toBe(2);
    expect(parseOutput(badTz.stdout).error.code).toBe('INVALID_ARGS');
  });
});

describe('stats integration (tool oracle)', () => {
  test('tool counts in the index match the tools command', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'tool-oracle.db');
    const statsRun = await runCli(['stats', 'trajectories', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(statsRun.exitCode).toBe(0);

    const toolsRun = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT]);
    const tools = parseOutput(toolsRun.stdout);
    expect(tools.ok).toBe(true);
    const liveCounts: Record<string, number> = {};
    for (const call of tools.data.tool_calls) {
      liveCounts[call.tool] = (liveCounts[call.tool] ?? 0) + 1;
    }

    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT tool, COUNT(*) AS n FROM tool_use WHERE session_id = ? AND agent_id = '' GROUP BY tool").all(SESSION_ID) as Array<{ tool: string; n: number }>;
    db.close();
    const indexCounts = Object.fromEntries(rows.map(r => [r.tool, r.n]));
    expect(indexCounts).toEqual(liveCounts);
  });

  test('trajectories returns the fixture Grep -> Edit pair through the CLI', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'tool-oracle.db');
    const statsRun = await runCli(['stats', 'trajectories', '--prev', 'Grep', '--next', 'Edit', '--project', FAKE_PROJECT, '--db', dbPath]);
    const stats = parseOutput(statsRun.stdout);
    expect(stats.ok).toBe(true);
    expect(stats.data.length).toBe(1);
    expect(stats.data[0]).toMatchObject({ prev_tool: 'Grep', tool: 'Edit' });
  });

  test('rejects invalid --operation and --limit', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'tool-oracle.db');
    const badOp = await runCli(['stats', 'trajectories', '--operation', 'rename', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(badOp.exitCode).toBe(2);
    const badLimit = await runCli(['stats', 'trajectories', '--limit', '0', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(badLimit.exitCode).toBe(2);
  });
});

describe('stats integration (incremental refresh)', () => {
  const REFRESH_SESSION_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const REFRESH_PROJECT = join(FIXTURE_DIR, 'index-refresh-project');
  const REFRESH_CLAUDE_DIR = join(FIXTURE_CLAUDE_PROJECTS_ROOT, mangleProjectPath(REFRESH_PROJECT));
  const REFRESH_DB = join(FIXTURE_DIR, 'dbs', 'refresh.db');
  const sessionFile = join(REFRESH_CLAUDE_DIR, `${REFRESH_SESSION_ID}.jsonl`);

  beforeAll(() => {
    mkdirSync(REFRESH_PROJECT, { recursive: true });
    mkdirSync(REFRESH_CLAUDE_DIR, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: REFRESH_SESSION_ID,
        timestamp: '2026-03-02T10:00:00.000Z',
        gitBranch: 'main',
        version: '2.1.0',
        message: { role: 'user', content: 'Refresh fixture' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-03-02T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First response' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join('\n') + '\n');
  });

  test('detects mtime/size change and replaces exactly that session rows', async () => {
    const first = parseOutput((await runCli(['stats', 'tokens', '--by', 'session', '--project', REFRESH_PROJECT, '--db', REFRESH_DB])).stdout);
    expect(first.ok).toBe(true);
    expect(first._meta.index.refresh.indexed).toBe(1);
    const firstRow = first.data.find((r: any) => r.session_id === REFRESH_SESSION_ID);
    expect(firstRow.input_tokens).toBe(10);
    expect(firstRow.output_tokens).toBe(5);

    // Unchanged file: refresh is a no-op.
    const noop = parseOutput((await runCli(['stats', 'tokens', '--by', 'session', '--project', REFRESH_PROJECT, '--db', REFRESH_DB])).stdout);
    expect(noop._meta.index.refresh.indexed).toBe(0);
    expect(noop._meta.index.refresh.fresh).toBe(1);

    appendFileSync(sessionFile, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-02T10:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Appended response' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    }) + '\n');
    // Force a watermark difference even on coarse-mtime filesystems.
    const future = new Date(Date.now() + 5000);
    utimesSync(sessionFile, future, future);

    const second = parseOutput((await runCli(['stats', 'tokens', '--by', 'session', '--project', REFRESH_PROJECT, '--db', REFRESH_DB])).stdout);
    expect(second.ok).toBe(true);
    expect(second._meta.index.refresh.indexed).toBe(1);
    expect(second._meta.index.refresh.fresh).toBe(0);
    const secondRow = second.data.find((r: any) => r.session_id === REFRESH_SESSION_ID);
    expect(secondRow.input_tokens).toBe(17);
    expect(secondRow.output_tokens).toBe(8);
    expect(secondRow.turns).toBe(2);

    // Rows were replaced, not duplicated.
    const db = new Database(REFRESH_DB, { readonly: true });
    const sessionCount = db.query('SELECT COUNT(*) AS n FROM session WHERE session_id = ?').get(REFRESH_SESSION_ID) as { n: number };
    const turnCount = db.query('SELECT COUNT(*) AS n FROM turn WHERE session_id = ?').get(REFRESH_SESSION_ID) as { n: number };
    db.close();
    expect(sessionCount.n).toBe(1);
    expect(turnCount.n).toBe(3); // user + 2 assistant turns
  });
});

describe('stats integration (signals)', () => {
  test('a signal during the synchronous index refresh takes its default action at once', async () => {
    // Holding the write lock parks the CLI's refresh in SQLite's busy wait (busy_timeout 5000 ms). JS listeners cannot
    // run there, so a kept listener would only defer the signal until the run finished and exited 0.
    const dbPath = join(FIXTURE_DIR, 'dbs', `${uniqueTempName('signal')}.db`);
    const lock = openIndexDb(dbPath);
    lock.exec('BEGIN IMMEDIATE');
    // process.execPath, not `bun` from PATH: a version-manager shim that does not exec would take the signal instead.
    const entry = join(import.meta.dir, 'index.ts');
    const proc = Bun.spawn([process.execPath, entry, 'stats', 'tokens', '--project', FAKE_PROJECT, '--db', dbPath], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: FIXTURE_HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      await Bun.sleep(1_000);
      proc.kill('SIGTERM');
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.signalCode).toBe('SIGTERM');
      expect(stdout).toBe('');
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      lock.exec('ROLLBACK');
      lock.close();
    }
  }, 15_000);
});

describe('transcript index refresh edge cases', () => {
  const makeIndexProject = (label: string, files: Record<string, string>) => {
    const projectPath = join(FIXTURE_DIR, uniqueTempName(label));
    const claudeDir = join(FIXTURE_CLAUDE_PROJECTS_ROOT, mangleProjectPath(projectPath));
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(claudeDir, name), content);
    }
    const selection = selectProjectContexts({
      mode: 'scoped',
      projectPath,
      claudeProjectsRoot: FIXTURE_CLAUDE_PROJECTS_ROOT,
    });
    return { projectPath, claudeDir, selection };
  };

  const validSession = (id: string) => [
    JSON.stringify({ type: 'user', sessionId: id, timestamp: '2026-03-02T10:00:00.000Z', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-03-02T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join('\n') + '\n';

  test('removes rows and reports orphans when a transcript is deleted', () => {
    const SESSION_A = '11111111-0000-0000-0000-00000000000a';
    const SESSION_B = '22222222-0000-0000-0000-00000000000b';
    const { claudeDir, selection } = makeIndexProject('index-cleanup', {
      [`${SESSION_A}.jsonl`]: validSession(SESSION_A),
      [`${SESSION_B}.jsonl`]: validSession(SESSION_B),
    });
    const db = openIndexDb(':memory:');
    const first = refreshIndexForContexts(db, selection.contexts);
    expect(first.indexed).toBe(2);
    expect(first.removed).toBe(0);

    // Delete one transcript: its watermark row remains until the next refresh.
    rmSync(join(claudeDir, `${SESSION_B}.jsonl`));
    const freshness = computeIndexFreshness(db, selection.contexts);
    expect(freshness.orphaned).toBe(1);

    const second = refreshIndexForContexts(db, selection.contexts);
    expect(second.removed).toBe(1);
    expect(second.fresh).toBe(1);
    const remaining = (db.query('SELECT session_id FROM session ORDER BY session_id').all() as Array<{ session_id: string }>).map(r => r.session_id);
    expect(remaining).toEqual([SESSION_A]);
    db.close();
  });

  test('records per-file detail for an unparseable transcript', () => {
    const SESSION_GOOD = '33333333-0000-0000-0000-00000000000c';
    const { claudeDir, selection } = makeIndexProject('index-parsefail', {
      [`${SESSION_GOOD}.jsonl`]: validSession(SESSION_GOOD),
      'bad.jsonl': 'not json\n',
    });
    const db = openIndexDb(':memory:');
    const stats = refreshIndexForContexts(db, selection.contexts);
    expect(stats.indexed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.failures.length).toBe(1);
    expect(stats.failures[0]!.file_path).toBe(join(claudeDir, 'bad.jsonl'));
    expect(stats.failures[0]!.reason).toContain('Session file contains no valid entries');
    db.close();
  });
});

describe('index command integration', () => {
  test('index status reports counts and freshness for the scope', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'status.db');
    const { exitCode, stdout } = await runCli(['index', 'status', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.db_path).toBe(dbPath);
    expect(result.data.schema_version).toBe(INDEX_SCHEMA_VERSION);
    expect(result.data.sessions).toBeGreaterThan(0);
    expect(result.data.turns).toBeGreaterThan(0);
    expect(result.data.tool_uses).toBeGreaterThan(0);
    expect(result.data.scope.stale).toBe(0);
    // Unparseable fixture files written by earlier parse tests stay not_indexed.
    expect(result.data.scope.fresh + result.data.scope.not_indexed).toBe(result.data.scope.on_disk);
    expect(result.data.scope.fresh).toBe(result.data.sessions);
  });

  test('index rebuild recreates the database from scratch', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'rebuild.db');
    const first = parseOutput((await runCli(['index', 'status', '--project', FAKE_PROJECT, '--db', dbPath])).stdout);
    expect(first.ok).toBe(true);
    const rebuilt = parseOutput((await runCli(['index', 'rebuild', '--project', FAKE_PROJECT, '--db', dbPath])).stdout);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.data.sessions).toBe(first.data.sessions);
    // Everything was re-indexed, nothing reported fresh from the old database.
    expect(rebuilt._meta.index.refresh.indexed).toBe(rebuilt.data.sessions);
    expect(rebuilt._meta.index.refresh.fresh).toBe(0);
  });

  test('respects CC_SESSION_TOOL_DB env var', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'env-var.db');
    const { stdout } = await runCli(['index', 'status', '--project', FAKE_PROJECT], { CC_SESSION_TOOL_DB: dbPath });
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.db_path).toBe(dbPath);
  });
});

describe('index resilience', () => {
  test('a corrupt cache file is rebuilt transparently', async () => {
    const dbPath = join(FIXTURE_DIR, 'dbs', 'corrupt.db');
    mkdirSync(join(FIXTURE_DIR, 'dbs'), { recursive: true });
    writeFileSync(dbPath, 'this is not a sqlite database');
    const { exitCode, stdout } = await runCli(['stats', 'tokens', '--by', 'session', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.index.mode).toBe('cache');
    expect(result.data.length).toBeGreaterThan(0);
  });

  test('falls back to an in-memory index when the cache path is unusable', async () => {
    // A directory at the db path cannot be opened or deleted by the rebuild path.
    const dbPath = join(FIXTURE_DIR, 'dbs', 'unusable-dir.db');
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, 'occupant.txt'), 'keep');
    const { exitCode, stdout } = await runCli(['stats', 'tokens', '--by', 'session', '--project', FAKE_PROJECT, '--db', dbPath]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.index.mode).toBe('memory');
    expect(result._meta.index.db_path).toBe(':memory:');
    expect(result.data.length).toBeGreaterThan(0);

    const oracle = parseOutput((await runCli(['tokens', SESSION_ID, '--project', FAKE_PROJECT])).stdout);
    const row = result.data.find((r: any) => r.session_id === SESSION_ID && r.agent_id === null);
    expect(row.input_tokens ?? 0).toBe(oracle.data.totals.input);
  });
});

// ============================================================================
// Strict argument parser (src/cli-args.ts)
// ============================================================================

describe('parseCommandArgs', () => {
  const shapeDef: ArgsDef = {
    session: { type: 'positional', required: true },
    project: { type: 'string' },
    'claude-project': { type: 'string' },
  };
  const toolsDef: ArgsDef = {
    session: { type: 'positional', required: true },
    turn: { type: 'string' },
    'claude-project': { type: 'string' },
  };
  const searchDef: ArgsDef = {
    text: { type: 'string' },
    subagents: { type: 'boolean', default: true },
    counter: { type: 'string', multiple: true } as ArgsDef[string],
    glob: { type: 'string' },
  };
  const sliceDef: ArgsDef = {
    session: { type: 'positional', required: true },
    turn: { type: 'string', required: true },
  };
  const noFlagsDef: ArgsDef = {};

  function argsError(fn: () => unknown): CliArgsError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError);
      expect(isCliArgsError(err)).toBe(true);
      return err as CliArgsError;
    }
    throw new Error('expected parseCommandArgs to throw');
  }

  function plainError(fn: () => unknown): Error {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CliArgsError);
      expect(isCliArgsError(err)).toBe(false);
      return err as Error;
    }
    throw new Error('expected parseCommandArgs to throw');
  }

  test('isCliArgsError rejects non-CliArgsError values', () => {
    expect(isCliArgsError(new Error('x'))).toBe(false);
    expect(isCliArgsError('x')).toBe(false);
    expect(isCliArgsError(null)).toBe(false);
  });

  describe('unknown flags', () => {
    test.each([
      [['abc', '--turn', '1-2'], '--turn'],
      [['abc', '--turn=1-2'], '--turn'],
      [['abc', '--no-turn'], '--no-turn'],
      [['abc', '--no-project'], '--no-project'],
      [['abc', '--claudeProject', 'x'], '--claudeProject'],
      [['abc', '-x'], '-x'],
      [['abc', '-'], '-'],
      [['abc', '-x=secret'], '-x'],
    ])('rejects %j echoing %s', (tokens, echoed) => {
      const err = argsError(() => parseCommandArgs(tokens, shapeDef, 'shape'));
      expect(err.message.startsWith(`unknown flag ${echoed} for command shape`)).toBe(true);
      expect(err.message).toContain('(supported flags: --project, --claude-project)');
      expect(err.message).not.toContain('secret');
    });

    test.each([
      [['--constructor', 'x']],
      [['--__proto__', 'x']],
      [['--toString']],
      [['--valueOf', 'x']],
      [['--no-constructor']],
      [['--hasOwnProperty=1']],
    ])('treats Object.prototype name %j as unknown', (tokens) => {
      const err = argsError(() => parseCommandArgs(['abc', ...tokens], shapeDef, 'shape'));
      expect(err.message).toContain('unknown flag --');
      expect(err.message).toContain('for command shape');
    });

    test('commands with no flags say so', () => {
      const err = argsError(() => parseCommandArgs(['--x'], noFlagsDef, 'index status'));
      expect(err.message).toBe('unknown flag --x for command index status (command index status accepts no flags)');
    });

    test('full path appears in the message', () => {
      const err = argsError(() => parseCommandArgs(['--bogus'], searchDef, 'stats tokens'));
      expect(err.message).toContain('for command stats tokens');
    });
  });

  describe('values', () => {
    test('dash-leading values are accepted when space-separated', () => {
      const parsed = parseCommandArgs(['abc', '--claude-project', '-Users-me-app'], shapeDef, 'shape');
      expect(parsed['claude-project']).toBe('-Users-me-app');
      const glob = parseCommandArgs(['--glob', '-tmp-*'], searchDef, 'search');
      expect(glob.glob).toBe('-tmp-*');
    });

    test('--flag=value keeps a --leading value verbatim', () => {
      const parsed = parseCommandArgs(['abc', '--claude-project=--claude-project'], shapeDef, 'shape');
      expect(parsed['claude-project']).toBe('--claude-project');
    });

    test('value after first = is kept verbatim', () => {
      const parsed = parseCommandArgs(['abc', '--turn=a=b'], toolsDef, 'tools');
      expect(parsed.turn).toBe('a=b');
    });

    test('missing value at end of argv', () => {
      const err = argsError(() => parseCommandArgs(['abc', '--turn'], toolsDef, 'tools'));
      expect(err.message).toBe(
        'flag --turn for command tools requires a value; use --turn=<value> if the value starts with --',
      );
    });

    test('missing value when followed by a -- token', () => {
      const err = argsError(() => parseCommandArgs(['abc', '--turn', '--claude-project', 'x'], toolsDef, 'tools'));
      expect(err.message).toContain('flag --turn for command tools requires a value');
    });

    test('empty values are rejected', () => {
      for (const tokens of [['abc', '--turn='], ['abc', '--turn', '']]) {
        const err = argsError(() => parseCommandArgs(tokens, toolsDef, 'tools'));
        expect(err.message).toBe('flag --turn for command tools requires a non-empty value');
      }
    });
  });

  describe('boolean forms', () => {
    test('accepted forms', () => {
      expect(parseCommandArgs(['--subagents'], searchDef, 'search').subagents).toBe(true);
      expect(parseCommandArgs(['--no-subagents'], searchDef, 'search').subagents).toBe(false);
      expect(parseCommandArgs(['--subagents=true'], searchDef, 'search').subagents).toBe(true);
      expect(parseCommandArgs(['--subagents=false'], searchDef, 'search').subagents).toBe(false);
    });

    const boolMessage =
      'flag --subagents for command search is a boolean; use --subagents, --no-subagents, --subagents=true or --subagents=false';

    test.each([
      [['--subagents=yes']],
      [['--subagents=']],
      [['--no-subagents=true']],
      [['--no-subagents=']],
      [['--subagents', 'false']],
      [['--subagents', 'true']],
      [['--no-subagents', 'false']],
      [['--no-subagents', 'true']],
    ])('rejects %j with the boolean-form message', (tokens) => {
      const err = argsError(() => parseCommandArgs(tokens, searchDef, 'search'));
      expect(err.message).toBe(boolMessage);
    });

    test('--no-<string flag> is an unknown flag', () => {
      const err = argsError(() => parseCommandArgs(['--no-text'], searchDef, 'search'));
      expect(err.message.startsWith('unknown flag --no-text for command search')).toBe(true);
    });
  });

  describe('classification order', () => {
    test('a def declaring only no-foo reaches no-foo', () => {
      const def: ArgsDef = { 'no-foo': { type: 'boolean' } };
      expect(parseCommandArgs(['--no-foo'], def, 'x')['no-foo']).toBe(true);
    });

    test('declaring both x and no-x throws a plain Error', () => {
      plainError(() => parseCommandArgs([], { x: { type: 'boolean' }, 'no-x': { type: 'boolean' } }, 'x'));
    });
  });

  describe('defaults', () => {
    test('boolean default applies when absent', () => {
      expect(parseCommandArgs([], searchDef, 'search').subagents).toBe(true);
    });

    test('boolean without default is omitted', () => {
      const def: ArgsDef = { all: { type: 'boolean' } };
      const parsed = parseCommandArgs([], def, 'x');
      expect(Object.hasOwn(parsed, 'all')).toBe(false);
    });

    test('optional positional default applies', () => {
      const def: ArgsDef = { name: { type: 'positional', default: 'fallback' } };
      expect(parseCommandArgs([], def, 'x').name).toBe('fallback');
      expect(parseCommandArgs(['given'], def, 'x').name).toBe('given');
    });

    test('a required flag with a default is never reported missing', () => {
      const def: ArgsDef = { mode: { type: 'string', required: true, default: 'a' } };
      expect(parseCommandArgs([], def, 'x').mode).toBe('a');
    });
  });

  describe('duplicates', () => {
    test('repeated single-valued flag is rejected', () => {
      const err = argsError(() => parseCommandArgs(['abc', '--turn', '1', '--turn', '3'], toolsDef, 'tools'));
      expect(err.message).toBe('flag --turn for command tools may only be given once');
    });

    test('--x=1 --x=2 echoes only the flag', () => {
      const err = argsError(() => parseCommandArgs(['abc', '--turn=1', '--turn=2'], toolsDef, 'tools'));
      expect(err.message).toBe('flag --turn for command tools may only be given once');
    });

    test('--subagents --no-subagents is rejected and echoes the second token', () => {
      const err = argsError(() => parseCommandArgs(['--subagents', '--no-subagents'], searchDef, 'search'));
      expect(err.message).toBe('flag --no-subagents for command search may only be given once');
    });

    test('multiple flags collect arrays and are omitted when absent', () => {
      expect(parseCommandArgs(['--counter', 'a=1'], searchDef, 'search').counter).toEqual(['a=1']);
      expect(parseCommandArgs(['--counter', 'a=1', '--counter=b=2'], searchDef, 'search').counter).toEqual(['a=1', 'b=2']);
      expect(Object.hasOwn(parseCommandArgs([], searchDef, 'search'), 'counter')).toBe(false);
    });
  });

  describe('positionals', () => {
    test('bind in declaration order, interleaved with flags', () => {
      const def: ArgsDef = {
        first: { type: 'positional', required: true },
        second: { type: 'positional', required: true },
        turn: { type: 'string' },
      };
      const parsed = parseCommandArgs(['--turn', '1-2', 'a', 'b'], def, 'x');
      expect(parsed.first).toBe('a');
      expect(parsed.second).toBe('b');
      expect(parsed.turn).toBe('1-2');
      expect(parsed._).toEqual(['a', 'b']);
      const interleaved = parseCommandArgs(['a', '--turn', '1-2', 'b'], def, 'x');
      expect(interleaved.first).toBe('a');
      expect(interleaved.second).toBe('b');
    });

    test('positional may follow flags: slice --turn 1-2 <session>', () => {
      const parsed = parseCommandArgs(['--turn', '1-2', 'abc'], sliceDef, 'slice');
      expect(parsed.session).toBe('abc');
      expect(parsed.turn).toBe('1-2');
    });

    test('extra positional, command takes one', () => {
      const err = argsError(() => parseCommandArgs(['a', 'extra'], shapeDef, 'shape'));
      expect(err.message).toBe("unexpected argument 'extra' for command shape (expected: <session>)");
    });

    test('extra positional, command takes none', () => {
      const err = argsError(() => parseCommandArgs(['extra'], searchDef, 'search'));
      expect(err.message).toBe("unexpected argument 'extra' for command search (command search takes no positional arguments)");
    });

    test('missing required positional', () => {
      const err = argsError(() => parseCommandArgs([], shapeDef, 'shape'));
      expect(err.message).toBe('missing required argument <session> for command shape');
    });

    test('after --, later tokens are positional', () => {
      const parsed = parseCommandArgs(['--', '--x'], shapeDef, 'shape');
      expect(parsed.session).toBe('--x');
      const err = argsError(() => parseCommandArgs(['a', '--', '--x'], shapeDef, 'shape'));
      expect(err.message).toContain("unexpected argument '--x'");
    });

    test('first walk problem wins over positional count', () => {
      const err = argsError(() => parseCommandArgs(['a', 'b', '--bogus'], shapeDef, 'shape'));
      expect(err.message.startsWith('unknown flag --bogus for command shape')).toBe(true);
    });
  });

  describe('required flags', () => {
    test('slice --turn is required', () => {
      const err = argsError(() => parseCommandArgs(['abc'], sliceDef, 'slice'));
      expect(err.message).toBe('missing required flag --turn for command slice');
    });
  });

  describe('output keys', () => {
    test('contains only declared names given or defaulted, plus _', () => {
      const parsed = parseCommandArgs(['abc', '--project', '/p'], shapeDef, 'shape');
      expect(Object.keys(parsed).sort()).toEqual(['_', 'project', 'session']);
      const search = parseCommandArgs(['--text', 'x'], searchDef, 'search');
      expect(Object.keys(search).sort()).toEqual(['_', 'subagents', 'text']);
      expect(Object.hasOwn(search, 'claudeProjectsRoot')).toBe(false);
    });

    test('camelCase never resolves to a kebab-case flag', () => {
      argsError(() => parseCommandArgs(['abc', '--claudeProject', 'x'], shapeDef, 'shape'));
    });
  });

  describe('malformed command definitions', () => {
    test('throw a plain Error, not CliArgsError', () => {
      plainError(() => parseCommandArgs([], { x: { type: 'string', alias: 'y' } }, 'x'));
      plainError(() => parseCommandArgs([], { x: {} }, 'x'));
      plainError(() => parseCommandArgs([], { x: { type: 'enum' } as unknown as ArgsDef[string] }, 'x'));
      plainError(() => parseCommandArgs([], { x: { type: 'boolean', multiple: true } as ArgsDef[string] }, 'x'));
      plainError(() => parseCommandArgs([], { x: { type: 'string', multiple: true, default: 'a' } as ArgsDef[string] }, 'x'));
      plainError(() => parseCommandArgs([], { _: { type: 'string' } }, 'x'));
    });
  });
});

// ============================================================================
// Command resolver (src/cli-args.ts)
// ============================================================================

/** Args each real leaf needs to parse cleanly; the per-leaf integration loop below reuses this. */
const LEAF_REQUIRED_ARGS: Record<string, string[]> = {
  list: [],
  projects: [],
  search: [],
  shape: ['SESSION'],
  summary: ['SESSION'],
  tools: ['SESSION'],
  files: ['SESSION'],
  tokens: ['SESSION'],
  messages: ['SESSION'],
  slice: ['SESSION', '--turn', '1-2'],
  subagents: ['SESSION'],
  'index status': [],
  'index rebuild': [],
  'stats tokens': [],
  'stats trajectories': [],
};

/** Enumerate leaf command paths of a tree the same way the resolver defines a leaf. */
function enumerateLeafPaths(cmd: CommandDef<ArgsDef>, prefix: string[] = []): string[] {
  const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef<ArgsDef>>;
  const names = Object.keys(subs);
  if (names.length === 0) return [prefix.join(' ')];
  return names.flatMap((name) => enumerateLeafPaths(subs[name] as CommandDef<ArgsDef>, [...prefix, name]));
}

describe('resolveCliCommand', () => {
  const noop = () => {};
  const leafArgs: ArgsDef = { session: { type: 'positional', required: true }, flag: { type: 'string' } };
  const tree = defineCommand({
    meta: { name: 'tool' },
    subCommands: {
      one: defineCommand({ meta: { name: 'one' }, args: leafArgs, run: noop }),
      grp: defineCommand({
        meta: { name: 'grp' },
        subCommands: {
          deep: defineCommand({ meta: { name: 'deep' }, args: () => leafArgs, run: noop }),
          other: defineCommand({ meta: { name: 'other' }, run: noop }),
        },
      }),
      empty: defineCommand({ meta: { name: 'empty' }, subCommands: {}, run: noop }),
    },
  });

  const argsError = async (argv: string[], root: CommandDef<ArgsDef> = tree): Promise<CliArgsError> => {
    try {
      await resolveCliCommand(root, argv);
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError);
      expect(isCliArgsError(err)).toBe(true);
      return err as CliArgsError;
    }
    throw new Error('expected resolveCliCommand to throw');
  };
  const plainError = async (root: CommandDef<ArgsDef>, argv: string[] = []): Promise<Error> => {
    try {
      await resolveCliCommand(root, argv);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CliArgsError);
      return err as Error;
    }
    throw new Error('expected resolveCliCommand to throw');
  };

  test('resolves a depth-1 leaf with rawArgs, path and argsDef', async () => {
    const r = await resolveCliCommand(tree, ['one', 'abc', '--flag', 'x']);
    expect(r.path).toEqual(['one']);
    expect(r.rawArgs).toEqual(['abc', '--flag', 'x']);
    expect(r.argsDef).toBe(leafArgs);
    expect(typeof r.command.run).toBe('function');
  });

  test('resolves a depth-2 leaf and a thunk-resolved argsDef', async () => {
    const r = await resolveCliCommand(tree, ['grp', 'deep', 'abc']);
    expect(r.path).toEqual(['grp', 'deep']);
    expect(r.rawArgs).toEqual(['abc']);
    expect(r.argsDef).toBe(leafArgs);
  });

  test('a leaf without args resolves to an empty argsDef', async () => {
    const r = await resolveCliCommand(tree, ['grp', 'other']);
    expect(r.argsDef).toEqual({});
    expect(r.rawArgs).toEqual([]);
  });

  test('subCommands: {} is a leaf', async () => {
    const r = await resolveCliCommand(tree, ['empty', 'x']);
    expect(r.path).toEqual(['empty']);
    expect(r.rawArgs).toEqual(['x']);
  });

  test('missing subcommand at the root and at a group', async () => {
    expect((await argsError([])).message).toBe(
      'missing subcommand for command tool (available subcommands: one, grp, empty)',
    );
    expect((await argsError(['grp'])).message).toBe(
      'missing subcommand for command grp (available subcommands: deep, other)',
    );
  });

  test('a flag before the subcommand is rejected without echoing its value', async () => {
    const err = await argsError(['--all-projects=secret', 'one']);
    expect(err.message).toBe(
      'unknown flag --all-projects for command tool; flags must follow the subcommand name (available subcommands: one, grp, empty)',
    );
    expect(err.message).not.toContain('secret');
    expect((await argsError(['grp', '-x', 'deep'])).message).toContain('unknown flag -x for command grp;');
  });

  test('unknown subcommand', async () => {
    expect((await argsError(['shap'])).message).toBe(
      "unknown subcommand 'shap' for command tool (available subcommands: one, grp, empty)",
    );
    expect((await argsError(['grp', 'nope'])).message).toContain("unknown subcommand 'nope' for command grp");
  });

  test('Object.prototype names are unknown subcommands', async () => {
    for (const token of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const err = await argsError([token]);
      expect(err.message).toContain(`unknown subcommand '${token}' for command tool`);
    }
    expect((await argsError(['grp', 'constructor'])).message).toContain("unknown subcommand 'constructor' for command grp");
  });

  describe('malformed command definitions', () => {
    test('a leaf without run', async () => {
      const root = defineCommand({ meta: { name: 'r' }, subCommands: { a: defineCommand({ meta: { name: 'a' } }) } });
      await plainError(root, ['a']);
    });

    test('a leaf with setup or cleanup', async () => {
      const withSetup = defineCommand({
        meta: { name: 'r' },
        subCommands: { a: defineCommand({ meta: { name: 'a' }, run: noop, setup: noop }) },
      });
      const withCleanup = defineCommand({
        meta: { name: 'r' },
        subCommands: { a: defineCommand({ meta: { name: 'a' }, run: noop, cleanup: noop }) },
      });
      await plainError(withSetup, ['a']);
      await plainError(withCleanup, ['a']);
    });

    test('a group with args, run, setup or cleanup', async () => {
      const child = defineCommand({ meta: { name: 'a' }, run: noop });
      const extras: Partial<CommandDef<ArgsDef>>[] = [
        { args: { x: { type: 'string' } } },
        { run: noop },
        { setup: noop },
        { cleanup: noop },
      ];
      for (const extra of extras) {
        const root = defineCommand({ meta: { name: 'r' }, subCommands: { a: child }, ...extra });
        await plainError(root, ['a']);
        await plainError(root, []);
      }
    });

    test('a root without meta.name', async () => {
      const root = defineCommand({ subCommands: { a: defineCommand({ meta: { name: 'a' }, run: noop }) } });
      await plainError(root, ['a']);
    });

    test('a subcommand that resolves to no definition names the command', async () => {
      const root = defineCommand({
        meta: { name: 'r' },
        subCommands: { a: (() => undefined) as unknown as CommandDef<ArgsDef> },
      });
      expect((await plainError(root, ['a'])).message).toContain('command a resolved to no definition');
    });

    test('subCommands that resolve to null are treated as a leaf', async () => {
      const root = defineCommand({
        meta: { name: 'r' },
        subCommands: (() => null) as unknown as Record<string, CommandDef<ArgsDef>>,
        run: noop,
      });
      const r = await resolveCliCommand(root, ['x']);
      expect(r.path).toEqual([]);
      expect(r.rawArgs).toEqual(['x']);
    });
  });
});

describe('real command tree (resolver + parser)', () => {
  test('enumerated leaf paths equal LEAF_REQUIRED_ARGS keys', () => {
    expect(enumerateLeafPaths(cliMain).sort()).toEqual(Object.keys(LEAF_REQUIRED_ARGS).sort());
    expect(Object.keys(LEAF_REQUIRED_ARGS)).toHaveLength(15);
  });

  // Exactly the project-selecting leaves accept --include-project-lists; every session leaf rejects it.
  const PROJECT_LIST_LEAF_PATHS = new Set(['list', 'projects', 'search', 'index status', 'index rebuild', 'stats tokens', 'stats trajectories']);

  for (const [leafPath, required] of Object.entries(LEAF_REQUIRED_ARGS)) {
    const accepts = PROJECT_LIST_LEAF_PATHS.has(leafPath);
    test(`'${leafPath}' ${accepts ? 'accepts' : 'rejects'} --include-project-lists`, async () => {
      const resolved = await resolveCliCommand(cliMain, [...leafPath.split(' '), ...required, '--include-project-lists']);
      const parse = () => parseCommandArgs(resolved.rawArgs, resolved.argsDef, leafPath);
      if (accepts) {
        expect(parse()['include-project-lists']).toBe(true);
      } else {
        expect(parse).toThrow(CliArgsError);
      }
    });
  }

  for (const [leafPath, required] of Object.entries(LEAF_REQUIRED_ARGS)) {
    test(`resolves and parses '${leafPath}'`, async () => {
      const resolved = await resolveCliCommand(cliMain, [...leafPath.split(' '), ...required]);
      expect(resolved.path.join(' ')).toBe(leafPath);
      expect(() => parseCommandArgs(resolved.rawArgs, resolved.argsDef, leafPath)).not.toThrow();
    });
  }
});

// ============================================================================
// Strict argument dispatch (dispatchCli) integration
// ============================================================================

describe('sessionProjectSelectorFromArgs with an empty --claude-project', () => {
  test('an explicit empty string is an explicit selector, not a CWD fallback', () => {
    expect(sessionProjectSelectorFromArgs({ 'claude-project': '' })).toEqual({ kind: 'claudeProject', project: '' });
  });

  test('resolving the empty selector throws INVALID_ARGS', () => {
    const selector = sessionProjectSelectorFromArgs({ 'claude-project': '' });
    let thrown: unknown;
    try {
      resolveClaudeProjectDirFromSelector(selector, FIXTURE_CLAUDE_PROJECTS_ROOT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProjectSelectionError);
    expect((thrown as ProjectSelectionError).code).toBe('INVALID_ARGS');
  });

  test('--project together with an empty --claude-project is mutually exclusive', () => {
    expect(() => sessionProjectSelectorFromArgs({ project: '/x', 'claude-project': '' })).toThrow(ProjectSelectionError);
  });
});

describe('strict argument dispatch integration', () => {
  const MISSING_SESSION = '99999999-0000-0000-0000-000000000000';

  async function expectInvalidArgs(args: string[], messagePart: string, env: Record<string, string> = {}) {
    const { exitCode, stdout } = await runCli(args, env);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain(messagePart);
    return result;
  }

  describe('issue repros', () => {
    test('shape --turn is rejected as an unknown flag', async () => {
      await expectInvalidArgs(
        ['shape', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-2'],
        'unknown flag --turn for command shape',
      );
    });

    test('list --claude-project is rejected and does not report a CWD-derived NOT_FOUND', async () => {
      const result = await expectInvalidArgs(
        ['list', '--claude-project', '-zzz-bogus--claude-worktrees-xyz'],
        'unknown flag --claude-project for command list',
      );
      expect(result.error.message.toLowerCase()).not.toContain('not found');
    });
  });

  describe('per-leaf --definitely-unknown loop', () => {
    for (const [leafPath, required] of Object.entries(LEAF_REQUIRED_ARGS)) {
      test(`'${leafPath}' rejects an unknown flag before any I/O`, async () => {
        const tempDir = join(tmpdir(), uniqueTempName('cc-session-unknown-flag'));
        mkdirSync(tempDir, { recursive: true });
        try {
          const dbPath = join(tempDir, 'index.db');
          const usesDb = leafPath.startsWith('stats ') || leafPath.startsWith('index ');
          const args = [
            ...leafPath.split(' '),
            ...required.map((token) => (token === 'SESSION' ? MISSING_SESSION : token)),
            '--definitely-unknown',
            ...(usesDb ? ['--db', dbPath] : []),
          ];
          const { exitCode, stdout } = await runCli(args);
          expect(exitCode).toBe(2);
          const result = parseOutput(stdout);
          expect(result.ok).toBe(false);
          expect(result.error.code).toBe('INVALID_ARGS');
          expect(result.error.message).toContain(`unknown flag --definitely-unknown for command ${leafPath}`);
          expect(result.error.message).toContain(`for command ${leafPath}`);
          expect(existsSync(dbPath)).toBe(false);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }
  });

  describe('dash-leading values', () => {
    test('projects --glob accepts a dash-leading raw basename', async () => {
      expect(fakeDirName.startsWith('-')).toBe(true);
      const { exitCode, stdout } = await runCli(['projects', '--glob', fakeDirName]);
      expect(exitCode).toBe(0);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(true);
      expect(result.data.map((p: any) => p.project)).toEqual([fakeDirName]);
    });

    test('list --all-projects --project-glob accepts a dash-leading raw basename', async () => {
      const { exitCode, stdout } = await runCli(['list', '--all-projects', '--project-glob', secondFakeDirName]);
      expect(exitCode).toBe(0);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(true);
      expect(result._meta.projects_scanned).toBe(1);
      expect(result.data.map((s: any) => s.session_id)).toEqual([SESSION_ID_6]);
    });

    test('--claude-project with a dash-leading basename still resolves a session', async () => {
      const { exitCode, stdout } = await runCli(['shape', SESSION_ID_8, '--claude-project', relatedWorktreeDirName]);
      expect(exitCode).toBe(0);
      expect(parseOutput(stdout).ok).toBe(true);
    });

    test('--claude-project=--claude-project keeps its value and returns NOT_FOUND', async () => {
      const { exitCode, stdout } = await runCli(['shape', SESSION_ID, '--claude-project=--claude-project']);
      expect(exitCode).toBe(3);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('project-glob typo fallback', () => {
    test('list --all-projects --project-glob with a nonexistent basename is ok with zero projects scanned', async () => {
      const { exitCode, stdout } = await runCli(['list', '--all-projects', '--project-glob', '-no-such-project-basename-zzz']);
      expect(exitCode).toBe(0);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
      expect(result._meta.projects_scanned).toBe(0);
    });
  });

  describe('rejected forms', () => {
    test('a repeated single-valued flag is INVALID_ARGS, not FORMAT_ERROR', async () => {
      await expectInvalidArgs(
        ['tools', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1', '--turn', '3'],
        'flag --turn for command tools may only be given once',
      );
    });

    test('the hidden camelCase --claude-projects-root redirect is rejected', async () => {
      await expectInvalidArgs(
        ['shape', SESSION_ID, '--claude-projects-root', FIXTURE_CLAUDE_PROJECTS_ROOT],
        'unknown flag --claude-projects-root for command shape',
      );
    });

    test('--subagents false is rejected with the boolean-form message', async () => {
      await expectInvalidArgs(
        ['search', '--text', 'x', '--subagents', 'false', '--project', FAKE_PROJECT],
        'flag --subagents for command search is a boolean; use --subagents, --no-subagents, --subagents=true or --subagents=false',
      );
    });

    test('an empty flag value is rejected', async () => {
      await expectInvalidArgs(
        ['tools', SESSION_ID, '--project', FAKE_PROJECT, '--turn='],
        'flag --turn for command tools requires a non-empty value',
      );
    });

    test('an extra positional is rejected', async () => {
      await expectInvalidArgs(
        ['shape', SESSION_ID, 'extra', '--project', FAKE_PROJECT],
        "unexpected argument 'extra' for command shape",
      );
    });

    test('an empty --claude-project is rejected and not silently replaced by the CWD', async () => {
      await expectInvalidArgs(
        ['tools', SESSION_ID, '--claude-project='],
        'flag --claude-project for command tools requires a non-empty value',
      );
    });
  });

  describe('JSON envelopes for errors citty used to print as text', () => {
    test('shape with no session', async () => {
      await expectInvalidArgs(['shape'], 'missing required argument <session> for command shape');
    });

    test('slice without --turn', async () => {
      await expectInvalidArgs(['slice', SESSION_ID, '--project', FAKE_PROJECT], 'missing required flag --turn for command slice');
    });

    test('unknown subcommand', async () => {
      await expectInvalidArgs(['shap'], "unknown subcommand 'shap' for command cc-session-tool");
    });

    test('Object.prototype key as a subcommand', async () => {
      await expectInvalidArgs(['constructor'], "unknown subcommand 'constructor' for command cc-session-tool");
    });

    test('no arguments at all', async () => {
      await expectInvalidArgs([], 'missing subcommand for command cc-session-tool');
    });

    test('group without a subcommand', async () => {
      await expectInvalidArgs(['stats'], 'missing subcommand for command stats (available subcommands: tokens, trajectories)');
    });

    test('a flag placed before the subcommand', async () => {
      await expectInvalidArgs(['--all-projects', 'list'], 'unknown flag --all-projects for command cc-session-tool');
    });

    test('--version after a subcommand is an unknown flag, not version output', async () => {
      await expectInvalidArgs(['list', '--version'], 'unknown flag --version for command list');
    });

    test('--version followed by a subcommand is rejected, not version output', async () => {
      await expectInvalidArgs(
        ['--version', 'list'],
        'unknown flag --version for command cc-session-tool; flags must follow the subcommand name',
      );
    });
  });

  describe('preserved paths', () => {
    test('--version exits 0 and prints the version', async () => {
      const { exitCode, stdout } = await runCliHelp(['--version']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(VERSION);
    });

    test('--help still reaches citty', async () => {
      const { exitCode, stdout } = await runCliHelp(['shape', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('shape');
    });

    test('-h reaches citty help even with an unknown flag present', async () => {
      const { exitCode, stdout } = await runCliHelp(['shape', 'x', '--definitely-unknown', '-h']);
      expect(exitCode).toBe(0);
      // consola renders the usage line differently under CI (`[log]` prefix, ANSI codes,
      // literal backticks), so match only the span that is contiguous in every reporter.
      expect(stdout).toContain('cc-session-tool shape [OPTIONS] <SESSION>');
    });

    test('repeated --counter and --counter-regex both produce counters', async () => {
      const { exitCode, stdout } = await runCli([
        'search',
        '--counter', 'tracking=.claude-tracking',
        '--counter', 'other=no-such-counter-marker',
        '--counter-regex', 'tracking_rx=claude-tracking',
        '--aggregate', 'counters',
        '--project', FAKE_PROJECT,
      ]);
      expect(exitCode).toBe(0);
      const result = parseOutput(stdout);
      expect(result.ok).toBe(true);
      const aggregate = result.data.find((s: any) => s.session_id === SESSION_ID_4);
      expect(aggregate).toBeDefined();
      expect(Object.keys(aggregate.counts).sort()).toEqual(['other', 'tracking', 'tracking_rx']);
    });

    test('--subagents=false excludes subagent rows like --no-subagents', async () => {
      const base = ['search', '--text', 'Subagent response', '--project', FAKE_PROJECT];
      const withEquals = parseOutput((await runCli([...base, '--subagents=false'])).stdout);
      const withNo = parseOutput((await runCli([...base, '--no-subagents'])).stdout);
      expect(withEquals.ok).toBe(true);
      expect(withEquals.data).toEqual(withNo.data);
      expect(withEquals.data.find((s: any) => s.session_id === SESSION_ID)).toBeUndefined();
    });
  });
});

// ============================================================================
// tools outcome fixture: outcome_hash, handles, malformed-input tolerance
// ============================================================================

describe('tools outcome integration', () => {
  const TOOLS_ROOT = join(SHORT_TMP_ROOT, uniqueTempName('cc-session-tools-outcome-fixture'));
  const TOOLS_HOME = join(TOOLS_ROOT, 'home');
  const TOOLS_PROJECT = join(TOOLS_ROOT, 'outcome-project');
  const TOOLS_CLAUDE_DIR = join(claudeProjectsRoot(TOOLS_HOME), mangleProjectPath(TOOLS_PROJECT));
  const TOOLS_SESSION = 'e0e0e0e0-0000-4000-8000-0000000000e0';
  const NULL_SESSION = 'e0e0e0e0-0000-4000-8000-0000000000e1';
  const SUB_ID = 'outcome_sub';
  const KEY_ORDER = ['turn', 'tool', 'input_summary', 'outcome', 'outcome_hash', 'duration_ms', 'tool_use_id', 'result_turn'];

  // A, B and C share a >60-char prefix; A and B have the same total length and diverge later; C equals A.
  const SHARED_PREFIX = 'This session is isolated in the worktree /work/trees/issue-16-long-name, but this command ';
  const ERR_A = `${SHARED_PREFIX}writes to /alpha/path.ts (blocked)`;
  const ERR_B = `${SHARED_PREFIX}writes to /bravo/path.ts (blocked)`;
  const ERR_C = ERR_A;
  const ERR_D = `${SHARED_PREFIX}reads /charlie/other/longer/path.ts (blocked, retry inside the isolated worktree)`;
  const SUB_ERR = 'Subagent build failed because the toolchain was not found on this machine PATH';
  const LONG_OK = `${'success line one '.repeat(20)}\nsecond line`;
  const NULL_ERR = `${SHARED_PREFIX}is refused in a turn that also holds a null content block`;

  const sha12 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const MARKER_RE = /\.\.\.\[truncated, (\d+) chars\]$/;
  const minute = (n: number) => `2026-05-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const user = (turn: number, content: unknown) => JSON.stringify({
    type: 'user', sessionId: TOOLS_SESSION, timestamp: minute(turn), cwd: TOOLS_PROJECT, message: { role: 'user', content },
  });
  const assistant = (turn: number, content: unknown[]) => JSON.stringify({
    type: 'assistant', timestamp: minute(turn), cwd: TOOLS_PROJECT, message: { role: 'assistant', content },
  });
  const use = (name: string, id: string | undefined, input: unknown) => ({ type: 'tool_use', name, ...(id === undefined ? {} : { id }), input });
  const toolResult = (id: string, content: unknown, is_error?: boolean) => ({
    type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}),
  });

  const tools = async (args: string[] = [], session: string = TOOLS_SESSION) => {
    const { exitCode, stdout } = await runCli(['tools', session, '--project', TOOLS_PROJECT, ...args], { HOME: TOOLS_HOME });
    return { exitCode, result: parseOutput(stdout) };
  };
  const rowsOf = (result: any): any[] => result.data.tool_calls;
  const rowById = (rows: any[], id: string) => rows.find(r => r.tool_use_id === id);

  beforeAll(() => {
    mkdirSync(TOOLS_CLAUDE_DIR, { recursive: true });
    writeFileSync(join(TOOLS_CLAUDE_DIR, `${TOOLS_SESSION}.jsonl`), [
      user(1, 'Investigate the worktree refusals'),
      // A tool_result written before its tool_use (result_turn < turn).
      user(2, [toolResult('early_bash', 'early ok')]),
      assistant(3, [
        null,
        use('Bash', 'err_a', { command: 'echo a' }),
        use('Bash', 'err_b', { command: 'echo b' }),
        use('Bash', 'err_c', { command: 'echo c' }),
        use('Bash', 'err_d', { command: 'echo d' }),
        use('Bash', 'img_err', { command: 'echo image' }),
        use('Bash', 'no_result', { command: 'echo pending' }),
        use('Bash', undefined, { command: 'echo no id' }),
        use('Bash', 'malformed', { command: 123 }),
        use('Bash', 'early_bash', { command: 'echo early' }),
        use('Bash', 'long_ok', { command: 'echo long' }),
      ]),
      user(4, [
        toolResult('err_a', ERR_A, true),
        toolResult('err_b', ERR_B, true),
        toolResult('err_c', [{ type: 'text', text: ERR_C }], true),
        toolResult('err_d', ERR_D, true),
        toolResult('img_err', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], true),
        toolResult('malformed', 'ok'),
        toolResult('long_ok', LONG_OK),
      ]),
    ].join('\n') + '\n');

    const subDir = join(TOOLS_CLAUDE_DIR, TOOLS_SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `agent-${SUB_ID}.jsonl`), [
      user(1, 'Build it'),
      assistant(2, [use('Bash', 'sub_bash', { command: 'swift build' })]),
      user(3, [toolResult('sub_bash', SUB_ERR, true)]),
    ].join('\n') + '\n');
    writeFileSync(join(subDir, `agent-${SUB_ID}.meta.json`), JSON.stringify({ agentType: 'builder', description: 'Build subagent' }));

    // A null block beside the tool_result in the result turn: the documented follow-ups must still work.
    writeFileSync(join(TOOLS_CLAUDE_DIR, `${NULL_SESSION}.jsonl`), [
      user(1, 'Run it'),
      assistant(2, [use('Bash', 'null_err', { command: 'echo null' })]),
      user(3, [null, toolResult('null_err', NULL_ERR, true)]),
    ].join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(TOOLS_ROOT, { recursive: true, force: true });
  });

  test('tolerates malformed inputs and null blocks, and keeps the documented key order', async () => {
    const { exitCode, result } = await tools();
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    const rows = rowsOf(result);
    expect(rows.length).toBe(10);
    for (const row of rows) expect(Object.keys(row)).toEqual(KEY_ORDER);
    expect(rows.every((r: any) => !('raw_input' in r))).toBe(true);
    const malformed = rowById(rows, 'malformed');
    expect(malformed.input_summary).toBe('{"command":123}');
    expect(malformed.outcome).toBe('success');
  });

  test('distinct errors sharing a prefix get identical outcomes but different hashes', async () => {
    const rows = rowsOf((await tools()).result);
    const [a, b, c, d] = ['err_a', 'err_b', 'err_c', 'err_d'].map(id => rowById(rows, id));
    expect(ERR_A.length).toBe(ERR_B.length);
    expect(a.outcome).toBe(b.outcome);
    expect(a.outcome).toBe(`error: ${ERR_A.slice(0, 60)}...[truncated, ${ERR_A.length} chars]`);
    for (const row of [a, b, c, d]) {
      expect(row.outcome.startsWith(`error: ${ERR_A.slice(0, 60)}`)).toBe(true);
      expect(row.outcome).toMatch(MARKER_RE);
    }
    expect(d.outcome).toBe(`error: ${ERR_D.slice(0, 60)}...[truncated, ${ERR_D.length} chars]`);
    expect(a.outcome_hash).toBe(sha12(ERR_A));
    expect(b.outcome_hash).toBe(sha12(ERR_B));
    expect(c.outcome_hash).toBe(sha12(ERR_C));
    expect(d.outcome_hash).toBe(sha12(ERR_D));
    expect(a.outcome_hash).not.toBe(b.outcome_hash);
    expect(a.outcome_hash).toBe(c.outcome_hash);
    expect(new Set([a, b, c, d].map(r => r.outcome_hash)).size).toBe(3);
  });

  test('an error with no text hashes the empty string', async () => {
    const row = rowById(rowsOf((await tools()).result), 'img_err');
    expect(row.outcome).toBe('error: ');
    expect(row.outcome_hash).toBe('e3b0c44298fc');
  });

  test('handles point at the tool_result turn, including results written before their tool_use', async () => {
    const rows = rowsOf((await tools()).result);
    for (const id of ['err_a', 'err_b', 'err_c', 'err_d', 'img_err', 'malformed', 'long_ok']) {
      const row = rowById(rows, id);
      expect(row.tool_use_id).toBe(id);
      expect(row.turn).toBe(3);
      expect(row.result_turn).toBe(4);
    }
    const early = rowById(rows, 'early_bash');
    expect(early.turn).toBe(3);
    expect(early.result_turn).toBe(2);
    expect(early.result_turn).toBeLessThan(early.turn);
    expect(early.duration_ms).toBeNull();
    expect(early.outcome).toBe('success');
  });

  test('rows without a result or an id carry null handles and a null hash', async () => {
    const rows = rowsOf((await tools()).result);
    const pending = rowById(rows, 'no_result');
    expect(pending).toMatchObject({ outcome: 'no_result', outcome_hash: null, result_turn: null, tool_use_id: 'no_result' });
    const idless = rows.find(r => r.tool_use_id === null);
    expect(idless).toBeDefined();
    expect(idless.input_summary).toBe('echo no id');
    expect(idless.outcome).toBe('no_result');
    expect(idless.outcome_hash).toBeNull();
    expect(idless.result_turn).toBeNull();
    expect(rowById(rows, 'long_ok').outcome_hash).toBeNull();
  });

  test('outcome_hash is non-null exactly for error outcomes', async () => {
    for (const row of rowsOf((await tools()).result)) {
      expect(row.outcome_hash !== null).toBe(row.outcome.startsWith('error:'));
    }
  });

  test('--failed returns exactly the error rows', async () => {
    const rows = rowsOf((await tools(['--failed'])).result);
    expect(rows.map(r => r.tool_use_id)).toEqual(['err_a', 'err_b', 'err_c', 'err_d', 'img_err']);
  });

  test('messages round trip with the marker budget returns the full text that hashes to outcome_hash', async () => {
    const rows = rowsOf((await tools()).result);
    for (const id of ['err_a', 'err_b', 'err_d']) {
      const row = rowById(rows, id);
      const budget = Number(row.outcome.match(MARKER_RE)![1]);
      const { stdout } = await runCli([
        'messages', TOOLS_SESSION, '--project', TOOLS_PROJECT,
        '--turn', String(row.result_turn), '--type', 'tool_result', '--max-tool-result', String(budget),
      ], { HOME: TOOLS_HOME });
      const messages = parseOutput(stdout);
      expect(messages.ok).toBe(true);
      const block = messages.data.messages[0].content.find((b: any) => b.tool_use_id === row.tool_use_id);
      expect(block).toBeDefined();
      expect(block.content).not.toMatch(/\[truncated/);
      expect(sha12(block.content)).toBe(row.outcome_hash);
    }
  });

  test('subagent round trip reuses the exact selector', async () => {
    const selector = `${TOOLS_SESSION}:${SUB_ID}`;
    const { exitCode, result } = await tools([], selector);
    expect(exitCode).toBe(0);
    expect(result.data.agent_id).toBe(SUB_ID);
    const rows = rowsOf(result);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(Object.keys(row)).toEqual(KEY_ORDER);
    expect(row.tool_use_id).toBe('sub_bash');
    expect(row.turn).toBe(2);
    expect(row.result_turn).toBe(3);
    expect(row.outcome).toBe(`error: ${SUB_ERR.slice(0, 60)}...[truncated, ${SUB_ERR.length} chars]`);
    const budget = Number(row.outcome.match(MARKER_RE)![1]);
    const { stdout } = await runCli([
      'messages', selector, '--project', TOOLS_PROJECT,
      '--turn', String(row.result_turn), '--type', 'tool_result', '--max-tool-result', String(budget),
    ], { HOME: TOOLS_HOME });
    const messages = parseOutput(stdout);
    expect(messages.data.agent_id).toBe(SUB_ID);
    const block = messages.data.messages[0].content.find((b: any) => b.tool_use_id === row.tool_use_id);
    expect(block.content).toBe(SUB_ERR);
    expect(sha12(block.content)).toBe(row.outcome_hash);
  });

  test('messages and slice --max-content follow-ups tolerate a null block in the result turn', async () => {
    const { exitCode, result } = await tools([], NULL_SESSION);
    expect(exitCode).toBe(0);
    const row = rowById(rowsOf(result), 'null_err');
    expect(row.result_turn).toBe(3);
    const budget = Number(row.outcome.match(MARKER_RE)![1]);

    const typed = await runCli([
      'messages', NULL_SESSION, '--project', TOOLS_PROJECT,
      '--turn', String(row.result_turn), '--type', 'tool_result', '--max-tool-result', String(budget),
    ], { HOME: TOOLS_HOME });
    expect(typed.exitCode).toBe(0);
    const block = parseOutput(typed.stdout).data.messages[0].content.find((b: any) => b.tool_use_id === 'null_err');
    expect(block.content).toBe(NULL_ERR);
    expect(sha12(block.content)).toBe(row.outcome_hash);

    const untyped = await runCli([
      'messages', NULL_SESSION, '--project', TOOLS_PROJECT, '--turn', String(row.result_turn),
    ], { HOME: TOOLS_HOME });
    expect(untyped.exitCode).toBe(0);
    expect(parseOutput(untyped.stdout).data.messages[0].content.map((b: any) => b.type)).toEqual(['unknown', 'tool_result']);

    const sliced = await runCli([
      'slice', NULL_SESSION, '--project', TOOLS_PROJECT, '--turn', String(row.result_turn), '--max-content', '10',
    ], { HOME: TOOLS_HOME });
    expect(sliced.exitCode).toBe(0);
    const content = parseOutput(sliced.stdout).data.entries[0].message.content;
    expect(content[0]).toBeNull();
    expect(content[1].content).toBe(`${NULL_ERR.slice(0, 10)}...[truncated, ${NULL_ERR.length} chars]`);
  });

  test('slice fallback returns the untruncated result for a row without a marker', async () => {
    const row = rowById(rowsOf((await tools()).result), 'long_ok');
    expect(row.outcome).toBe('success (2 lines)');
    expect(row.outcome).not.toMatch(MARKER_RE);
    expect(LONG_OK.length).toBeGreaterThan(200);
    const { stdout } = await runCli([
      'slice', TOOLS_SESSION, '--project', TOOLS_PROJECT, '--turn', String(row.result_turn),
    ], { HOME: TOOLS_HOME });
    const sliced = parseOutput(stdout);
    expect(sliced.ok).toBe(true);
    const block = sliced.data.entries[0].message.content.find((b: any) => b.tool_use_id === row.tool_use_id);
    expect(block).toBeDefined();
    expect(block.content).toBe(LONG_OK);
  });

  test('--max-outcome 300 reveals the distinguishing clauses without changing outcome_hash', async () => {
    const defaults = rowsOf((await tools()).result);
    const { exitCode, result } = await tools(['--max-outcome', '300']);
    expect(exitCode).toBe(0);
    const rows = rowsOf(result);
    for (const [id, text] of [['err_a', ERR_A], ['err_b', ERR_B], ['err_c', ERR_C], ['err_d', ERR_D]] as const) {
      const row = rowById(rows, id);
      expect(row.outcome).toBe(`error: ${text}`);
      expect(row.outcome_hash).toBe(rowById(defaults, id).outcome_hash);
      expect(row.outcome_hash).toBe(sha12(text));
    }
    expect(rowById(rows, 'err_a').outcome).not.toBe(rowById(rows, 'err_b').outcome);
    expect(rowById(rows, 'long_ok').outcome).toBe('success (2 lines)');
  });

  test('--max-outcome 0 keeps only the error prefix and the marker', async () => {
    const { result } = await tools(['--max-outcome', '0']);
    const row = rowById(rowsOf(result), 'err_a');
    expect(row.outcome).toBe(`error: ...[truncated, ${ERR_A.length} chars]`);
    expect(row.outcome_hash).toBe(sha12(ERR_A));
    expect(rowById(rowsOf(result), 'img_err').outcome).toBe('error: ');
    const failed = rowsOf((await tools(['--max-outcome', '0', '--failed'])).result);
    expect(failed.map(r => r.tool_use_id)).toEqual(['err_a', 'err_b', 'err_c', 'err_d', 'img_err']);
  });

  test('--max-outcome at or above the text length leaves the outcome without a marker', async () => {
    const { result } = await tools([`--max-outcome=${ERR_A.length}`]);
    expect(rowById(rowsOf(result), 'err_a').outcome).toBe(`error: ${ERR_A}`);
  });

  test.each([
    ['abc', ['--max-outcome', 'abc']],
    ['-1', ['--max-outcome', '-1']],
    ['=-1', ['--max-outcome=-1']],
  ])('--max-outcome %s is rejected with INVALID_ARGS', async (_label, flagArgs) => {
    const { exitCode, stdout } = await runCli(['tools', TOOLS_SESSION, '--project', TOOLS_PROJECT, ...flagArgs], { HOME: TOOLS_HOME });
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--max-outcome');
  });

  test('--max-outcome is validated before the session is resolved', async () => {
    const { exitCode, stdout } = await runCli(
      ['tools', 'no-such-session', '--project', TOOLS_PROJECT, '--max-outcome', 'abc'],
      { HOME: TOOLS_HOME },
    );
    expect(exitCode).toBe(2);
    expect(parseOutput(stdout).error.code).toBe('INVALID_ARGS');
  });
});
