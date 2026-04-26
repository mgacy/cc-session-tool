#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import { homedir } from 'os';
import { join, basename, dirname, resolve, relative, isAbsolute } from 'path';
import { readdirSync, existsSync, realpathSync } from 'fs';

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
  subagent_count?: number;
  project?: string;
  project_path_guess?: string | null;
  project_role?: SearchProjectRole;
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
  agent_id: string | null;
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
  agent_id: string | null;
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
  agent_id: string | null;
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

export type ProjectRef = {
  project: string;
  claude_dir: string;
  project_path_guess: string | null;
};

export type SearchOperation = FileAccess['operation'];

export type SearchProjectRole = 'main' | 'worktree' | 'global';

export type PublicProjectRef = {
  project: string;
  project_path_guess: string | null;
  project_role: SearchProjectRole;
};

export type SearchProjectContext = {
  role: SearchProjectRole;
  projectRoot: string | null;
  worktreeRoot: string | null;
  queryAnchorRoot?: string | null;
  projectRef: ProjectRef;
};

export type SearchSessionContext = SearchProjectContext & {
  sessionCwd: string | null;
  worktreeStateOriginalCwd: string | null;
  worktreeStateWorktreePath: string | null;
  queryAnchorRoot: string | null;
  normalizedProjectRoots: string[];
  normalizedWorktreeRoots: string[];
  pathCandidateCache: Map<string, string[]>;
};

export type WorktreeStatePaths = {
  originalCwd: string | null;
  worktreePath: string | null;
};

export type NormalizedFileQuery = {
  raw: string;
  rawLower: string;
  logicalPath: string | null;
  absoluteCandidates: string[];
};

export type NormalizedFileAccess = {
  rawPath: string;
  operation: SearchOperation;
  logicalPath: string | null;
  absoluteCandidates: string[];
};

export type FileMatchKind = 'canonical' | 'logical' | 'substring';

export type FileMatchResult = {
  matched: boolean;
  matchedBy: FileMatchKind;
  logicalPath: string | null;
};

export type FileMatchEvidence = {
  rawPath: string;
  logicalPath: string | null;
  operation: SearchOperation;
  turn: number;
  timestamp: string | null;
};

export type FileEntry = {
  path: string;
  operations: string[];
  turns: number[];
  errored: boolean;
};

export type FilesResult = {
  session_id: string;
  agent_id: string | null;
  group_by: 'file' | 'turn';
  files?: FileEntry[];
  accesses?: FileAccess[];
};

export type ResolvedFile = {
  filePath: string;
  sessionId: string;      // parent session UUID
  agentId: string | null;  // non-null when targeting a subagent
};

export type MessagesResult = {
  session_id: string;
  agent_id: string | null;
  messages: MessageEntry[];
};

export type SliceResult = {
  session_id: string;
  agent_id: string | null;
  entries: SessionEntry[];
};

export type SubagentInfo = {
  agent_id: string;
  agent_type: string | null;
  description: string | null;
  lines: number;
  timestamp: string | null;
};

export type SubagentsResult = {
  session_id: string;
  subagents: SubagentInfo[];
};

// SearchMatch intentionally omits agent_id — it operates at the session-listing level, not session-scoped.
export type SearchMatch = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  slug: string | null;
  project?: string;
  project_path_guess?: string | null;
  project_role?: SearchProjectRole;
  session_ref?: {
    session_id: string;
    project: string;
  };
  matches: {
    tools: string[];      // distinct tool names that matched --tool
    files: string[];      // distinct file paths that matched --file
    normalized_files?: string[];
    file_evidence?: FileMatchEvidence[];
    operations?: SearchOperation[];
    tool_inputs?: ToolInputMatch[];
    turns: number[];      // union of all turn numbers where any filter matched
  };
};

export type SearchSortMode = 'session-newest' | 'match-earliest' | 'match-newest' | 'project';
export type SearchAggregateMode = 'none' | 'count-per-session';

export type ToolInputMatch = {
  tool: string;
  input_summary: string;
  turn: number;
};

export type SearchAggregateResult = {
  session_id: string;
  branch: string | null;
  timestamp: string | null;
  slug: string | null;
  project?: string;
  project_path_guess?: string | null;
  project_role?: SearchProjectRole;
  counts: {
    tool_inputs: number;
  };
  sample_matches: ToolInputMatch[];
};

export type SearchMeta = ResponseMeta & {
  projects_scanned?: number;
  project?: string;
  related_projects?: ProjectRef[];
  included_projects?: PublicProjectRef[];
  skipped_projects?: PublicProjectRef[];
  warning?: string;
};

export type SearchArgs = {
  tool?: string;
  file?: string;
  text?: string;
  bash?: string;
  inputMatch?: string;
  branch?: string;
  after?: string;
  before?: string;
  since?: string;
  operation?: SearchOperation;
};

export type SearchTarget = {
  filePath: string;
  sessionId: string;
  context?: SearchProjectContext;
  projectRef?: ProjectRef;
};

export type SearchScopeOptions = {
  projectPath: string;
  claudeProjectsRoot?: string;
  includeWorktrees: boolean;
};

export type SearchScope = {
  projectRoot: string;
  projects: SearchProjectContext[];
};

export type ProjectSelectionMode = 'scoped' | 'scoped-with-worktrees' | 'all-projects';

export type ProjectSelectionOptions = {
  mode: ProjectSelectionMode;
  projectPath?: string;
  projectGlob?: string;
  claudeProjectsRoot?: string;
};

export type ProjectSelection = {
  contexts: SearchProjectContext[];
  includedProjects: PublicProjectRef[];
  skippedProjects: PublicProjectRef[];
};

export type SessionProjectSelector =
  | { kind: 'projectPath'; projectPath: string }
  | { kind: 'claudeProject'; project: string };

export type SearchScanResult = {
  matches: SearchMatch[];
};

export type ListMeta = ResponseMeta & {
  projects_scanned?: number;
  included_projects?: PublicProjectRef[];
  skipped_projects?: PublicProjectRef[];
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
const SEARCH_OPERATIONS: SearchOperation[] = ['read', 'edit', 'write', 'grep', 'glob'];
const SEARCH_SORT_MODES: SearchSortMode[] = ['session-newest', 'match-earliest', 'match-newest', 'project'];
const SEARCH_SCAN_CONCURRENCY = 50;

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
export function claudeProjectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects');
}

