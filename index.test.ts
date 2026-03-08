import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ERROR_CODES, success, failure,
  parseTurnRange, truncateContent, inputSummary, determineOutcome, parseIntArg,
  resolveClaudeProjectDir,
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
  return JSON.parse(stdout);
}

describe('list integration', () => {
  test('lists sessions in fixture dir', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].session_id).toBe(SESSION_ID);
    expect(result.data[0].branch).toBe('main');
    expect(result.data[0].slug).toBe('test-slug-fixture');
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

  test('resolves session by slug', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'test-slug-fixture', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.data.session_id).toBe(SESSION_ID);
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

describe('error cases', () => {
  test('invalid session ID characters', async () => {
    const { exitCode, stdout } = await runCli(['shape', '../etc/passwd', '--project', FAKE_PROJECT]);
    expect(exitCode).not.toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ID');
  });

  test('non-existent session', async () => {
    const { exitCode, stdout } = await runCli(['shape', 'nonexistent-session-id', '--project', FAKE_PROJECT]);
    expect(exitCode).not.toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  test('non-existent project dir', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project', '/tmp/nonexistent-project-12345']);
    expect(exitCode).not.toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
