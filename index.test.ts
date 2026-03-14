import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ERROR_CODES, success, failure, CliError, isCliError,
  parseTurnRange, truncateContent, inputSummary, determineOutcome, parseIntArg,
  extractFilePath, parseSince, buildResultLookup, extractSessionMetadata,
  resolveClaudeProjectDir, resolveSessionFile, resolveSession, parseSessionLines, userAssistantEntries,
} from './index.ts';

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

  test('Bash truncates to 80 chars', () => {
    const cmd = 'x'.repeat(100);
    expect(inputSummary('Bash', { command: cmd })).toBe('x'.repeat(80));
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
});

// ============================================================================
// parseIntArg
// ============================================================================

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

// ============================================================================
// resolveClaudeProjectDir (string logic only)
// ============================================================================

describe('resolveClaudeProjectDir', () => {
  test('throws NOT_FOUND for non-existent path', () => {
    expect(() => resolveClaudeProjectDir('/nonexistent/path/12345')).toThrow('not found');
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

const FIXTURE_DIR = join(tmpdir(), `cc-session-test-${Date.now()}`);
const FAKE_PROJECT = join(FIXTURE_DIR, 'fake-project');
// Compute the Claude dir path for our fake project
const fakeDirName = '-' + FAKE_PROJECT.slice(1).replace(/\//g, '-');
const CLAUDE_DIR = join(
  process.env.HOME ?? tmpdir(),
  '.claude', 'projects', fakeDirName,
);

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID_2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const SESSION_ID_3 = 'cccccccc-1111-2222-3333-444444444444';
const SESSION_ID_4 = 'dddddddd-1111-2222-3333-444444444444';

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
      message: {
        role: 'assistant',
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
          { type: 'tool_use', name: 'Edit', id: 'tool_2', input: { file_path: '/a/b/hello.ts', old_string: 'old', new_string: 'new' } },
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

beforeAll(() => {
  mkdirSync(FAKE_PROJECT, { recursive: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const lines = makeFixtureLines();
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
  // Second fixture with same slug for ambiguous slug tests
  const lines2 = [
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID_2,
      timestamp: '2026-03-02T10:00:00.000Z',
      gitBranch: 'feature',
      version: '2.1.0',
      slug: 'test-slug-fixture',
      message: { role: 'user', content: 'Second session' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-02T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Response from second session' }],
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
      message: { role: 'user', content: 'Test multi-block' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-03-03T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Considering the approach...' },
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
      message: { role: 'user', content: 'Install express' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-03-04T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tool_bash_1', input: { command: 'npm install express' } },
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
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const proc = Bun.spawn(['bun', 'run', 'index.ts', ...args], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    resolve({ exitCode, stdout, stderr });
  });
}

function parseOutput(stdout: string) {
  try { return JSON.parse(stdout); }
  catch (e) { throw new Error(`Failed to parse CLI output: ${stdout.slice(0, 500)}\n${e}`); }
}

describe('list integration', () => {
  test('lists sessions in fixture dir', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(4);
    const session1 = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(session1).toBeDefined();
    expect(session1.branch).toBe('main');
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
    expect(result.data[0].session_id).toBe(SESSION_ID_4); // newest (2026-03-04)
    expect(result._meta.total).toBe(4);
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
    expect(result.data.length).toBe(4);
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
    expect(result.data.length).toBe(4);
  });

  test('--since and --after together returns error', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT, '--since', '1d', '--after', '2026-03-01']);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('mutually exclusive');
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

  test('ambiguous slug returns error', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'test-slug-fixture', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ID');
    expect(result.error.message).toContain('Ambiguous slug');
  });
});

describe('tools integration', () => {
  test('returns all tool calls', async () => {
    const { stdout } = await runCli(['tools', SESSION_ID, '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
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
    expect(result.data.length).toBe(6);
  });

  test('filters by role', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--role', 'user']);
    const result = parseOutput(stdout);
    expect(result.data.every((m: any) => m.role === 'user')).toBe(true);
    expect(result.data.length).toBe(3);
  });

  test('filters by type', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--type', 'tool_use']);
    const result = parseOutput(stdout);
    for (const msg of result.data) {
      expect(msg.content.every((b: any) => b.type === 'tool_use')).toBe(true);
    }
  });

  test('filters by turn range', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-2']);
    const result = parseOutput(stdout);
    expect(result.data.length).toBe(2);
    expect(result.data[0].n).toBe(1);
    expect(result.data[1].n).toBe(2);
  });

  test('truncates content', async () => {
    const { stdout } = await runCli(['messages', SESSION_ID, '--project', FAKE_PROJECT, '--max-content', '10']);
    const result = parseOutput(stdout);
    const userMsg = result.data.find((m: any) => m.n === 1);
    expect(userMsg.content[0].text).toContain('...[truncated,');
  });
});

describe('slice integration', () => {
  test('returns entries for turn range', async () => {
    const { stdout } = await runCli(['slice', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '1-2']);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(2);
    expect(result.data[0].type).toBe('user');
    expect(result.data[1].type).toBe('assistant');
  });

  test('truncates content with max-content', async () => {
    const { stdout } = await runCli(['slice', SESSION_ID, '--project', FAKE_PROJECT, '--turn', '2', '--max-content', '10']);
    const result = parseOutput(stdout);
    expect(result.data.length).toBe(1);
    const blocks = result.data[0].message.content;
    const thinking = blocks.find((b: any) => b.type === 'thinking');
    expect(thinking.thinking).toContain('...[truncated,');
  });
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
// parseSessionLines
// ============================================================================

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
    expect(result).toBe(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`));
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
});

// ============================================================================
// resolveSession
// ============================================================================

describe('resolveSession', () => {
  test('returns sessionId and filtered entries', async () => {
    const result = await resolveSession({ session: SESSION_ID, project: FAKE_PROJECT });
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every(e => e.type === 'user' || e.type === 'assistant')).toBe(true);
  });

  test('throws NOT_FOUND for non-existent session', async () => {
    try {
      await resolveSession({ session: 'zzzzzzzz-0000-0000-0000-000000000000', project: FAKE_PROJECT });
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
    expect(meta).toEqual({ branch: 'main', timestamp: '2025-01-01T00:00:00Z', version: '1.0', slug: null });
  });

  test('returns all nulls when no sessionId in first 5 lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `msg${i}` } }));
    const meta = extractSessionMetadata(lines.join('\n'));
    expect(meta).toEqual({ branch: null, timestamp: null, version: null, slug: null });
  });

  test('finds slug deeper in text via regex', () => {
    const header = JSON.stringify({ type: 'system', sessionId: 's1', gitBranch: 'dev', timestamp: '2025-01-01T00:00:00Z' });
    const filler = Array.from({ length: 10 }, () => JSON.stringify({ type: 'user', message: { content: 'hi' } }));
    const slugLine = JSON.stringify({ type: 'assistant', slug: 'my-cool-slug' });
    const text = [header, ...filler, slugLine].join('\n');
    const meta = extractSessionMetadata(text);
    expect(meta.slug).toBe('my-cool-slug');
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

  test('--text "different approach" finds session (matches assistant text block)', async () => {
    const { stdout } = await runCli(['search', '--text', 'different approach', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
  });

  test('--text "think about this carefully" finds session (matches thinking block)', async () => {
    const { stdout } = await runCli(['search', '--text', 'think about this carefully', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
  });

  test('--bash "npm install" finds Bash fixture session', async () => {
    const { stdout } = await runCli(['search', '--bash', 'npm install', '--project', FAKE_PROJECT]);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(match).toBeDefined();
    expect(match.matches.turns.length).toBeGreaterThanOrEqual(1);
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