export function mangleProjectPath(projectPath: string): string {
  const normalized = normalizePathForContainment(projectPath);
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  return '-' + stripped.replace(/\//g, '-');
}

export function projectPathGuessFromClaudeProject(projectName: string): string | null {
  if (!projectName.startsWith('-')) return null;
  return '/' + projectName.slice(1).replace(/-/g, '/');
}

export function listClaudeProjectRefs(root = claudeProjectsRoot()): ProjectRef[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => ({
      project: d.name,
      claude_dir: join(root, d.name),
      project_path_guess: projectPathGuessFromClaudeProject(d.name),
    }));
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, '') || '/';
}

export function normalizePathForContainment(input: string): string {
  return stripTrailingSlashes(resolve(input));
}

export function isPathWithinOrEqual(pathname: string, root: string): boolean {
  const normalizedPath = normalizePathForContainment(pathname);
  const normalizedRoot = normalizePathForContainment(root);
  const rel = relative(normalizedRoot, normalizedPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function pathContainmentCandidates(pathname: string): string[] {
  const candidates = new Set<string>([normalizePathForContainment(pathname)]);
  try {
    candidates.add(normalizePathForContainment(realpathSync.native(pathname)));
  } catch {
    // Missing fixture paths are common in transcript tests; keep the lexical candidate.
  }
  let existingAncestor = normalizePathForContainment(pathname);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  if (existsSync(existingAncestor)) {
    try {
      candidates.add(normalizePathForContainment(join(realpathSync.native(existingAncestor), ...missingSegments)));
    } catch {
      // Keep the candidates collected so far.
    }
  }
  return Array.from(candidates);
}

function uniqueNormalizedCandidates(paths: Array<string | null | undefined>): string[] {
  const candidates = new Set<string>();
  for (const pathname of paths) {
    if (!pathname || !isAbsolute(pathname)) continue;
    for (const candidate of pathContainmentCandidates(pathname)) {
      candidates.add(candidate);
    }
  }
  return Array.from(candidates);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLogicalRelativePath(pathname: string): string {
  return pathname.split('/').filter(part => part.length > 0).join('/');
}

function logicalPathForAbsoluteCandidates(candidates: string[], roots: string[]): string | null {
  const orderedRoots = [...roots].sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    for (const root of orderedRoots) {
      if (!isPathWithinOrEqual(candidate, root)) continue;
      const rel = relative(root, candidate);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      return normalizeLogicalRelativePath(rel);
    }
  }
  return null;
}

export function absolutePathCandidatesFor(pathname: string, context: SearchSessionContext): string[] {
  if (!isAbsolute(pathname)) return [];
  const cached = context.pathCandidateCache.get(pathname);
  if (cached) return cached;
  const candidates = pathContainmentCandidates(pathname);
  context.pathCandidateCache.set(pathname, candidates);
  return candidates;
}

export function deriveWorktreeRootFromPath(projectRoot: string | null, pathname: string | null): string | null {
  if (!projectRoot || !pathname || !isAbsolute(pathname)) return null;

  for (const projectCandidate of pathContainmentCandidates(projectRoot)) {
    const worktreesRoot = normalizePathForContainment(join(projectCandidate, '.claude', 'worktrees'));
    for (const pathCandidate of pathContainmentCandidates(pathname)) {
      if (!isPathWithinOrEqual(pathCandidate, worktreesRoot)) continue;
      const rel = relative(worktreesRoot, pathCandidate);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      const [worktreeDir] = rel.split('/');
      if (!worktreeDir) continue;
      return normalizePathForContainment(join(worktreesRoot, worktreeDir));
    }
  }

  return null;
}

export function extractSessionCwd(entries: SessionEntry[]): string | null {
  for (const entry of entries) {
    if (typeof entry.cwd === 'string' && entry.cwd.trim()) return entry.cwd;
  }
  return null;
}

export function extractWorktreeStatePaths(entries: SessionEntry[]): WorktreeStatePaths {
  const paths: WorktreeStatePaths = { originalCwd: null, worktreePath: null };

  for (const entry of entries) {
    const record = entry as unknown as Record<string, unknown>;
    for (const key of ['worktree-state', 'worktreeState']) {
      const state = record[key];
      if (!isRecord(state)) continue;
      if (paths.originalCwd === null && typeof state.originalCwd === 'string' && state.originalCwd.trim()) {
        paths.originalCwd = state.originalCwd;
      }
      if (paths.worktreePath === null && typeof state.worktreePath === 'string' && state.worktreePath.trim()) {
        paths.worktreePath = state.worktreePath;
      }
    }
    if (paths.originalCwd !== null && paths.worktreePath !== null) break;
  }

  return paths;
}

function equivalentAbsolutePath(a: string | null, b: string | null): boolean {
  if (!a || !b || !isAbsolute(a) || !isAbsolute(b)) return false;
  const bCandidates = new Set(pathContainmentCandidates(b));
  return pathContainmentCandidates(a).some(candidate => bCandidates.has(candidate));
}

function acceptedProjectRoot(projectRoot: string | null, candidate: string | null): string | null {
  return equivalentAbsolutePath(projectRoot, candidate) ? candidate : null;
}

function acceptedWorktreeRoot(projectRoot: string | null, candidate: string | null): string | null {
  if (!projectRoot || !candidate || !isAbsolute(candidate)) return null;
  return deriveWorktreeRootFromPath(projectRoot, candidate);
}

export function collectObservedWorktreeRoots(entries: SessionEntry[], projectRoot: string | null): string[] {
  const observed = new Set<string>();
  if (!projectRoot) return [];

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const fileInfo = extractFilePath(block.name, block.input ?? {});
      if (!fileInfo || !isAbsolute(fileInfo.path)) continue;
      const worktreeRoot = acceptedWorktreeRoot(projectRoot, fileInfo.path);
      if (worktreeRoot) observed.add(worktreeRoot);
    }
  }

  return Array.from(observed);
}

