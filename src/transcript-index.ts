import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import {
  countNonEmptyLines,
  parseSessionText,
  userAssistantEntries,
  type SessionEntry,
} from './transcript.ts';
import {
  extractFilePath,
  extractSessionCwd,
  normalizePathForContainment,
  type SearchProjectContext,
} from './project-selection.ts';
import { buildResultLookup, safeInputSummary } from './tool-log.ts';

export const INDEX_SCHEMA_VERSION = 1;

export const INDEX_DB_ENV_VAR = 'CC_SESSION_TOOL_DB';

/** agent_id sentinel for parent transcripts; NULL would break PK-based row replacement. */
const PARENT_AGENT_ID = '';

export type IndexTarget = {
  project: string;
  sessionId: string;
  agentId: string;
  parentSessionId: string | null;
  filePath: string;
};

/** Per-file detail for a transcript that could not be indexed, so a failure is identifiable (not just counted). */
export type RefreshFailure = {
  project: string;
  session_id: string;
  agent_id: string;
  file_path: string;
  reason: string;
};

export type RefreshStats = {
  scanned: number;
  fresh: number;
  indexed: number;
  removed: number;
  failed: number;
  failures: RefreshFailure[];
};

export type IndexFreshness = {
  on_disk: number;
  indexed: number;
  fresh: number;
  stale: number;
  not_indexed: number;
  orphaned: number;
};

export type IndexStatus = {
  db_path: string;
  schema_version: number;
  db_size_bytes: number | null;
  sessions: number;
  turns: number;
  tool_uses: number;
  projects: number;
  scope: IndexFreshness;
};

/** A token count, or null when message.usage was absent for the whole group (NOT zero). See CLAUDE.md. */
export type TokenCount = number | null;

export type TokenStatsOptions = {
  projects: string[];
  bucket?: 'day' | 'week' | null;
  by?: 'model' | 'session' | null;
  after?: string | null;
  before?: string | null;
  includeSubagents: boolean;
};

export type TokenStatsRow = {
  bucket?: string;
  model?: string | null;
  project?: string;
  session_id?: string;
  agent_id?: string | null;
  turns: number;
  turns_with_usage: number;
  input_tokens: TokenCount;
  output_tokens: TokenCount;
  cache_read_input_tokens: TokenCount;
  cache_creation_input_tokens: TokenCount;
  cache_hit_rate: number | null;
};

export type ToolPairsOptions = {
  projects: string[];
  prev?: string | null;
  next?: string | null;
  operation?: string | null;
  pathMatch?: string | null;
  limit: number;
  includeSubagents: boolean;
};

export type ToolPairRow = {
  prev_tool: string | null;
  tool: string;
  count: number;
};

export function defaultIndexDbPath(home = homedir(), platform = process.platform): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'cc-session-tool', 'index.db');
  }
  const cacheRoot = process.env.XDG_CACHE_HOME || join(home, '.cache');
  return join(cacheRoot, 'cc-session-tool', 'index.db');
}

export function resolveIndexDbPath(flagValue?: string, env: Record<string, string | undefined> = process.env): string {
  if (flagValue && flagValue.trim()) return flagValue;
  const fromEnv = env[INDEX_DB_ENV_VAR];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return defaultIndexDbPath();
}

