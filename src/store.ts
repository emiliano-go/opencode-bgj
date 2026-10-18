import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
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

// Centralized, shared across every project and session. Override with
// OPENCODE_BGJ_DB.
export function defaultDatabasePath(): string {
  if (process.env.OPENCODE_BGJ_DB) return process.env.OPENCODE_BGJ_DB
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode-bgj", "jobs.db")
}

export class JobStore {
  private readonly db: Database
  private closed = false

  constructor(path: string = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
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