export function buildSearchSessionContext(context: SearchProjectContext, entries: SessionEntry[]): SearchSessionContext {
  const sessionCwd = extractSessionCwd(entries);
  const worktreeStatePaths = extractWorktreeStatePaths(entries);
  const queryAnchorRoot = context.queryAnchorRoot ?? null;
  const identityRoot = context.projectRoot ?? queryAnchorRoot;
  const projectRootCandidates = [
    context.projectRoot,
    queryAnchorRoot,
    acceptedProjectRoot(identityRoot, sessionCwd),
    acceptedProjectRoot(identityRoot, worktreeStatePaths.originalCwd),
  ];
  const worktreeRootCandidates = [
    context.worktreeRoot,
    acceptedWorktreeRoot(identityRoot, sessionCwd),
    acceptedWorktreeRoot(identityRoot, worktreeStatePaths.originalCwd),
    acceptedWorktreeRoot(identityRoot, worktreeStatePaths.worktreePath),
    ...collectObservedWorktreeRoots(entries, identityRoot),
  ];
  return {
    ...context,
    sessionCwd,
    worktreeStateOriginalCwd: worktreeStatePaths.originalCwd,
    worktreeStateWorktreePath: worktreeStatePaths.worktreePath,
    queryAnchorRoot,
    normalizedProjectRoots: uniqueNormalizedCandidates(projectRootCandidates),
    normalizedWorktreeRoots: uniqueNormalizedCandidates(worktreeRootCandidates),
    pathCandidateCache: new Map<string, string[]>(),
  };
}

export function normalizeFileQuery(raw: string, context: SearchSessionContext): NormalizedFileQuery {
  const absoluteCandidates = absolutePathCandidatesFor(raw, context);
  const logicalPath = absoluteCandidates.length > 0
    ? logicalPathForAbsoluteCandidates(absoluteCandidates, context.normalizedProjectRoots)
    : null;
  return {
    raw,
    rawLower: raw.toLowerCase(),
    logicalPath,
    absoluteCandidates,
  };
}

export function normalizeFileAccess(
  rawPath: string,
  operation: SearchOperation,
  context: SearchSessionContext,
): NormalizedFileAccess {
  const identityRoot = context.projectRoot ?? context.queryAnchorRoot;
  const observedWorktreeRoot = deriveWorktreeRootFromPath(identityRoot, rawPath);
  const roots = [
    ...context.normalizedProjectRoots,
    ...context.normalizedWorktreeRoots,
    ...uniqueNormalizedCandidates([observedWorktreeRoot]),
  ];
  const absoluteCandidates = absolutePathCandidatesFor(rawPath, context);
  const logicalPath = absoluteCandidates.length > 0
    ? logicalPathForAbsoluteCandidates(absoluteCandidates, roots)
    : null;
  return { rawPath, operation, logicalPath, absoluteCandidates };
}

export function matchFileAccess(query: NormalizedFileQuery, access: NormalizedFileAccess): FileMatchResult {
  if (query.absoluteCandidates.length > 0 && access.absoluteCandidates.length > 0) {
    const accessCandidates = new Set(access.absoluteCandidates);
    if (query.absoluteCandidates.some(candidate => accessCandidates.has(candidate))) {
      return {
        matched: true,
        matchedBy: 'canonical',
        logicalPath: access.logicalPath ?? query.logicalPath,
      };
    }
  }

  if (query.logicalPath != null) {
    const matched = access.logicalPath === query.logicalPath;
    return {
      matched,
      matchedBy: 'logical',
      logicalPath: matched ? access.logicalPath : null,
    };
  }

  return {
    matched: access.rawPath.toLowerCase().includes(query.rawLower),
    matchedBy: 'substring',
    logicalPath: access.logicalPath,
  };
}

export function findRelatedProjectRefs(projectPath: string, refs: ProjectRef[]): ProjectRef[] {
  const normalizedProject = normalizePathForContainment(projectPath);
  const worktreesDirPrefix = `${mangleProjectPath(join(normalizedProject, '.claude', 'worktrees'))}-`;
  const doubleDashWorktreePrefix = `${mangleProjectPath(normalizedProject)}--claude-worktrees-`;
  const related: ProjectRef[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (!ref.project.startsWith(worktreesDirPrefix) && !ref.project.startsWith(doubleDashWorktreePrefix)) {
      continue;
    }
    if (seen.has(ref.project)) continue;
    seen.add(ref.project);
    related.push(ref);
  }

  return related;
}

export function buildScopedSearchScope(options: SearchScopeOptions): SearchScope {
  const projectRoot = normalizePathForContainment(options.projectPath);
  const root = options.claudeProjectsRoot ?? claudeProjectsRoot();
  const mainProjectRef: ProjectRef = {
    project: mangleProjectPath(options.projectPath),
    claude_dir: resolveClaudeProjectDir(options.projectPath, root),
    project_path_guess: options.projectPath,
  };
  const projects: SearchProjectContext[] = [{
    role: 'main',
    projectRoot: options.projectPath,
    worktreeRoot: null,
    projectRef: mainProjectRef,
  }];

  if (options.includeWorktrees) {
    for (const ref of findRelatedProjectRefs(options.projectPath, listClaudeProjectRefs(root))) {
      projects.push({
        role: 'worktree',
        projectRoot: options.projectPath,
        worktreeRoot: null,
        projectRef: ref,
      });
    }
  }

  return { projectRoot, projects };
}

