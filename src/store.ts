import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface JobDefinition {
  id: string
  name: string
  command: string
  cwd?: string
  env?: Record<string, string>
  shell?: string
  timeout_ms?: number
  metadata?: Record<string, unknown>
  created_at: number
  updated_at: number
}

export interface JobDefinitionInput {
  name: string
  command: string
  cwd?: string
  env?: Record<string, string>
  shell?: string
  timeout_ms?: number
  metadata?: Record<string, unknown>
}

export type JobDefinitionPatch = Partial<JobDefinitionInput>

export interface JobRunInput {
  id: string
  command: string
  cwd?: string
  status: string
  exit_code: number | null
  output: string
  notify: boolean
  started_at: number
  ended_at: number
  definition_id?: string
  definition_name?: string
  metadata?: Record<string, unknown>
  // The opencode instance directory the run belongs to, used to route its
  // completion notification back to the right project. See pendingRuns.
  directory?: string
}

export interface JobRun extends JobRunInput {
  notified: boolean
}

export type SessionOp = "peek" | "status" | "list" | "abort"

// A request the MCP server files for the plugin to answer from inside opencode,
// because the server is a separate process and cannot touch a session itself.
export interface SessionRequest {
  id: string
  directory: string
  session_id?: string
  op: SessionOp
  status: "pending" | "done" | "error"
  result?: unknown
  error?: string
  created_at: number
  answered_at?: number
}

export interface DetachedRunInput {
  id: string
  command: string
  cwd?: string
  pid: number
  status: string
  exit_code: number | null
  started_at: number
  ended_at: number | null
  directory?: string
}

export interface DetachedRun extends DetachedRunInput {}

export interface DetachedRunPatch {
  status?: string
  exit_code?: number | null
  ended_at?: number | null
}

interface DetachedRow {
  id: string
  command: string
  cwd: string | null
  pid: number
  status: string
  exit_code: number | null
  started_at: number
  ended_at: number | null
  directory: string | null
}

interface RunRow {
  id: string
  definition_id: string | null
  definition_name: string | null
  command: string
  cwd: string | null
  status: string
  exit_code: number | null
  output: string | null
  notify: number
  notified: number
  metadata: string | null
  started_at: number
  ended_at: number
  directory: string | null
}

interface Row {
  id: string
  name: string
  command: string
  cwd: string | null
  env: string | null
  shell: string | null
  timeout_ms: number | null
  metadata: string | null
  created_at: number
  updated_at: number
}

interface SessionRequestRow {
  id: string
  directory: string
  session_id: string | null
  op: string
  status: string
  result: string | null
  error: string | null
  created_at: number
  answered_at: number | null
}

// Centralized, shared across every project and session. Override with
// OPENCODE_BGJ_DB.
export function defaultDatabasePath(): string {
  if (process.env.OPENCODE_BGJ_DB) return process.env.OPENCODE_BGJ_DB
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode-bgj", "jobs.db")
}

// Where run_detached logs and exit markers live. Kept beside the database so an
// OPENCODE_BGJ_DB override (tests) isolates the files too; OPENCODE_BGJ_RUNS
// overrides it outright.
export function defaultRunsDir(dbPath: string = defaultDatabasePath()): string {
  if (process.env.OPENCODE_BGJ_RUNS) return process.env.OPENCODE_BGJ_RUNS
  if (dbPath === ":memory:") return join(tmpdir(), "opencode-bgj-runs", randomSuffix())
  return join(dirname(dbPath), "runs")
}

export class JobStore {
  private readonly db: Database
  private readonly detachedDir: string
  private closed = false

