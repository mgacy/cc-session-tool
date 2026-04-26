import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ERROR_CODES, success, failure, CliError, isCliError,
  parseTurnRange, truncateContent, inputSummary, determineOutcome, parseIntArg,
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
  scanSearchTarget,
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
    const unique = `cc-session-tool-project-refs-${Date.now()}`;
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

  test('findRelatedProjectRefs returns both raw worktree project-name shapes under the project path', () => {
    const projectPath = '/Users/matt/repo';
    const worktreesDirProject = mangleProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a'));
    const doubleDashProject = `${mangleProjectPath(projectPath)}--claude-worktrees-feature-b`;
    const refs = [
      {
        project: worktreesDirProject,
        claude_dir: `/tmp/claude/projects/${worktreesDirProject}`,
        project_path_guess: '/Users/matt/repo/.claude/worktrees/feature/a',
      },
      {
        project: doubleDashProject,
        claude_dir: `/tmp/claude/projects/${doubleDashProject}`,
        project_path_guess: projectPathGuessFromClaudeProject(doubleDashProject),
      },
      {
        project: doubleDashProject,
        claude_dir: `/tmp/claude/projects/${doubleDashProject}-duplicate`,
        project_path_guess: projectPathGuessFromClaudeProject(doubleDashProject),
      },
      {
        project: '-Users-matt-repo-other',
        claude_dir: '/tmp/claude/projects/-Users-matt-repo-other',
        project_path_guess: '/Users/matt/repo/other',
      },
      {
        project: 'not-mangled',
        claude_dir: '/tmp/claude/projects/not-mangled',
        project_path_guess: null,
      },
    ];

    expect(findRelatedProjectRefs('/Users/matt/repo/', refs)).toEqual([refs[0]!, refs[1]!]);
  });

  test('findRelatedProjectRefs handles hyphenated project paths without relying on path guesses', () => {
    const projectPath = '/Users/matt/Developer/cc-session-tool/cc-session-tool';
    const relatedProject = mangleProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a'));
    const relatedDoubleDashProject = `${mangleProjectPath(projectPath)}--claude-worktrees-feature-b`;
    const siblingProject = mangleProjectPath('/Users/matt/Developer/cc-session-tool/other');
    const similarPrefixProject = `${mangleProjectPath(`${projectPath}-other`)}--claude-worktrees-feature-c`;
    const refs = [
      {
        project: relatedProject,
        claude_dir: join('/tmp/claude/projects', relatedProject),
        project_path_guess: projectPathGuessFromClaudeProject(relatedProject),
      },
      {
        project: relatedDoubleDashProject,
        claude_dir: join('/tmp/claude/projects', relatedDoubleDashProject),
        project_path_guess: projectPathGuessFromClaudeProject(relatedDoubleDashProject),
      },
      {
        project: siblingProject,
        claude_dir: join('/tmp/claude/projects', siblingProject),
        project_path_guess: projectPathGuessFromClaudeProject(siblingProject),
      },
      {
        project: similarPrefixProject,
        claude_dir: join('/tmp/claude/projects', similarPrefixProject),
        project_path_guess: projectPathGuessFromClaudeProject(similarPrefixProject),
      },
    ];

    expect(refs[0]!.project_path_guess).not.toStartWith(`${projectPath}/.claude/worktrees/`);
    expect(refs[1]!.project_path_guess).not.toStartWith(`${projectPath}/.claude/worktrees/`);
    expect(findRelatedProjectRefs(projectPath, refs)).toEqual([refs[0]!, refs[1]!]);
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
    const unique = `cc-session-tool-scope-main-${Date.now()}`;
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'repo');
    const claudeDir = join(root, mangleProjectPath(projectPath));
    const worktreeProject = mangleProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a'));

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
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('buildScopedSearchScope includes both related hyphenated worktree refs without reverse-mangling', () => {
    const unique = `cc-session-tool-scope-worktree-${Date.now()}`;
    const root = join(tmpdir(), unique, '.claude', 'projects');
    const projectPath = join(tmpdir(), unique, 'cc-session-tool', 'cc-session-tool');
    const mainProject = mangleProjectPath(projectPath);
    const worktreeProject = mangleProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a'));
    const doubleDashWorktreeProject = `${mangleProjectPath(projectPath)}--claude-worktrees-feature-b`;
    const siblingProject = mangleProjectPath(join(tmpdir(), unique, 'cc-session-tool-other'));

    mkdirSync(join(root, mainProject), { recursive: true });
    mkdirSync(join(root, worktreeProject), { recursive: true });
    mkdirSync(join(root, doubleDashWorktreeProject), { recursive: true });
    mkdirSync(join(root, siblingProject), { recursive: true });

    try {
      const scope = buildScopedSearchScope({ projectPath, claudeProjectsRoot: root, includeWorktrees: true });
      expect(scope.projects.map(context => context.role)).toEqual(['main', 'worktree', 'worktree']);
      expect(scope.projects[1]!.projectRef.project).toBe(doubleDashWorktreeProject);
      expect(scope.projects[1]!.projectRef.project_path_guess).toBe(projectPathGuessFromClaudeProject(doubleDashWorktreeProject));
      expect(scope.projects[1]!.worktreeRoot).toBeNull();
      expect(scope.projects[2]!.projectRef.project).toBe(worktreeProject);
      expect(scope.projects[2]!.projectRef.project_path_guess).toBe(projectPathGuessFromClaudeProject(worktreeProject));
      expect(scope.projects[2]!.worktreeRoot).toBeNull();
    } finally {
      rmSync(join(tmpdir(), unique), { recursive: true, force: true });
    }
  });

  test('buildScopedSearchScope tolerates a missing Claude projects root after main project resolves', () => {
    const unique = `cc-session-tool-scope-missing-root-${Date.now()}`;
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
    const unique = `cc-session-tool-target-context-${Date.now()}`;
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
        claude_dir: join(tmpdir(), `cc-session-tool-missing-${Date.now()}`),
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
    const unique = `cc-session-tool-selection-${Date.now()}`;
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
      expect(selection.includedProjects).toEqual([{
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
    const unique = `cc-session-tool-realpath-${Date.now()}`;
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
    const unique = `cc-session-tool-canonical-${Date.now()}`;
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
    const unique = `cc-session-tool-resolve-root-${Date.now()}`;
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
    const unique = `cc-session-tool-resolve-trailing-${Date.now()}`;
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

const FIXTURE_DIR = join(tmpdir(), `cc-session-test-${Date.now()}`);
const FIXTURE_HOME = join(FIXTURE_DIR, 'home');
const FIXTURE_CLAUDE_PROJECTS_ROOT = claudeProjectsRoot(FIXTURE_HOME);
const FAKE_PROJECT = join(FIXTURE_DIR, 'fake-project');
const SECOND_FAKE_PROJECT = join(FIXTURE_DIR, 'fake-project-worktree');
const RELATED_PROJECT = join(tmpdir(), `ccsessionrelated${Date.now()}`);
const RELATED_WORKTREE_ROOT = join(RELATED_PROJECT, '.claude', 'worktrees', 'feature');
const fakeDirName = mangleProjectPath(FAKE_PROJECT);
const secondFakeDirName = mangleProjectPath(SECOND_FAKE_PROJECT);
const relatedDirName = mangleProjectPath(RELATED_PROJECT);
const relatedWorktreeDirName = mangleProjectPath(RELATED_WORKTREE_ROOT);
const relatedDoubleDashWorktreeDirName = `${mangleProjectPath(RELATED_PROJECT)}--claude-worktrees-feature`;
const CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  fakeDirName,
);
const SECOND_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  secondFakeDirName,
);
const RELATED_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedDirName,
);
const RELATED_WORKTREE_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedWorktreeDirName,
);
const RELATED_DOUBLE_DASH_WORKTREE_CLAUDE_DIR = join(
  FIXTURE_CLAUDE_PROJECTS_ROOT,
  relatedDoubleDashWorktreeDirName,
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
  mkdirSync(RELATED_PROJECT, { recursive: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  mkdirSync(SECOND_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_WORKTREE_CLAUDE_DIR, { recursive: true });
  mkdirSync(RELATED_DOUBLE_DASH_WORKTREE_CLAUDE_DIR, { recursive: true });
  const lines = makeFixtureLines();
  writeFileSync(join(CLAUDE_DIR, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');

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
      message: { role: 'user', content: 'Second session' },
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
          { type: 'tool_use', name: 'Bash', id: 'tool_bash_1', input: { command: `npm install express ${'x'.repeat(90)} raw-bash-marker-after-summary` } },
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
  rmSync(RELATED_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(RELATED_WORKTREE_CLAUDE_DIR, { recursive: true, force: true });
  rmSync(RELATED_DOUBLE_DASH_WORKTREE_CLAUDE_DIR, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const proc = Bun.spawn(['bun', 'run', 'index.ts', ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: FIXTURE_HOME },
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

describe('scanSearchTarget', () => {
  test('no-context file filters require a matching raw file access', async () => {
    const unique = `cc-session-tool-no-context-search-${Date.now()}`;
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

  test('--all-projects lists sessions with project metadata', async () => {
    const { exitCode, stdout } = await runCli(['list', '--all-projects']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBeGreaterThanOrEqual(4);
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
    const { exitCode, stdout } = await runCli(['list', '--all-projects', '--project-glob', '*fake-project-worktree']);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
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

  test('list --project-glob without --all-projects returns invalid args', async () => {
    const { exitCode, stdout } = await runCli(['list', '--project-glob', '*fake*', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(2);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('--project-glob requires --all-projects');
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

  test('search --all-projects --project-glob filters selected and skipped projects', async () => {
    const { exitCode, stdout } = await runCli(['search', '--all-projects', '--project-glob', '*fake-project-worktree', '--file', CROSS_PROJECT_FILE]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result._meta.projects_scanned).toBe(1);
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
    const { exitCode, stdout } = await runCli(['search', '--file', RELATED_PROJECT_FILE, '--project', RELATED_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.find((s: any) => s.session_id === SESSION_ID_7)).toBeDefined();
    expect(result._meta.included_projects).toEqual([
      {
        project: relatedDirName,
        project_path_guess: RELATED_PROJECT,
        project_role: 'main',
      },
      {
        project: relatedDoubleDashWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedDoubleDashWorktreeDirName),
        project_role: 'worktree',
      },
      {
        project: relatedWorktreeDirName,
        project_path_guess: projectPathGuessFromClaudeProject(relatedWorktreeDirName),
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
    expect(writer.matches.file_evidence).toEqual([{
      rawPath: join(RELATED_WORKTREE_ROOT, RELATED_PROJECT_FILE),
      logicalPath: RELATED_PROJECT_FILE,
      operation: 'write',
      turn: 2,
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
    expect(result.data[0].matches.file_evidence[0]).toMatchObject({
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
    const { exitCode, stdout } = await runCli(['search', '--file', join(RELATED_PROJECT, RELATED_PROJECT_FILE), '--origin', '--text', 'response', '--project', RELATED_PROJECT]);
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

  test('--input-match searches raw Bash commands beyond input summary truncation', async () => {
    const { exitCode, stdout } = await runCli(['search', '--tool', 'Bash', '--input-match', 'raw-bash-marker-after-summary', '--project', FAKE_PROJECT]);
    expect(exitCode).toBe(0);
    const result = parseOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.map((s: any) => s.session_id)).toContain(SESSION_ID_4);
    const match = result.data.find((s: any) => s.session_id === SESSION_ID_4);
    expect(match.matches.tools).toEqual(['Bash']);
    expect(match.matches.tool_inputs).toEqual([{
      tool: 'Bash',
      input_summary: expect.not.stringContaining('raw-bash-marker-after-summary'),
      turn: 2,
    }]);
  });

  test('--input-match searches raw file paths and content fields', async () => {
    const editResult = parseOutput((await runCli(['search', '--tool', 'Edit', '--input-match', 'legacy raw old marker', '--project', FAKE_PROJECT])).stdout);
    expect(editResult.ok).toBe(true);
    expect(editResult.data.map((s: any) => s.session_id)).toContain(SESSION_ID);
    expect(editResult.data.find((s: any) => s.session_id === SESSION_ID).matches.tool_inputs[0]).toEqual({
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
    expect(result.data[0].matches.tool_inputs).toEqual([{
      tool: 'TodoWrite',
      input_summary: expect.stringContaining('stable json audit marker'),
      turn: 2,
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

  test('--aggregate rejects invalid usage', async () => {
    const withoutToolInput = parseOutput((await runCli(['search', '--file', 'hello.ts', '--aggregate', 'count-per-session', '--project', FAKE_PROJECT])).stdout);
    expect(withoutToolInput.ok).toBe(false);
    expect(withoutToolInput.error.code).toBe('INVALID_ARGS');
    expect(withoutToolInput.error.message).toContain('--aggregate requires --tool or --input-match');

    const invalidMode = parseOutput((await runCli(['search', '--tool', 'Read', '--aggregate', 'totals', '--project', FAKE_PROJECT])).stdout);
    expect(invalidMode.ok).toBe(false);
    expect(invalidMode.error.code).toBe('INVALID_ARGS');
    expect(invalidMode.error.message).toContain('--aggregate must be count-per-session');
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