function publicProjectRef(context: SearchProjectContext): PublicProjectRef {
  return {
    project: context.projectRef.project,
    project_path_guess: context.projectRef.project_path_guess,
    project_role: context.role,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

export function projectMatchesGlob(ref: ProjectRef, glob: string): boolean {
  return projectMatchesPattern(ref, globToRegExp(glob));
}

function projectMatchesPattern(ref: ProjectRef, regex: RegExp): boolean {
  return regex.test(ref.project) || Boolean(ref.project_path_guess && regex.test(ref.project_path_guess));
}

export function selectProjectContexts(options: ProjectSelectionOptions): ProjectSelection {
  const root = options.claudeProjectsRoot ?? claudeProjectsRoot();

  if (options.mode === 'all-projects') {
    const included: SearchProjectContext[] = [];
    const skipped: SearchProjectContext[] = [];
    const projectGlobRegex = options.projectGlob ? globToRegExp(options.projectGlob) : null;
    const queryAnchorRoot = options.projectPath ?? null;
    for (const projectRef of listClaudeProjectRefs(root)) {
      const context: SearchProjectContext = {
        role: 'global',
        projectRoot: null,
        worktreeRoot: null,
        queryAnchorRoot,
        projectRef,
      };
      if (projectGlobRegex && !projectMatchesPattern(projectRef, projectGlobRegex)) {
        skipped.push(context);
      } else {
        included.push(context);
      }
    }
    return {
      contexts: included,
      includedProjects: included.map(publicProjectRef),
      skippedProjects: skipped.map(publicProjectRef),
    };
  }

  const projectPath = options.projectPath || process.cwd();
  const scope = buildScopedSearchScope({
    projectPath,
    claudeProjectsRoot: root,
    includeWorktrees: options.mode === 'scoped-with-worktrees',
  });
  return {
    contexts: scope.projects,
    includedProjects: scope.projects.map(publicProjectRef),
    skippedProjects: [],
  };
}

export function resolveClaudeProjectDir(projectPath: string, root = claudeProjectsRoot()): string {
  const claudeDir = join(root, mangleProjectPath(projectPath));
  if (!existsSync(claudeDir)) {
    throw cliError('NOT_FOUND', `Claude project directory not found: ${claudeDir}`);
  }
  return claudeDir;
}

function validateClaudeProjectBasename(project: string): void {
  if (
    !project ||
    project === '.' ||
    project === '..' ||
    project.includes('/') ||
    project.includes('\\') ||
    basename(project) !== project
  ) {
    throw cliError('INVALID_ARGS', '--claude-project must be a Claude project directory basename');
  }
}

function readRawStringOption(name: string): string | undefined {
  const longName = `--${name}`;
  const withEquals = `${longName}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg.startsWith(withEquals)) {
      return arg.slice(withEquals.length);
    }
    if (arg === longName) {
      const value = process.argv[i + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
  }
  return undefined;
}

export function resolveClaudeProjectDirFromSelector(
  selector: SessionProjectSelector,
  root = claudeProjectsRoot(),
): string {
  if (selector.kind === 'projectPath') {
    return resolveClaudeProjectDir(selector.projectPath, root);
  }

  validateClaudeProjectBasename(selector.project);
  const claudeDir = join(root, selector.project);
  if (!existsSync(claudeDir)) {
    throw cliError('NOT_FOUND', `Claude project directory not found: ${claudeDir}`);
  }
  return claudeDir;
}

function sessionProjectSelectorFromArgs(args: {
  project?: string;
  'claude-project'?: string;
}): SessionProjectSelector {
  const claudeProject = readRawStringOption('claude-project') ?? (
    typeof args['claude-project'] === 'string' ? args['claude-project'] : undefined
  );
  if (args.project && claudeProject) {
    throw cliError('INVALID_ARGS', '--project and --claude-project are mutually exclusive');
  }
  if (claudeProject) {
    return { kind: 'claudeProject', project: claudeProject };
  }
  return { kind: 'projectPath', projectPath: args.project || process.cwd() };
}

/**
 * Resolve a session file from a UUID, UUID prefix, or slug.
 * Returns the full absolute path to the .jsonl file.
 */
async function resolveByIdOrSlug(claudeDir: string, input: string): Promise<string> {
  // Try UUID/prefix match
  const allFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
  const prefixMatches = allFiles.filter(f => f.startsWith(input));
  if (prefixMatches.length === 1) return join(claudeDir, prefixMatches[0]!);
  if (prefixMatches.length > 1) {
    throw cliError('INVALID_ID', `Ambiguous session ID prefix '${input}' -- matches ${prefixMatches.length} sessions`);
  }

  // Try slug match in all JSONL files after UUID/prefix matching fails.
  const slugMatches: string[] = [];
  for (const f of allFiles) {
    const filePath = join(claudeDir, f);
    try {
      if (await fileContainsSlug(filePath, input)) {
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
      // skip malformed lines during slug matching
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
            // A cleanup failure should not change a confirmed slug match.
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

/**
 * Resolve a session file from a UUID, UUID prefix, slug, or colon notation (session:agent-id).
 * Validates input against path traversal.
 */
export async function resolveSessionFile(claudeDir: string, input: string): Promise<ResolvedFile> {
  if (!input) {
    throw cliError('INVALID_ARGS', 'Session ID is required');
  }

  // Check for colon notation: <session>:<agent-id>
  const colonIdx = input.indexOf(':');
  if (colonIdx !== -1) {
    const sessionPart = input.slice(0, colonIdx);
    const agentId = input.slice(colonIdx + 1);

    // Validate each part independently
    if (!/^[a-zA-Z0-9-]+$/.test(sessionPart)) {
      throw cliError('INVALID_ID', 'Invalid session ID portion -- only alphanumeric characters and hyphens allowed');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      throw cliError('INVALID_ID', 'Invalid agent ID -- only alphanumeric characters, hyphens, and underscores allowed');
    }

    // Resolve parent session to get its UUID
    const parentFile = await resolveByIdOrSlug(claudeDir, sessionPart);
    const parentUuid = basename(parentFile, '.jsonl');
    const subagentFile = join(claudeDir, parentUuid, 'subagents', `agent-${agentId}.jsonl`);

    if (!existsSync(subagentFile)) {
      throw cliError('NOT_FOUND', `No subagent '${agentId}' found for session '${parentUuid}'`);
    }
    return { filePath: subagentFile, sessionId: parentUuid, agentId };
  }

  // Non-subagent: existing resolution logic
  if (!/^[a-zA-Z0-9-]+$/.test(input)) {
    throw cliError('INVALID_ID', 'Invalid session ID -- only alphanumeric characters and hyphens allowed');
  }
  const filePath = await resolveByIdOrSlug(claudeDir, input);
  return { filePath, sessionId: basename(filePath, '.jsonl'), agentId: null };
}

/** Parse a JSONL session file into an array of entries. Skips malformed lines. */
export function parseSessionText(text: string): SessionEntry[] {
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

/** Parse a JSONL session file into an array of entries. Skips malformed lines. */
export async function parseSessionLines(filePath: string): Promise<SessionEntry[]> {
  return parseSessionText(await Bun.file(filePath).text());
}

/** Filter to user/assistant entries only. */
export function userAssistantEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(e => e.type === 'user' || e.type === 'assistant');
}

/** Resolve a session from CLI args, returning the session ID, agent ID, and filtered entries. */
export type ResolvedSession = {
  sessionId: string;
  agentId: string | null;
  entries: SessionEntry[];
};

export async function resolveSession(args: {
  session: string;
  project?: string;
  'claude-project'?: string;
  claudeProjectsRoot?: string;
}): Promise<ResolvedSession> {
  const claudeDir = resolveClaudeProjectDirFromSelector(
    sessionProjectSelectorFromArgs(args),
    args.claudeProjectsRoot,
  );
  const { filePath, sessionId, agentId } = await resolveSessionFile(claudeDir, args.session);
  const allEntries = await parseSessionLines(filePath);
  const entries = userAssistantEntries(allEntries);
  return { sessionId, agentId, entries };
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

export function toolInputMatches(input: Record<string, unknown>, query: string): boolean {
  return stableJsonStringify(input).toLowerCase().includes(query.toLowerCase());
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
export function extractFilePath(toolName: string, input: Record<string, unknown>): { path: string; operation: SearchOperation } | null {
  const fileAccess = (key: 'file_path' | 'path', operation: SearchOperation): { path: string; operation: SearchOperation } | null => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? { path: value, operation } : null;
  };

  switch (toolName) {
    case 'Read':
      return fileAccess('file_path', 'read');
    case 'Edit':
      return fileAccess('file_path', 'edit');
    case 'Write':
      return fileAccess('file_path', 'write');
    case 'Grep':
      return fileAccess('path', 'grep');
    case 'Glob':
      return fileAccess('path', 'glob');
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

type ExtractSessionMetadataOptions = {
  includeSlug?: boolean;
};

export function extractSessionMetadata(text: string, options: ExtractSessionMetadataOptions = {}): SessionMetadata {
  const includeSlug = options.includeSlug ?? true;
  let branch: string | null = null;
  let timestamp: string | null = null;
  let version: string | null = null;
  let slug: string | null = null;

  let lineStart = 0;
  for (let j = 0; j < 5 && lineStart <= text.length; j++) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const rawLine = text.slice(lineStart, lineEnd);
    if (rawLine.trim()) {
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
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  if (includeSlug) {
    const slugMatch = text.match(/"slug":"([a-zA-Z0-9][a-zA-Z0-9-]*)"/);
    if (slugMatch) slug = slugMatch[1] ?? null;
  }

  return { branch, timestamp, version, slug };
}

const isSubagentFile = (f: string) => f.startsWith('agent-') && f.endsWith('.jsonl');

function countNonEmptyLines(text: string): number {
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

/** List subagents for a given session. Returns [] if no subagents directory exists. */
export async function listSubagents(claudeDir: string, sessionUuid: string): Promise<SubagentInfo[]> {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionUuid)) {
    throw cliError('INVALID_ID', 'Invalid session UUID');
  }
  const dir = join(claudeDir, sessionUuid, 'subagents');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(isSubagentFile);
  const results = await Promise.all(files.map(async (f) => {
    const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) return null;
    const jsonlPath = join(dir, f);
    const metaPath = join(dir, f.replace('.jsonl', '.meta.json'));

    let agentType: string | null = null;
    let description: string | null = null;
    try {
      const meta = JSON.parse(await Bun.file(metaPath).text());
      agentType = typeof meta.agentType === 'string' ? meta.agentType : null;
      description = typeof meta.description === 'string' ? meta.description : null;
    } catch (err: unknown) {
      if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
        throw cliError('FORMAT_ERROR', `Failed to read metadata for subagent '${agentId}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Single JSONL read for both metadata extraction and line counting
    let text: string;
    try {
      text = await Bun.file(jsonlPath).text();
    } catch (err: unknown) {
      throw cliError('FORMAT_ERROR', `Failed to read subagent file '${agentId}': ${err instanceof Error ? err.message : String(err)}`);
    }
    const { timestamp } = extractSessionMetadata(text, { includeSlug: false });
    const lines = countNonEmptyLines(text);

    return { agent_id: agentId, agent_type: agentType, description, lines, timestamp };
  }));
  const infos = results.filter((info): info is SubagentInfo => info !== null);

  // Sort by timestamp descending (newest first), matching `list` command convention.
  // Null timestamps sort to end.
  infos.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });
  return infos;
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