  constructor(path: string = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.detachedDir = defaultRunsDir(path)
    mkdirSync(this.detachedDir, { recursive: true })
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        command TEXT NOT NULL,
        cwd TEXT,
        env TEXT,
        shell TEXT,
        timeout_ms INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT,
        definition_name TEXT,
        command TEXT NOT NULL,
        cwd TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT,
        notify INTEGER NOT NULL DEFAULT 1,
        notified INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        directory TEXT
      )
    `)
    if (!this.hasColumn("job_runs", "directory")) this.db.exec("ALTER TABLE job_runs ADD COLUMN directory TEXT")
    this.db.exec("CREATE INDEX IF NOT EXISTS job_runs_pending ON job_runs (notify, notified, ended_at)")
    this.db.exec("CREATE INDEX IF NOT EXISTS job_runs_pending_dir ON job_runs (notify, notified, directory, ended_at)")
    // Written by the plugin, which knows the opencode server URL; read by the
    // server as a liveness signal for the directory's instance. The TUI runs its
    // server in-process, so the URL is informational and not reachable from here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        directory TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // The MCP server cannot touch a session in-process (it is a separate
    // process), so it files a request here and the plugin, which shares the
    // opencode process, answers it on its next poll. op selects the action
    // (peek, status, list, abort) and result holds the JSON answer.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_requests (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        session_id TEXT,
        op TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      )
    `)
    this.db.exec("CREATE INDEX IF NOT EXISTS session_requests_pending ON session_requests (status, directory, created_at)")
    // Superseded by session_requests; drop the old transient table.
    this.db.exec("DROP TABLE IF EXISTS session_peeks")
    // run_detached jobs: spawned in their own session so they outlive this
    // process, with output on disk. Kept out of job_runs so they never enter
    // the plugin's notify queue; that is what makes a detached job silent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS detached_runs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        cwd TEXT,
        pid INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        directory TEXT
      )
    `)
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return columns.some((entry) => entry.name === column)
  }

  create(input: JobDefinitionInput): JobDefinition {
    const name = requiredString(input.name, "name")
    const command = requiredString(input.command, "command")
    if (this.find(name)) throw new Error(`job name already exists: ${name}`)
    const id = `job-${randomSuffix()}`
    const now = Date.now()
    this.db
      .query("INSERT INTO job_definitions (id, name, command, cwd, env, shell, timeout_ms, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        name,
        command,
        input.cwd ?? null,
        input.env ? JSON.stringify(input.env) : null,
        input.shell ?? null,
        input.timeout_ms ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      )
    return this.get(id)!
  }

  list(): JobDefinition[] {
    const rows = this.db.query("SELECT * FROM job_definitions ORDER BY created_at, name").all() as Row[]
    return rows.map(toDefinition)
  }

  get(idOrName: string): JobDefinition | undefined {
    const row = this.find(idOrName)
    return row ? toDefinition(row) : undefined
  }

  update(idOrName: string, patch: JobDefinitionPatch): JobDefinition | undefined {
    const current = this.find(idOrName)
    if (!current) return undefined
    const next = {
      name: patch.name !== undefined ? requiredString(patch.name, "name") : current.name,
      command: patch.command !== undefined ? requiredString(patch.command, "command") : current.command,
      cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
      env: patch.env !== undefined ? (patch.env ? JSON.stringify(patch.env) : null) : current.env,
      shell: patch.shell !== undefined ? patch.shell : current.shell,
      timeout_ms: patch.timeout_ms !== undefined ? patch.timeout_ms : current.timeout_ms,
      metadata:
        patch.metadata !== undefined ? (patch.metadata ? JSON.stringify(patch.metadata) : null) : current.metadata,
      updated_at: Date.now(),
    }
    if (next.name !== current.name && this.find(next.name)) throw new Error(`job name already exists: ${next.name}`)
    this.db
      .query("UPDATE job_definitions SET name = ?, command = ?, cwd = ?, env = ?, shell = ?, timeout_ms = ?, metadata = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.command, next.cwd, next.env, next.shell, next.timeout_ms, next.metadata, next.updated_at, current.id)
    return this.get(current.id)!
  }

  delete(idOrName: string): boolean {
    const row = this.find(idOrName)
    if (!row) return false
    this.db.query("DELETE FROM job_definitions WHERE id = ?").run(row.id)
    return true
  }

  recordRun(run: JobRunInput): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO job_runs (id, definition_id, definition_name, command, cwd, status, exit_code, output, notify, notified, metadata, started_at, ended_at, directory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.definition_id ?? null,
        run.definition_name ?? null,
        run.command,
        run.cwd ?? null,
        run.status,
        run.exit_code,
        run.output,
        run.notify ? 1 : 0,
        run.metadata ? JSON.stringify(run.metadata) : null,
        run.started_at,
        run.ended_at,
        run.directory ?? null,
      )
  }

  // Only runs recorded by the requesting instance directory are returned, so a
  // run started in one project is never delivered to another project's session.
  // Rows written before the directory column existed (NULL) match no directory
  // and are left to pruneRuns.
  pendingRuns(directory?: string, limit = 50): JobRun[] {
    const rows = (
      directory === undefined
        ? this.db.query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 ORDER BY ended_at LIMIT ?").all(limit)
        : this.db
            .query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 AND directory = ? ORDER BY ended_at LIMIT ?")
            .all(directory, limit)
    ) as RunRow[]
    return rows.map(toRun)
  }

  deleteRun(id: string): boolean {
    return this.db.query("DELETE FROM job_runs WHERE id = ?").run(id).changes > 0
  }

  // The plugin registers the opencode server URL for its directory so the MCP
  // server can read a running session's output over HTTP.
  setInstance(directory: string, url: string): void {
    this.db
      .query(
        "INSERT INTO instances (directory, url, updated_at) VALUES (?, ?, ?) ON CONFLICT(directory) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
      )
      .run(directory, url, Date.now())
  }

  instanceURL(directory: string): string | undefined {
    const row = this.db.query("SELECT url FROM instances WHERE directory = ?").get(directory) as { url: string } | null
    return row?.url
  }

  hasInstance(directory: string): boolean {
    return this.db.query("SELECT 1 FROM instances WHERE directory = ? LIMIT 1").get(directory) !== null
  }

  createSessionRequest(directory: string, op: SessionOp, sessionID?: string): string {
    const id = `req-${randomSuffix()}`
    this.db
      .query("INSERT INTO session_requests (id, directory, session_id, op, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(id, directory, sessionID ?? null, op, Date.now())
    return id
  }

  sessionRequest(id: string): SessionRequest | undefined {
    const row = this.db.query("SELECT * FROM session_requests WHERE id = ?").get(id) as SessionRequestRow | null
    return row ? toSessionRequest(row) : undefined
  }

  // Called by tests; the plugin writes the same columns through raw SQL, and
  // the server only reads.
  answerSessionRequest(id: string, result: unknown): void {
    this.db
      .query("UPDATE session_requests SET status = 'done', result = ?, answered_at = ? WHERE id = ?")
      .run(JSON.stringify(result), Date.now(), id)
  }

  failSessionRequest(id: string, error: string): void {
    this.db
      .query("UPDATE session_requests SET status = 'error', error = ?, answered_at = ? WHERE id = ?")
      .run(error, Date.now(), id)
  }

  deleteSessionRequest(id: string): void {
    this.db.query("DELETE FROM session_requests WHERE id = ?").run(id)
  }

  // The plugin reads these rows with its own SQL (it runs inside opencode, a
  // separate runtime); this is the store-side view used by tests.
  pendingSessionRequests(directory: string, limit = 10): { id: string; session_id: string | null; op: SessionOp }[] {
    return this.db
      .query("SELECT id, session_id, op FROM session_requests WHERE status = 'pending' AND directory = ? ORDER BY created_at LIMIT ?")
      .all(directory, limit) as { id: string; session_id: string | null; op: SessionOp }[]
  }

  pruneSessionRequests(olderThanMs: number): number {
    return this.db.query("DELETE FROM session_requests WHERE created_at < ?").run(Date.now() - olderThanMs).changes
  }

  runsDir(): string {
    return this.detachedDir
  }

  detachedLogPath(id: string): string {
    return join(this.detachedDir, `${id}.log`)
  }

  detachedExitPath(id: string): string {
    return join(this.detachedDir, `${id}.exit`)
  }

  detachedStopPath(id: string): string {
    return join(this.detachedDir, `${id}.stop`)
  }

  createDetached(run: DetachedRunInput): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO detached_runs (id, command, cwd, pid, status, exit_code, started_at, ended_at, directory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(run.id, run.command, run.cwd ?? null, run.pid, run.status, run.exit_code, run.started_at, run.ended_at, run.directory ?? null)
  }

  detached(id: string): DetachedRun | undefined {
    const row = this.db.query("SELECT * FROM detached_runs WHERE id = ?").get(id) as DetachedRow | null
    return row ? toDetached(row) : undefined
  }

  listDetached(limit = 100): DetachedRun[] {
    const rows = this.db.query("SELECT * FROM detached_runs ORDER BY started_at LIMIT ?").all(limit) as DetachedRow[]
    return rows.map(toDetached)
  }

  updateDetached(id: string, patch: DetachedRunPatch): void {
    const current = this.detached(id)
    if (!current) return
    this.db
      .query("UPDATE detached_runs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?")
      .run(
        patch.status ?? current.status,
        patch.exit_code !== undefined ? patch.exit_code : current.exit_code,
        patch.ended_at !== undefined ? patch.ended_at : current.ended_at,
        id,
      )
  }

  // Removes finished rows past the cutoff and their log and marker files. A job
  // still marked running is left in place however old it is.
  pruneDetached(olderThanMs: number): number {
    const rows = this.db
      .query("SELECT id, status FROM detached_runs WHERE COALESCE(ended_at, started_at) < ?")
      .all(Date.now() - olderThanMs) as { id: string; status: string }[]
    const removable = rows.filter((row) => row.status !== "running")
    let changes = 0
    for (const row of removable) {
      for (const path of [this.detachedLogPath(row.id), this.detachedExitPath(row.id), this.detachedStopPath(row.id)]) {
        try {
          rmSync(path, { force: true })
        } catch {
          // best effort: a missing or locked file must not block the prune
        }
      }
      changes += this.db.query("DELETE FROM detached_runs WHERE id = ?").run(row.id).changes
    }
    return changes
  }

  pruneRuns(olderThanMs: number): number {
    return this.db.query("DELETE FROM job_runs WHERE ended_at < ?").run(Date.now() - olderThanMs).changes
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // already closed, or the connection is gone
    }
  }

  private find(idOrName: string): Row | undefined {
    const row = this.db.query("SELECT * FROM job_definitions WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName)
    return (row as Row | null) ?? undefined
  }
}

function toDefinition(row: Row): JobDefinition {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    cwd: row.cwd ?? undefined,
    env: parseJson<Record<string, string>>(row.env),
    shell: row.shell ?? undefined,
    timeout_ms: row.timeout_ms ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toRun(row: RunRow): JobRun {
  return {
    id: row.id,
    definition_id: row.definition_id ?? undefined,
    definition_name: row.definition_name ?? undefined,
    command: row.command,
    cwd: row.cwd ?? undefined,
    status: row.status,
    exit_code: row.exit_code,
    output: row.output ?? "",
    notify: row.notify === 1,
    notified: row.notified === 1,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    started_at: row.started_at,
    ended_at: row.ended_at,
    directory: row.directory ?? undefined,
  }
}

function toDetached(row: DetachedRow): DetachedRun {
  return {
    id: row.id,
    command: row.command,
    cwd: row.cwd ?? undefined,
    pid: row.pid,
    status: row.status,
    exit_code: row.exit_code,
    started_at: row.started_at,
    ended_at: row.ended_at,
    directory: row.directory ?? undefined,
  }
}

function toSessionRequest(row: SessionRequestRow): SessionRequest {
  return {
    id: row.id,
    directory: row.directory,
    session_id: row.session_id ?? undefined,
    op: row.op as SessionOp,
    status: row.status as SessionRequest["status"],
    result: parseJson<unknown>(row.result),
    error: row.error ?? undefined,
    created_at: row.created_at,
    answered_at: row.answered_at ?? undefined,
  }
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ""
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
  return suffix
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`)
  return value
}