const SCHEMA_DDL = `
CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE session (
  project           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  agent_id          TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT,
  file_path         TEXT NOT NULL,
  file_mtime_ms     INTEGER NOT NULL,
  file_size         INTEGER NOT NULL,
  indexed_at        TEXT NOT NULL,
  started_at        TEXT,
  ended_at          TEXT,
  duration_ms       INTEGER,
  branch            TEXT,
  model             TEXT,
  slug              TEXT,
  version           TEXT,
  turn_count        INTEGER NOT NULL,
  line_count        INTEGER NOT NULL,
  input_tokens_total                INTEGER,
  output_tokens_total               INTEGER,
  cache_read_input_tokens_total     INTEGER,
  cache_creation_input_tokens_total INTEGER,
  PRIMARY KEY (project, session_id, agent_id)
);
CREATE INDEX session_by_slug    ON session(slug);
CREATE INDEX session_by_started ON session(started_at);
CREATE INDEX session_by_project ON session(project, started_at);
CREATE INDEX session_by_model   ON session(model, started_at);

CREATE TABLE turn (
  project    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL DEFAULT '',
  turn       INTEGER NOT NULL,
  ts         TEXT,
  role       TEXT NOT NULL,
  model      TEXT,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cache_read_input_tokens     INTEGER,
  cache_creation_input_tokens INTEGER,
  PRIMARY KEY (project, session_id, agent_id, turn)
);
CREATE INDEX turn_by_ts    ON turn(ts);
CREATE INDEX turn_by_model ON turn(model, ts);

CREATE TABLE tool_use (
  project       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL DEFAULT '',
  turn          INTEGER NOT NULL,
  block_index   INTEGER NOT NULL,
  ts            TEXT,
  tool          TEXT NOT NULL,
  operation     TEXT,
  file_path     TEXT,
  logical_path  TEXT,
  input_summary TEXT NOT NULL,
  is_error      INTEGER,
  PRIMARY KEY (project, session_id, agent_id, turn, block_index)
);
CREATE INDEX tool_by_path         ON tool_use(file_path);
CREATE INDEX tool_by_logical_path ON tool_use(logical_path);
CREATE INDEX tool_by_name         ON tool_use(tool, operation);
`;

const INDEX_TABLES = ['tool_use', 'turn', 'session', 'schema_version'];

function readSchemaVersion(db: Database): number | null {
  try {
    const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | null;
    return typeof row?.version === 'number' ? row.version : null;
  } catch {
    return null;
  }
}