async function listSessionsForContext(
  context: SearchProjectContext,
  args: {
    branch?: string;
    before?: string;
    'include-subagents'?: boolean;
  },
  afterCutoff: string | null,
  minLines: number,
  includeProjectFields: boolean,
): Promise<ListSession[]> {
  const files = readdirSync(context.projectRef.claude_dir).filter(f => f.endsWith('.jsonl'));
  const sessions: ListSession[] = [];

  const BATCH_SIZE = 50;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (f) => {
      try {
        const filePath = join(context.projectRef.claude_dir, f);
        const sessionId = f.replace('.jsonl', '');
        const text = await Bun.file(filePath).text();
        const lineCount = countNonEmptyLines(text);

        if (minLines > 0 && lineCount < minLines) return null;

        const { branch, timestamp, version, slug } = extractSessionMetadata(text);

        if (args.branch && branch !== args.branch) return null;
        if (afterCutoff) {
          if (!timestamp || timestamp < afterCutoff) return null;
        }
        if (args.before) {
          if (!timestamp || timestamp > args.before) return null;
        }

        const session: ListSession = { session_id: sessionId, branch, timestamp, version, lines: lineCount, slug };
        if (includeProjectFields) {
          session.project = context.projectRef.project;
          session.project_path_guess = context.projectRef.project_path_guess;
          session.project_role = context.role;
        }
        if (args['include-subagents']) {
          try {
            const subagentDir = join(context.projectRef.claude_dir, sessionId, 'subagents');
            if (existsSync(subagentDir)) {
              session.subagent_count = readdirSync(subagentDir).filter(isSubagentFile).length;
            } else {
              session.subagent_count = 0;
            }
          } catch {
            session.subagent_count = 0;
          }
        }
        return session;
      } catch {
        return null; // skip unreadable files
      }
    }));
    sessions.push(...results.filter((r): r is ListSession => r !== null));
  }

  return sessions;
}

