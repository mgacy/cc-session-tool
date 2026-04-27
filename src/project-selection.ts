import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { existsSync, readdirSync, realpathSync } from 'fs';
import type { SessionEntry } from './transcript.ts';

export type ProjectRef = {
  project: string;
  claude_dir: string;
  project_path_guess: string | null;
};

export type SearchOperation = 'read' | 'edit' | 'write' | 'grep' | 'glob';

export type SearchProjectRole = 'main' | 'worktree' | 'global';

export type PublicProjectRef = {
  project: string;
  project_path_guess: string | null;
  project_role: SearchProjectRole;
};

export type ProjectSummary = {
  project: string;
  project_path_guess: string | null;
  project_role: SearchProjectRole;
  session_count: number;
  total_lines: number;
  first_session_at: string | null;
  last_session_at: string | null;
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

export function claudeProjectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects');
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, '') || '/';
}

export function normalizePathForContainment(input: string): string {
  return stripTrailingSlashes(resolve(input));
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
      // Keep candidates collected so far.
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

function extractFilePath(toolName: string, input: Record<string, unknown>): { path: string; operation: SearchOperation } | null {
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

function projectMatchesPattern(ref: ProjectRef, regex: RegExp): boolean {
  return regex.test(ref.project) || Boolean(ref.project_path_guess && regex.test(ref.project_path_guess));
}

export function projectMatchesGlob(ref: ProjectRef, glob: string): boolean {
  return projectMatchesPattern(ref, globToRegExp(glob));
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
    throw new Error(`Claude project directory not found: ${claudeDir}`);
  }
  return claudeDir;
}

export function validateClaudeProjectBasename(project: string): void {
  if (
    !project ||
    project === '.' ||
    project === '..' ||
    project.includes('/') ||
    project.includes('\\') ||
    basename(project) !== project
  ) {
    throw new Error('--claude-project must be a Claude project directory basename');
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
    throw new Error(`Claude project directory not found: ${claudeDir}`);
  }
  return claudeDir;
}

export function sessionProjectSelectorFromArgs(args: {
  project?: string;
  'claude-project'?: string;
}): SessionProjectSelector {
  const claudeProject = readRawStringOption('claude-project') ?? (
    typeof args['claude-project'] === 'string' ? args['claude-project'] : undefined
  );
  if (args.project && claudeProject) {
    throw new Error('--project and --claude-project are mutually exclusive');
  }
  if (claudeProject) {
    return { kind: 'claudeProject', project: claudeProject };
  }
  return { kind: 'projectPath', projectPath: args.project || process.cwd() };
}

export function listSearchTargetsForContext(context: SearchProjectContext): SearchTarget[] {
  if (!existsSync(context.projectRef.claude_dir)) return [];
  return readdirSync(context.projectRef.claude_dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort((a, b) => a.localeCompare(b))
    .map(f => ({
      filePath: join(context.projectRef.claude_dir, f),
      sessionId: f.replace('.jsonl', ''),
      context,
      projectRef: context.projectRef,
    }));
}