function recreateSchema(db: Database): void {
  for (const table of INDEX_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec(SCHEMA_DDL);
  db.query('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
    .run(INDEX_SCHEMA_VERSION, new Date().toISOString());
}

/**
 * Open (creating if needed) the index database. A schema-version mismatch drops
 * and recreates all tables -- the JSONL transcripts remain the source of truth,
 * so a rebuild is always safe. Throws on unreadable/corrupt database files.
 */
export function openIndexDb(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    if (readSchemaVersion(db) !== INDEX_SCHEMA_VERSION) {
      recreateSchema(db);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Remove the index database and its WAL/SHM sidecars. Safe to call on a missing path. */
export function removeIndexDbFiles(dbPath: string): void {
  if (dbPath === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }
}

const isSubagentFile = (f: string) => f.startsWith('agent-') && f.endsWith('.jsonl');

export function listIndexTargetsForContext(context: SearchProjectContext): IndexTarget[] {
  const claudeDir = context.projectRef.claude_dir;
  if (!existsSync(claudeDir)) return [];
  const targets: IndexTarget[] = [];
  const parentFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')).sort((a, b) => a.localeCompare(b));
  for (const file of parentFiles) {
    const sessionId = file.replace(/\.jsonl$/, '');
    targets.push({
      project: context.projectRef.project,
      sessionId,
      agentId: PARENT_AGENT_ID,
      parentSessionId: null,
      filePath: join(claudeDir, file),
    });
    const subagentDir = join(claudeDir, sessionId, 'subagents');
    if (!existsSync(subagentDir)) continue;
    for (const subFile of readdirSync(subagentDir).filter(isSubagentFile).sort((a, b) => a.localeCompare(b))) {
      const agentId = subFile.slice('agent-'.length, -'.jsonl'.length);
      if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) continue;
      targets.push({
        project: context.projectRef.project,
        sessionId,
        agentId,
        parentSessionId: sessionId,
        filePath: join(subagentDir, subFile),
      });
    }
  }
  return targets;
}

type Watermark = { file_mtime_ms: number; file_size: number };

// NUL separator: impossible in project basenames (which may contain spaces) or IDs.
const KEY_SEPARATOR = '\u0000';

function targetKey(project: string, sessionId: string, agentId: string): string {
  return [project, sessionId, agentId].join(KEY_SEPARATOR);
}

function loadWatermarks(db: Database, projects: string[]): Map<string, Watermark> {
  const map = new Map<string, Watermark>();
  if (projects.length === 0) return map;
  const placeholders = projects.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT project, session_id, agent_id, file_mtime_ms, file_size FROM session WHERE project IN (${placeholders})`,
  ).all(...projects) as Array<{ project: string; session_id: string; agent_id: string; file_mtime_ms: number; file_size: number }>;
  for (const row of rows) {
    map.set(targetKey(row.project, row.session_id, row.agent_id), {
      file_mtime_ms: row.file_mtime_ms,
      file_size: row.file_size,
    });
  }
  return map;
}

function deleteTranscriptRows(db: Database, project: string, sessionId: string, agentId: string): void {
  for (const table of ['session', 'turn', 'tool_use']) {
    db.query(`DELETE FROM ${table} WHERE project = ? AND session_id = ? AND agent_id = ?`)
      .run(project, sessionId, agentId);
  }
}

function firstSessionMetadata(entries: SessionEntry[]): {
  branch: string | null;
  timestamp: string | null;
  version: string | null;
  slug: string | null;
  model: string | null;
} {
  let branch: string | null = null;
  let timestamp: string | null = null;
  let version: string | null = null;
  let slug: string | null = null;
  let model: string | null = null;
  for (const entry of entries) {
    if (branch === null && entry.sessionId) {
      branch = entry.gitBranch ?? null;
      version = entry.version ?? null;
      timestamp = entry.timestamp ?? null;
    }
    if (slug === null && typeof entry.slug === 'string') slug = entry.slug;
    if (model === null) {
      if (typeof entry.message?.model === 'string' && entry.message.model.trim()) model = entry.message.model;
      else if (typeof entry.model === 'string' && entry.model.trim()) model = entry.model;
    }
    if (branch !== null && slug !== null && model !== null) break;
  }
  return { branch, timestamp, version, slug, model };
}

function logicalPathForCwd(filePath: string | null, cwd: string | null): string | null {
  if (!filePath || !cwd || !isAbsolute(filePath) || !isAbsolute(cwd)) return null;
  const rel = relative(normalizePathForContainment(cwd), normalizePathForContainment(filePath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

function sumOrNull(values: Array<number | null>): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    sum = (sum ?? 0) + value;
  }
  return sum;
}

/**
 * Parse one transcript file and replace its rows in the index.
 *
 * The file is stat'ed before reading and that pre-read watermark is persisted
 * only after the file has been fully read and parsed, in the same transaction
 * as the row replacement. If Claude appends to the file mid-read, the next
 * stat differs from the stored watermark and the file is re-indexed.
 */
export function indexTranscriptFile(db: Database, target: IndexTarget): void {
  const stat = statSync(target.filePath);
  const fileMtimeMs = Math.round(stat.mtimeMs);
  const fileSize = stat.size;

  const text = readFileSync(target.filePath, 'utf8');
  const allEntries = parseSessionText(text);
  const entries = userAssistantEntries(allEntries);
  const lineCount = countNonEmptyLines(text);
  const metadata = firstSessionMetadata(allEntries);
  const resultLookup = buildResultLookup(entries);
  const cwd = extractSessionCwd(allEntries);

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const entry of allEntries) {
    if (!entry.timestamp) continue;
    if (startedAt === null) startedAt = entry.timestamp;
    endedAt = entry.timestamp;
  }
  let durationMs: number | null = null;
  if (startedAt && endedAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) durationMs = end - start;
  }

  type TurnRow = {
    turn: number;
    ts: string | null;
    role: string;
    model: string | null;
    input: TokenCount;
    output: TokenCount;
    cacheRead: TokenCount;
    cacheCreate: TokenCount;
  };
  type ToolUseRow = {
    turn: number;
    blockIndex: number;
    ts: string | null;
    tool: string;
    operation: string | null;
    filePath: string | null;
    logicalPath: string | null;
    inputSummary: string;
    isError: number | null;
  };

  const turnRows: TurnRow[] = [];
  const toolUseRows: ToolUseRow[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const turn = i + 1;
    const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
    turnRows.push({
      turn,
      ts: entry.timestamp ?? null,
      role: entry.type,
      model: entry.type === 'assistant' && typeof entry.message?.model === 'string' ? entry.message.model : null,
      input: usage?.input_tokens ?? null,
      output: usage?.output_tokens ?? null,
      cacheRead: usage?.cache_read_input_tokens ?? null,
      cacheCreate: usage?.cache_creation_input_tokens ?? null,
    });

    const content = entry.message?.content;
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const block = content[blockIndex]!;
      if (block.type !== 'tool_use' || !block.name) continue;
      const rawInput = block.input ?? {};
      const fileInfo = extractFilePath(block.name, rawInput);
      const resultInfo = resultLookup.get(block.id ?? '') ?? null;
      toolUseRows.push({
        turn,
        blockIndex,
        ts: entry.timestamp ?? null,
        tool: block.name,
        operation: fileInfo?.operation ?? null,
        filePath: fileInfo?.path ?? null,
        logicalPath: logicalPathForCwd(fileInfo?.path ?? null, cwd),
        inputSummary: safeInputSummary(block.name, rawInput),
        isError: resultInfo === null ? null : (resultInfo.is_error ? 1 : 0),
      });
    }
  }

  const totals = {
    input: sumOrNull(turnRows.map(row => row.input)),
    output: sumOrNull(turnRows.map(row => row.output)),
    cacheRead: sumOrNull(turnRows.map(row => row.cacheRead)),
    cacheCreate: sumOrNull(turnRows.map(row => row.cacheCreate)),
  };

  const insertSession = db.query(`
    INSERT INTO session (
      project, session_id, agent_id, parent_session_id, file_path,
      file_mtime_ms, file_size, indexed_at,
      started_at, ended_at, duration_ms,
      branch, model, slug, version, turn_count, line_count,
      input_tokens_total, output_tokens_total,
      cache_read_input_tokens_total, cache_creation_input_tokens_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = db.query(`
    INSERT INTO turn (
      project, session_id, agent_id, turn, ts, role, model,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolUse = db.query(`
    INSERT INTO tool_use (
      project, session_id, agent_id, turn, block_index, ts, tool,
      operation, file_path, logical_path, input_summary, is_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const replaceRows = db.transaction(() => {
    deleteTranscriptRows(db, target.project, target.sessionId, target.agentId);
    insertSession.run(
      target.project, target.sessionId, target.agentId, target.parentSessionId, target.filePath,
      fileMtimeMs, fileSize, new Date().toISOString(),
      startedAt, endedAt, durationMs,
      metadata.branch, metadata.model, metadata.slug, metadata.version, entries.length, lineCount,
      totals.input, totals.output, totals.cacheRead, totals.cacheCreate,
    );
    for (const row of turnRows) {
      insertTurn.run(
        target.project, target.sessionId, target.agentId, row.turn, row.ts, row.role, row.model,
        row.input, row.output, row.cacheRead, row.cacheCreate,
      );
    }
    for (const row of toolUseRows) {
      insertToolUse.run(
        target.project, target.sessionId, target.agentId, row.turn, row.blockIndex, row.ts, row.tool,
        row.operation, row.filePath, row.logicalPath, row.inputSummary, row.isError,
      );
    }
  });
  replaceRows();
}

/**
 * Bring the index up to date for the given project contexts: index new and
 * stale transcripts (mtime+size watermark), drop rows for transcripts that no
 * longer exist on disk. Unreadable/unparseable files have their rows removed,
 * are counted as failed, and are recorded in `failures` with their path and the
 * parse error so they are identifiable rather than silently dropped; they retry
 * on the next refresh.
 */
export function refreshIndexForContexts(db: Database, contexts: SearchProjectContext[]): RefreshStats {
  const stats: RefreshStats = { scanned: 0, fresh: 0, indexed: 0, removed: 0, failed: 0, failures: [] };
  const targets: IndexTarget[] = [];
  const seenProjects = new Set<string>();
  for (const context of contexts) {
    if (seenProjects.has(context.projectRef.project)) continue;
    seenProjects.add(context.projectRef.project);
    targets.push(...listIndexTargetsForContext(context));
  }

  const watermarks = loadWatermarks(db, Array.from(seenProjects));
  const seenKeys = new Set<string>();

  for (const target of targets) {
    stats.scanned++;
    const key = targetKey(target.project, target.sessionId, target.agentId);
    seenKeys.add(key);
    const existing = watermarks.get(key);
    let stat;
    try {
      stat = statSync(target.filePath);
    } catch {
      if (existing) {
        deleteTranscriptRows(db, target.project, target.sessionId, target.agentId);
        stats.removed++;
      }
      continue;
    }
    if (existing && existing.file_mtime_ms === Math.round(stat.mtimeMs) && existing.file_size === stat.size) {
      stats.fresh++;
      continue;
    }
    try {
      indexTranscriptFile(db, target);
      stats.indexed++;
    } catch (err) {
      deleteTranscriptRows(db, target.project, target.sessionId, target.agentId);
      stats.failed++;
      stats.failures.push({
        project: target.project,
        session_id: target.sessionId,
        agent_id: target.agentId,
        file_path: target.filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const key of watermarks.keys()) {
    if (seenKeys.has(key)) continue;
    const [project, sessionId, agentId] = key.split('\u0000');
    deleteTranscriptRows(db, project!, sessionId!, agentId!);
    stats.removed++;
  }

  return stats;
}

export function computeIndexFreshness(db: Database, contexts: SearchProjectContext[]): IndexFreshness {
  const freshness: IndexFreshness = { on_disk: 0, indexed: 0, fresh: 0, stale: 0, not_indexed: 0, orphaned: 0 };
  const targets: IndexTarget[] = [];
  const seenProjects = new Set<string>();
  for (const context of contexts) {
    if (seenProjects.has(context.projectRef.project)) continue;
    seenProjects.add(context.projectRef.project);
    targets.push(...listIndexTargetsForContext(context));
  }
  const watermarks = loadWatermarks(db, Array.from(seenProjects));
  freshness.indexed = watermarks.size;
  const seenKeys = new Set<string>();
  for (const target of targets) {
    freshness.on_disk++;
    const key = targetKey(target.project, target.sessionId, target.agentId);
    seenKeys.add(key);
    const existing = watermarks.get(key);
    if (!existing) {
      freshness.not_indexed++;
      continue;
    }
    try {
      const stat = statSync(target.filePath);
      if (existing.file_mtime_ms === Math.round(stat.mtimeMs) && existing.file_size === stat.size) {
        freshness.fresh++;
      } else {
        freshness.stale++;
      }
    } catch {
      freshness.stale++;
    }
  }
  for (const key of watermarks.keys()) {
    if (!seenKeys.has(key)) freshness.orphaned++;
  }
  return freshness;
}

function countTable(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function queryIndexStatus(db: Database, dbPath: string, contexts: SearchProjectContext[]): IndexStatus {
  let dbSize: number | null = null;
  if (dbPath !== ':memory:') {
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      dbSize = null;
    }
  }
  const projectsRow = db.query('SELECT COUNT(DISTINCT project) AS n FROM session').get() as { n: number };
  return {
    db_path: dbPath,
    schema_version: readSchemaVersion(db) ?? INDEX_SCHEMA_VERSION,
    db_size_bytes: dbSize,
    sessions: countTable(db, 'session'),
    turns: countTable(db, 'turn'),
    tool_uses: countTable(db, 'tool_use'),
    projects: projectsRow.n,
    scope: computeIndexFreshness(db, contexts),
  };
}

function projectsPlaceholderClause(projects: string[]): { clause: string; params: string[] } {
  const placeholders = projects.map(() => '?').join(', ');
  return { clause: `project IN (${placeholders})`, params: projects };
}

/** Monday-anchored week bucket, matching bucketCounterRows in search.ts. */
const WEEK_BUCKET_SQL = "date(ts, '-6 days', 'weekday 1')";
const DAY_BUCKET_SQL = 'substr(ts, 1, 10)';

export function queryTokenStats(db: Database, options: TokenStatsOptions): TokenStatsRow[] {
  if (options.projects.length === 0) return [];
  const { clause, params } = projectsPlaceholderClause(options.projects);
  const where: string[] = [clause, "role = 'assistant'"];
  const queryParams: Array<string | number> = [...params];
  if (!options.includeSubagents) {
    where.push("agent_id = ''");
  }
  if (options.after) {
    where.push('ts >= ?');
    queryParams.push(options.after);
  }
  if (options.before) {
    where.push('ts <= ?');
    queryParams.push(options.before);
  }

  const selectCols: string[] = [];
  const groupCols: string[] = [];
  if (options.bucket) {
    const bucketExpr = options.bucket === 'week' ? WEEK_BUCKET_SQL : DAY_BUCKET_SQL;
    selectCols.push(`COALESCE(${bucketExpr}, 'unknown') AS bucket`);
    groupCols.push('bucket');
  }
  if (options.by === 'model') {
    selectCols.push('model');
    groupCols.push('model');
  } else if (options.by === 'session') {
    selectCols.push('project', 'session_id', 'agent_id');
    groupCols.push('project', 'session_id', 'agent_id');
  }

  const select = [
    ...selectCols,
    'COUNT(*) AS turns',
    `COUNT(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                  OR cache_read_input_tokens IS NOT NULL OR cache_creation_input_tokens IS NOT NULL
            THEN 1 END) AS turns_with_usage`,
    'SUM(input_tokens) AS input_tokens',
    'SUM(output_tokens) AS output_tokens',
    'SUM(cache_read_input_tokens) AS cache_read_input_tokens',
    'SUM(cache_creation_input_tokens) AS cache_creation_input_tokens',
  ].join(', ');

  const groupBy = groupCols.length > 0 ? ` GROUP BY ${groupCols.join(', ')}` : '';
  const orderBy = groupCols.length > 0 ? ` ORDER BY ${groupCols.map(col => `${col} DESC`).join(', ')}` : '';
  // Raw row keys mirror the SELECT aliases above; cast once here so the mapping below needs no per-field casts.
  type TokenStatsRawRow = {
    bucket?: string;
    model?: string | null;
    project?: string;
    session_id?: string;
    agent_id?: string;
    turns: number;
    turns_with_usage: number;
    input_tokens: TokenCount;
    output_tokens: TokenCount;
    cache_read_input_tokens: TokenCount;
    cache_creation_input_tokens: TokenCount;
  };
  const rows = db.query(
    `SELECT ${select} FROM turn WHERE ${where.join(' AND ')}${groupBy}${orderBy}`,
  ).all(...queryParams) as TokenStatsRawRow[];

  return rows.map(raw => {
    const input = raw.input_tokens;
    const cacheRead = raw.cache_read_input_tokens;
    const cacheCreate = raw.cache_creation_input_tokens;
    let cacheHitRate: number | null = null;
    if (input !== null || cacheRead !== null || cacheCreate !== null) {
      const denominator = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
      if (denominator > 0) {
        cacheHitRate = Math.round(((cacheRead ?? 0) / denominator) * 10000) / 10000;
      }
    }
    const row: TokenStatsRow = {
      turns: raw.turns,
      turns_with_usage: raw.turns_with_usage,
      input_tokens: input,
      output_tokens: raw.output_tokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cache_hit_rate: cacheHitRate,
    };
    if (options.bucket) row.bucket = raw.bucket;
    if (options.by === 'model') row.model = raw.model ?? null;
    if (options.by === 'session') {
      row.project = raw.project;
      row.session_id = raw.session_id;
      row.agent_id = raw.agent_id === PARENT_AGENT_ID ? null : raw.agent_id;
    }
    return row;
  });
}

export function queryToolPairs(db: Database, options: ToolPairsOptions): ToolPairRow[] {
  if (options.projects.length === 0) return [];
  const { clause, params } = projectsPlaceholderClause(options.projects);
  const innerWhere: string[] = [clause];
  const queryParams: Array<string | number> = [...params];
  if (!options.includeSubagents) {
    innerWhere.push("agent_id = ''");
  }

  const outerWhere: string[] = [];
  if (options.prev) {
    outerWhere.push('prev_tool = ?');
    queryParams.push(options.prev);
  }
  if (options.next) {
    outerWhere.push('tool = ?');
    queryParams.push(options.next);
  }
  if (options.operation) {
    outerWhere.push('operation = ?');
    queryParams.push(options.operation);
  }
  if (options.pathMatch) {
    outerWhere.push('file_path LIKE ? ESCAPE \'\\\'');
    queryParams.push(`%${options.pathMatch.replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
  }
  queryParams.push(options.limit);

  const rows = db.query(`
    WITH seq AS (
      SELECT tool, operation, file_path,
             LAG(tool) OVER (
               PARTITION BY project, session_id, agent_id
               ORDER BY turn, block_index
             ) AS prev_tool
      FROM tool_use
      WHERE ${innerWhere.join(' AND ')}
    )
    SELECT prev_tool, tool, COUNT(*) AS count
    FROM seq
    ${outerWhere.length > 0 ? `WHERE ${outerWhere.join(' AND ')}` : ''}
    GROUP BY prev_tool, tool
    ORDER BY count DESC, prev_tool, tool
    LIMIT ?
  `).all(...queryParams) as Array<{ prev_tool: string | null; tool: string; count: number }>;

  return rows;
}