const listCommand = defineCommand({
  meta: { name: 'list', description: 'Index all sessions (metadata only)' },
  args: {
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    'all-projects': { type: 'boolean', description: 'List sessions from all Claude project directories', default: false },
    'project-glob': { type: 'string', description: 'Filter --all-projects by Claude project identity glob' },
    branch: { type: 'string', description: 'Filter by git branch' },
    after: { type: 'string', description: 'Sessions after DATE (ISO 8601)' },
    before: { type: 'string', description: 'Sessions before DATE (ISO 8601)' },
    since: { type: 'string', description: 'Sessions from the last duration (e.g. 1d, 2h, 1w)' },
    last: { type: 'string', description: 'Return only the last N sessions' },
    'min-lines': { type: 'string', description: 'Sessions with at least N lines' },
    'include-subagents': { type: 'boolean', description: 'Include subagent count per session', default: false },
  },
  async run({ args }) {
    try {
      const projectPath = args.project || process.cwd();
      const minLines = parseIntArg(args['min-lines'], '--min-lines') ?? 0;
      const allProjects = Boolean(args['all-projects']);

      if (args['project-glob'] && !allProjects) {
        throw cliError('INVALID_ARGS', '--project-glob requires --all-projects');
      }

      if (args.since && args.after) {
        throw cliError('INVALID_ARGS', '--since and --after are mutually exclusive');
      }
      const afterCutoff = args.since ? parseSince(args.since) : args.after ?? null;

      const lastN = parseIntArg(args.last, '--last');
      if (lastN != null && lastN <= 0) {
        throw cliError('INVALID_ARGS', '--last must be a positive integer');
      }

      const sessions: ListSession[] = [];
      const selection = selectProjectContexts({
        mode: allProjects ? 'all-projects' : 'scoped',
        projectPath,
        projectGlob: args['project-glob'],
      });

      for (const context of selection.contexts) {
        try {
          sessions.push(...await listSessionsForContext(context, args, afterCutoff, minLines, allProjects));
        } catch {
          if (!allProjects) throw cliError('NOT_FOUND', `Claude project directory not found: ${context.projectRef.claude_dir}`);
        }
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
      const responseMeta: ListMeta = meta(total, returned.length);
      if (allProjects) {
        responseMeta.projects_scanned = selection.contexts.length;
        responseMeta.included_projects = selection.includedProjects;
        responseMeta.skipped_projects = selection.skippedProjects;
      }
      output(success(returned, responseMeta));
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
    cumulative: { type: 'boolean', description: 'Show running totals', default: false },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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

      const result: TokensResult = { session_id: sessionId, agent_id: agentId, turns: finalTurns, totals };
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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
        agent_id: agentId,
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
    name: { type: 'string', description: 'Filter by tool name' },
    failed: { type: 'boolean', description: 'Show only failed/empty outcomes', default: false },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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
      const result: ToolsResult = { session_id: sessionId, agent_id: agentId, tool_calls: calls };
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
    'group-by': { type: 'string', description: "Group by 'file' (default) or 'turn'" },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
    operation: { type: 'string', description: 'Filter by operation (read/edit/write/grep/glob)' },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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
        const result: FilesResult = { session_id: sessionId, agent_id: agentId, group_by: 'turn', accesses };
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
        const result: FilesResult = { session_id: sessionId, agent_id: agentId, group_by: 'file', files };
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
    role: { type: 'string', description: 'Filter by role (user or assistant)' },
    type: { type: 'string', description: 'Filter by content block type' },
    turn: { type: 'string', description: 'Filter by turn N or N-M' },
    'max-content': { type: 'string', description: 'Truncate content to N chars (default: 200)' },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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

      const result: MessagesResult = { session_id: sessionId, agent_id: agentId, messages };
      output(success(result, meta(messages.length, messages.length)));
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
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
    turn: { type: 'string', description: 'Turn range N or N-M (required)', required: true },
    'max-content': { type: 'string', description: 'Truncate content blocks to N chars' },
  },
  async run({ args }) {
    try {
      const { sessionId, agentId, entries } = await resolveSession(args);

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

      const result: SliceResult = { session_id: sessionId, agent_id: agentId, entries: sliced };
      output(success(result, meta(sliced.length, sliced.length)));
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

export function listSearchTargetsForProject(claudeDir: string, projectRef?: ProjectRef): SearchTarget[] {
  return readdirSync(claudeDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      filePath: join(claudeDir, f),
      sessionId: f.replace('.jsonl', ''),
      projectRef,
    }));
}

export function listSearchTargetsForContext(context: SearchProjectContext): SearchTarget[] {
  return readdirSync(context.projectRef.claude_dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      filePath: join(context.projectRef.claude_dir, f),
      sessionId: f.replace('.jsonl', ''),
      context,
      projectRef: context.projectRef,
    }));
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

type SearchTargetResult = {
  match: SearchMatch | null;
};

export async function scanSearchTarget(target: SearchTarget, args: SearchArgs, afterCutoff: string | null): Promise<SearchTargetResult> {
  try {
    const text = await Bun.file(target.filePath).text();

    const { branch, timestamp, slug } = extractSessionMetadata(text);

    if (args.branch && branch !== args.branch) return { match: null };
    if (afterCutoff) {
      if (!timestamp || timestamp < afterCutoff) return { match: null };
    }
    if (args.before) {
      if (!timestamp || timestamp > args.before) return { match: null };
    }

    const entries = parseSessionText(text);
    const uaEntries = userAssistantEntries(entries);
    const sessionContext = target.context ? buildSearchSessionContext(target.context, entries) : null;

    const matchedTools = new Set<string>();
    const matchedFiles = new Set<string>();
    const matchedNormalizedFiles = new Set<string>();
    const matchedFileEvidence: FileMatchEvidence[] = [];
    const matchedOperations = new Set<SearchOperation>();
    const matchedToolInputs: ToolInputMatch[] = [];
    const matchedTurns = new Set<number>();

    const toolQuery = args.tool?.toLowerCase();
    const fileQuery = args.file && sessionContext ? normalizeFileQuery(args.file, sessionContext) : null;
    const rawFileQuery = args.file?.toLowerCase();
    const textQuery = args.text?.toLowerCase();
    const bashQuery = args.bash?.toLowerCase();
    const inputQuery = args.inputMatch?.toLowerCase();
    const operationQuery = args.operation;

    let toolHit = !toolQuery;
    let fileHit = !args.file;
    let textHit = !textQuery;
    let bashHit = !bashQuery;
    let inputHit = !inputQuery;

    for (let ei = 0; ei < uaEntries.length; ei++) {
      const entry = uaEntries[ei]!;
      const turnNum = ei + 1;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as ContentBlock[]) {
        if (toolQuery && block.type === 'tool_use' && block.name) {
          if (block.name.toLowerCase().includes(toolQuery)) {
            matchedTools.add(block.name);
            matchedTurns.add(turnNum);
            toolHit = true;
          }
        }

        if ((toolQuery || inputQuery) && block.type === 'tool_use' && block.name) {
          const input = block.input ?? {};
          const nameMatches = !toolQuery || block.name.toLowerCase().includes(toolQuery);
          const inputMatches = !inputQuery || toolInputMatches(input, inputQuery);
          if (nameMatches && inputMatches) {
            matchedToolInputs.push({
              tool: block.name,
              input_summary: inputSummary(block.name, input),
              turn: turnNum,
            });
            matchedTools.add(block.name);
            matchedTurns.add(turnNum);
            if (toolQuery) toolHit = true;
            if (inputQuery) inputHit = true;
          }
        }

        if ((fileQuery || rawFileQuery) && block.type === 'tool_use' && block.name) {
          const fileInfo = extractFilePath(block.name, block.input ?? {});
          const access = fileInfo && sessionContext
            ? normalizeFileAccess(fileInfo.path, fileInfo.operation, sessionContext)
            : null;
          const fileMatch = fileInfo && fileQuery && access
            ? matchFileAccess(fileQuery, access)
            : {
                matched: Boolean(fileInfo && rawFileQuery && fileInfo.path.toLowerCase().includes(rawFileQuery)),
                matchedBy: 'substring' as const,
                logicalPath: null,
              };
          if (fileInfo && fileMatch.matched) {
            if (!operationQuery || fileInfo.operation === operationQuery) {
              matchedFiles.add(fileInfo.path);
              if (fileMatch.logicalPath) matchedNormalizedFiles.add(fileMatch.logicalPath);
              matchedFileEvidence.push({
                rawPath: fileInfo.path,
                logicalPath: fileMatch.logicalPath,
                operation: fileInfo.operation,
                turn: turnNum,
                timestamp: entry.timestamp ?? null,
              });
              matchedOperations.add(fileInfo.operation);
              matchedTurns.add(turnNum);
              fileHit = true;
            }
          }
        }

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

        if (bashQuery && block.type === 'tool_use' && block.name === 'Bash') {
          const command = (block.input as Record<string, any>)?.command;
          if (typeof command === 'string' && command.toLowerCase().includes(bashQuery)) {
            matchedTurns.add(turnNum);
            bashHit = true;
          }
        }
      }
    }

    if (!toolHit || !fileHit || !textHit || !bashHit || !inputHit) return { match: null };

    const match: SearchMatch = {
      session_id: target.sessionId,
      branch,
      timestamp,
      slug,
      matches: {
        tools: Array.from(matchedTools),
        files: Array.from(matchedFiles),
        turns: Array.from(matchedTurns).sort((a, b) => a - b),
      },
    };

    if (matchedOperations.size > 0) {
      match.matches.operations = Array.from(matchedOperations);
    }
    if (matchedNormalizedFiles.size > 0) {
      match.matches.normalized_files = Array.from(matchedNormalizedFiles);
    }
    if (matchedFileEvidence.length > 0) {
      match.matches.file_evidence = matchedFileEvidence;
    }
    if (matchedToolInputs.length > 0) {
      match.matches.tool_inputs = matchedToolInputs;
    }
    const projectRef = target.context?.projectRef ?? target.projectRef;
    const exposeProjectRef = target.context ? target.context.role !== 'main' : Boolean(target.projectRef);
    if (projectRef && exposeProjectRef) {
      match.project = projectRef.project;
      match.project_path_guess = projectRef.project_path_guess;
      if (target.context) {
        match.project_role = target.context.role;
      }
      match.session_ref = {
        session_id: target.sessionId,
        project: projectRef.project,
      };
    }

    return { match };
  } catch {
    return { match: null };
  }
}

export async function scanSearchTargets(targets: SearchTarget[], args: SearchArgs, afterCutoff: string | null): Promise<SearchScanResult> {
  const matches: SearchMatch[] = [];

  const targetResults = await mapConcurrent(
    targets,
    SEARCH_SCAN_CONCURRENCY,
    target => scanSearchTarget(target, args, afterCutoff),
  );
  for (const result of targetResults) {
    if (result.match) matches.push(result.match);
  }

  return { matches };
}

export async function scanProjectContexts(
  contexts: SearchProjectContext[],
  args: SearchArgs,
  afterCutoff: string | null,
): Promise<SearchScanResult> {
  const targets: SearchTarget[] = [];
  for (const context of contexts) {
    try {
      targets.push(...listSearchTargetsForContext(context));
    } catch {
      // Preserve search's tolerant handling of unreadable Claude project directories.
    }
  }
  return scanSearchTargets(targets, args, afterCutoff);
}

function compareNullableTimestamp(a: string | null | undefined, b: string | null | undefined, direction: 'asc' | 'desc'): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
}

function sortedEvidenceTimestamps(match: SearchMatch): string[] {
  return (match.matches.file_evidence ?? [])
    .map(evidence => evidence.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort();
}

function matchTimestamp(match: SearchMatch, mode: 'earliest' | 'newest'): string | null {
  const timestamps = sortedEvidenceTimestamps(match);
  if (timestamps.length === 0) return match.timestamp;
  return mode === 'earliest' ? timestamps[0]! : timestamps[timestamps.length - 1]!;
}

export function sortSearchMatches(matches: SearchMatch[], mode: SearchSortMode): SearchMatch[] {
  return matches.sort((a, b) => {
    if (mode === 'match-earliest') {
      const byMatch = compareNullableTimestamp(matchTimestamp(a, 'earliest'), matchTimestamp(b, 'earliest'), 'asc');
      if (byMatch !== 0) return byMatch;
      return compareNullableTimestamp(a.timestamp, b.timestamp, 'desc');
    }

    if (mode === 'match-newest') {
      const byMatch = compareNullableTimestamp(matchTimestamp(a, 'newest'), matchTimestamp(b, 'newest'), 'desc');
      if (byMatch !== 0) return byMatch;
      return compareNullableTimestamp(a.timestamp, b.timestamp, 'desc');
    }

    if (mode === 'project') {
      const projectA = a.project ?? '';
      const projectB = b.project ?? '';
      const byProject = projectA.localeCompare(projectB);
      if (byProject !== 0) return byProject;
      return compareNullableTimestamp(a.timestamp, b.timestamp, 'desc');
    }

    return compareNullableTimestamp(a.timestamp, b.timestamp, 'desc');
  });
}

export function aggregateSearchMatches(matches: SearchMatch[], mode: SearchAggregateMode): SearchAggregateResult[] {
  if (mode === 'none') return [];
  return matches.map(match => {
    const result: SearchAggregateResult = {
      session_id: match.session_id,
      branch: match.branch,
      timestamp: match.timestamp,
      slug: match.slug,
      counts: {
        tool_inputs: match.matches.tool_inputs?.length ?? 0,
      },
      sample_matches: (match.matches.tool_inputs ?? []).slice(0, 5),
    };
    if (match.project !== undefined) result.project = match.project;
    if (match.project_path_guess !== undefined) result.project_path_guess = match.project_path_guess;
    if (match.project_role !== undefined) result.project_role = match.project_role;
    return result;
  });
}

// ============================================================================
// Search Command
// ============================================================================

const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Find sessions matching structured queries' },
  args: {
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    'all-projects': { type: 'boolean', description: 'Search all Claude project directories', default: false },
    'project-glob': { type: 'string', description: 'Filter --all-projects by Claude project identity glob' },
    tool: { type: 'string', description: 'Sessions using a specific tool (case-insensitive substring)' },
    'input-match': { type: 'string', description: 'Sessions with raw structured tool input containing a case-insensitive substring' },
    file: { type: 'string', description: 'Sessions that touched a file (substring match on path)' },
    text: { type: 'string', description: 'Search in assistant text and thinking content (case-insensitive substring)' },
    bash: { type: 'string', description: 'Search in Bash command inputs (case-insensitive substring)' },
    branch: { type: 'string', description: 'Filter by git branch' },
    after: { type: 'string', description: 'Sessions after DATE (ISO 8601)' },
    before: { type: 'string', description: 'Sessions before DATE (ISO 8601)' },
    since: { type: 'string', description: 'Sessions from the last duration (e.g. 1d, 2h, 1w)' },
    operation: { type: 'string', description: 'With --file, filter by operation: read/edit/write/grep/glob' },
    origin: { type: 'boolean', description: 'With --file, return earliest matching write evidence', default: false },
    sort: { type: 'string', description: 'Sort mode: session-newest, match-earliest, match-newest, project' },
    aggregate: { type: 'string', description: 'Aggregate mode: count-per-session' },
    last: { type: 'string', description: 'Return only the last N matches' },
  },
  async run({ args }) {
    try {
      // Validate at least one search filter is provided
      if (!args.tool && !args['input-match'] && !args.file && !args.text && !args.bash) {
        throw cliError('INVALID_ARGS', 'At least one search filter is required (--tool, --input-match, --file, --text, or --bash)');
      }

      // Validate --since and --after mutual exclusivity
      if (args.since && args.after) {
        throw cliError('INVALID_ARGS', '--since and --after are mutually exclusive');
      }

      if (args.operation && !args.file) {
        throw cliError('INVALID_ARGS', '--operation requires --file');
      }
      if (args.operation && !SEARCH_OPERATIONS.includes(args.operation as SearchOperation)) {
        throw cliError('INVALID_ARGS', '--operation must be one of: read, edit, write, grep, glob');
      }
      const sortMode = (args.sort ?? 'session-newest') as SearchSortMode;
      if (!SEARCH_SORT_MODES.includes(sortMode)) {
        throw cliError('INVALID_ARGS', '--sort must be one of: session-newest, match-earliest, match-newest, project');
      }
      const aggregateMode = (args.aggregate ?? 'none') as SearchAggregateMode;
      if (aggregateMode !== 'none' && aggregateMode !== 'count-per-session') {
        throw cliError('INVALID_ARGS', '--aggregate must be count-per-session');
      }
      if (aggregateMode !== 'none' && !args.tool && !args['input-match']) {
        throw cliError('INVALID_ARGS', '--aggregate requires --tool or --input-match');
      }

      const origin = Boolean(args.origin);
      if (origin) {
        if (!args.file) {
          throw cliError('INVALID_ARGS', '--origin requires --file');
        }
        if (args.operation && args.operation !== 'write') {
          throw cliError('INVALID_ARGS', '--origin implies --operation write');
        }
        if (args.sort && args.sort !== 'match-earliest') {
          throw cliError('INVALID_ARGS', '--origin uses --sort match-earliest');
        }
      }

      const afterCutoff = args.since ? parseSince(args.since) : args.after ?? null;
      const lastN = parseIntArg(args.last, '--last');
      if (lastN != null && lastN <= 0) {
        throw cliError('INVALID_ARGS', '--last must be a positive integer');
      }

      const searchArgs: SearchArgs = {
        tool: args.tool,
        inputMatch: args['input-match'],
        file: args.file,
        text: args.text,
        bash: args.bash,
        branch: args.branch,
        after: args.after,
        before: args.before,
        since: args.since,
        operation: origin ? 'write' : args.operation as SearchOperation | undefined,
      };

      const allProjects = Boolean(args['all-projects']);
      const results: SearchMatch[] = [];
      if (args['project-glob'] && !allProjects) {
        throw cliError('INVALID_ARGS', '--project-glob requires --all-projects');
      }

      const selection = selectProjectContexts({
        mode: allProjects ? 'all-projects' : 'scoped-with-worktrees',
        projectPath: allProjects ? args.project : args.project || process.cwd(),
        projectGlob: args['project-glob'],
      });
      const scanResult = await scanProjectContexts(selection.contexts, searchArgs, afterCutoff);
      results.push(...scanResult.matches);

      sortSearchMatches(results, origin ? 'match-earliest' : sortMode);

      // Apply --last limit after sorting
      const total = results.length;
      const resultLimit = origin ? lastN ?? 1 : lastN;
      const returned = resultLimit != null ? results.slice(0, resultLimit) : results;
      const responseMeta: SearchMeta = meta(total, returned.length);
      if (allProjects) {
        responseMeta.projects_scanned = selection.contexts.length;
        responseMeta.included_projects = selection.includedProjects;
        responseMeta.skipped_projects = selection.skippedProjects;
      } else {
        responseMeta.included_projects = selection.includedProjects;
      }
      output(success(
        aggregateMode === 'count-per-session' ? aggregateSearchMatches(returned, aggregateMode) : returned,
        responseMeta,
      ));
    } catch (err: unknown) {
      handleCommandError(err);
    }
  },
});

// ============================================================================
// Subagents Command
// ============================================================================

const subagentsCommand = defineCommand({
  meta: { name: 'subagents', description: 'List subagents for a session' },
  args: {
    session: { type: 'positional', description: 'Parent session ID', required: true },
    project: { type: 'string', description: 'Absolute project path (defaults to CWD)' },
    'claude-project': { type: 'string', description: 'Raw Claude project directory basename' },
  },
  async run({ args }) {
    try {
      // Reject colon notation — subagents of subagents don't exist
      if (args.session.includes(':')) {
        throw cliError('INVALID_ARGS', 'subagents command takes a parent session ID, not a subagent reference');
      }
      const claudeDir = resolveClaudeProjectDirFromSelector(sessionProjectSelectorFromArgs(args));
      const { sessionId } = await resolveSessionFile(claudeDir, args.session);
      const subagents = await listSubagents(claudeDir, sessionId);
      const result: SubagentsResult = { session_id: sessionId, subagents };
      output(success(result, meta(subagents.length, subagents.length)));
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
    subagents: subagentsCommand,
  },
});

if (import.meta.main) {
  runMain(main);
}
