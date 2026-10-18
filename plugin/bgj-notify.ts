import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const POLL_MS = Number(process.env.BGJ_POLL_MS ?? 1000)
const MAX_PREVIEW = 4000
// Every client call is bounded so a single hung request can never wedge the poll
// loop. Keep this below the client's mcp_timeout; raise it with
// OPENCODE_BGJ_DELIVER_TIMEOUT_MS if you raise mcp_timeout.
const DELIVER_TIMEOUT_MS = positiveNumber(process.env.OPENCODE_BGJ_DELIVER_TIMEOUT_MS, 10_000)
// A poll that somehow outlives this is treated as stuck and a fresh tick may run.
const POLL_STALL_MS = Math.max(DELIVER_TIMEOUT_MS * 4, 30_000)

interface RunRow {
  id: string
  definition_id: string | null
  definition_name: string | null
  command: string
  cwd: string | null
  status: string
  exit_code: number | null
  output: string | null
  metadata: string | null
  started_at: number
  ended_at: number
  directory: string | null
}

interface SessionRequestRow {
  id: string
  session_id: string | null
  op: string
}

interface SessionShape {
  id?: string
  parentID?: string
  title?: string
  time?: { created?: number; updated?: number }
}

interface SessionStatusShape {
  type?: string
}

type MessageEntry = {
  info?: { role?: string; time?: { completed?: number } }
  parts?: { type?: string; text?: string; synthetic?: boolean }[]
}

interface PluginInput {
  directory?: string
  serverUrl?: URL
  client: {
    session: {
      promptAsync: (options: { path: { id: string }; body: { parts: unknown[] } }) => Promise<unknown>
      messages?: (options: { path: { id: string } }) => Promise<unknown>
      list?: (options?: { query?: { directory?: string } }) => Promise<unknown>
      status?: (options?: { query?: { directory?: string } }) => Promise<unknown>
      abort?: (options: { path: { id: string } }) => Promise<unknown>
    }
    tui?: {
      showToast?: (options: {
        body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }
      }) => Promise<unknown>
    }
  }
}

interface EventInput {
  event: { type?: string; properties?: Record<string, unknown> }
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Races a client call against a timer so a request that never settles cannot
// hold the poll loop open forever.
function withTimeout<T>(work: Promise<T> | T, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([Promise.resolve(work), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function databasePath(): string {
  if (process.env.OPENCODE_BGJ_DB) return process.env.OPENCODE_BGJ_DB
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode-bgj", "jobs.db")
}

function openDatabase(): Database | undefined {
  const path = databasePath()
  if (!existsSync(path)) return undefined
  const db = new Database(path)
  db.exec("PRAGMA busy_timeout = 3000")
  return db
}

function ensureSchema(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS instances (directory TEXT PRIMARY KEY, url TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_sessions (
      job_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
}

function render(row: RunRow): string {
  const output = row.output ?? ""
  const preview = output.length > MAX_PREVIEW ? `...(truncated)...\n${output.slice(output.length - MAX_PREVIEW)}` : output
  const lines = ["A background job has finished.", ""]
  lines.push(`job_id: ${row.id}`)
  if (row.definition_name) lines.push(`definition: ${row.definition_name} (${row.definition_id})`)
  lines.push(`status: ${row.status}${row.exit_code === null ? "" : ` (exit code ${row.exit_code})`}`)
  lines.push(`command: ${row.command}`)
  if (row.cwd) lines.push(`directory: ${row.cwd}`)
  if (row.metadata) lines.push(`metadata: ${row.metadata}`)
  lines.push("", "output:", preview, "")
  lines.push("Call bgj_output with this job_id for the full output, then continue.")
  return lines.join("\n")
}

function jobName(row: RunRow): string {
  return row.definition_name ?? row.id
}

function durationLabel(row: RunRow): string {
  const seconds = Math.max(0, (row.ended_at - row.started_at) / 1000)
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${seconds.toFixed(1)}s`
}

function unwrap(response: unknown): unknown {
  if (response && typeof response === "object" && "data" in response) {
    const data = (response as { data?: unknown }).data
    if (data !== undefined) return data
    const error = (response as { error?: unknown }).error
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error))
  }
  return response
}

function latestText(entries: MessageEntry[]): string {
  const last = entries.findLast((entry) => entry.info?.role === "assistant")
  if (!last) return ""
  return (last.parts ?? [])
    .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
}

// tool.execute.after hands us the raw MCP CallToolResult: our start tools put the
// job id in structuredContent, with the text content as a JSON fallback.
function jobIdFromResult(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined
  const structured = (output as { structuredContent?: { job_id?: unknown } }).structuredContent
  if (typeof structured?.job_id === "string") return structured.job_id
  const content = (output as { content?: { text?: unknown }[] }).content
  const text = Array.isArray(content) ? content.find((item) => typeof item?.text === "string")?.text : undefined
  if (typeof text !== "string") return undefined
  try {
    const parsed = JSON.parse(text) as { job_id?: string }
    return typeof parsed?.job_id === "string" ? parsed.job_id : undefined
  } catch {
    return undefined
  }
}

const START_TOOL = /_start$|_run_job$/

// Bridges background jobs to the agent: the MCP server writes finished runs to
// the central jobs.db, and this plugin injects them as visible session messages
// (which both wake an idle session and leave a persistent record in the chat),
// plus a TUI toast for immediate feedback.
// Runs are matched by the instance directory so a job started in one project is
// only ever delivered to that project. Within a project the MCP server cannot
// learn which session started a job (opencode sends no session id to MCP), so
// this plugin watches the bgj start tools through tool.execute.after and writes
// job_id -> session to the shared job_sessions table. That mapping is persisted,
// so a completion still reaches the right session after the plugin or opencode
// restarts; a run with no mapping falls back to the most recent top-level
// session in the directory (never a subagent), resolved from session.list rather
// than a single event, so a backlog drains as soon as the directory is known.
// It also answers session_requests rows: the MCP server is a separate process and
// cannot read or control a session, so the session tools file a request (op is
// peek, status, list, or abort) and this plugin, which runs inside opencode,
// answers it: peek/status read the latest assistant text, list returns the
// directory's child sessions (background subagents), abort cancels a session.
export default async function bgjNotify(input: PluginInput) {
  const directory = input.directory
  let sessionID: string | undefined
  let polling = false
  let pollStartedAt = 0
  let registered = false
  // Runs we could not deliver yet, so the "no session" log is not repeated each poll.
  const held = new Set<string>()

  const registerInstance = (db: Database) => {
    if (registered || !directory) return
    db.query(
      "INSERT INTO instances (directory, url, updated_at) VALUES (?, ?, ?) ON CONFLICT(directory) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
    ).run(directory, input.serverUrl?.toString() ?? "", Date.now())
    registered = true
  }

  const answerRequest = (db: Database, id: string, result: unknown) =>
    db
      .query("UPDATE session_requests SET status = 'done', result = ?, answered_at = ? WHERE id = ?")
      .run(JSON.stringify(result ?? null), Date.now(), id)

  const failRequest = (db: Database, id: string, message: string) =>
    db.query("UPDATE session_requests SET status = 'error', error = ?, answered_at = ? WHERE id = ?").run(message, Date.now(), id)

  const snapshot = async (sessionID: string) => {
    const entries = (unwrap(
      await withTimeout(input.client.session.messages!({ path: { id: sessionID } }), DELIVER_TIMEOUT_MS, "session.messages"),
    ) ?? []) as MessageEntry[]
    const list = Array.isArray(entries) ? entries : []
    const last = list[list.length - 1]
    const running = last?.info?.role === "assistant" && last.info.time?.completed === undefined
    return { text: latestText(list), running, messages: list.length }
  }

  // Child sessions are the ones the task tool spawns for subagents; the parent
  // listing would include every top-level chat in the project.
  const listSubagents = async () => {
    if (!input.client.session.list || !input.client.session.status) throw new Error("session.list/status unavailable")
    const raw = (unwrap(
      await withTimeout(input.client.session.list({ query: { directory } }), DELIVER_TIMEOUT_MS, "session.list"),
    ) ?? []) as SessionShape[]
    const sessions = (Array.isArray(raw) ? raw : []).filter((session) => typeof session.id === "string" && !!session.parentID)
    const statuses = (unwrap(
      await withTimeout(input.client.session.status({ query: { directory } }), DELIVER_TIMEOUT_MS, "session.status"),
    ) ?? {}) as Record<string, SessionStatusShape>
    return {
      sessions: sessions.map((session) => ({
        session_id: session.id,
        parent_id: session.parentID,
        title: session.title,
        running: (statuses[session.id as string]?.type ?? "idle") !== "idle",
        created: session.time?.created,
      })),
    }
  }

  const serviceRequests = async (db: Database) => {
    if (!directory || !input.client.session.messages) return
    const rows = db
      .query("SELECT id, session_id, op FROM session_requests WHERE status = 'pending' AND directory = ? ORDER BY created_at LIMIT 10")
      .all(directory) as SessionRequestRow[]
    for (const row of rows) {
      try {
        if (row.op === "list") {
          answerRequest(db, row.id, await listSubagents())
          continue
        }
        if (!row.session_id) throw new Error(`${row.op} requires a session_id`)
        if (row.op === "abort") {
          await withTimeout(input.client.session.abort?.({ path: { id: row.session_id } }), DELIVER_TIMEOUT_MS, "session.abort")
          answerRequest(db, row.id, { aborted: true })
          continue
        }
        const state = await snapshot(row.session_id)
        if (row.op === "status") answerRequest(db, row.id, { running: state.running, messages: state.messages })
        else answerRequest(db, row.id, state)
      } catch (error) {
        failRequest(db, row.id, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // A last-resort target when the directory listing is unavailable; the event
  // hook keeps it as the session of the most recent event.
  const newestSession = async (): Promise<string | undefined> => {
    if (!input.client.session.list) return sessionID
    try {
      const raw = (unwrap(
        await withTimeout(input.client.session.list({ query: { directory } }), DELIVER_TIMEOUT_MS, "session.list"),
      ) ?? []) as SessionShape[]
      const sessions = (Array.isArray(raw) ? raw : []).filter((session) => typeof session.id === "string" && !session.parentID)
      sessions.sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
      return sessions[0]?.id ?? sessionID
    } catch {
      return sessionID
    }
  }

  const poll = async () => {
    if (!directory) return
    if (polling && Date.now() - pollStartedAt < POLL_STALL_MS) return
    polling = true
    pollStartedAt = Date.now()
    let db: Database | undefined
    try {
      // No database yet (the server has not written one): nothing to do, and the
      // finally below still clears the guard.
      db = openDatabase()
      if (!db) return
      ensureSchema(db)
      registerInstance(db)
      // Session requests are served in their own guarded block so a failure here
      // can never skip the job notifications below.
      try {
        await withTimeout(serviceRequests(db), DELIVER_TIMEOUT_MS, "session requests")
      } catch (error) {
        console.error("opencode-bgj: session request handling failed:", error)
      }
      const rows = db
        .query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 AND directory = ? ORDER BY ended_at LIMIT 20")
        .all(directory) as RunRow[]
      const deadline = Date.now() + DELIVER_TIMEOUT_MS
      let fallback: string | undefined
      let fallbackResolved = false
      for (const row of rows) {
        if (Date.now() > deadline) break
        const mapped = db.query("SELECT session_id FROM job_sessions WHERE job_id = ?").get(row.id) as { session_id: string } | null
        let target = mapped?.session_id
        if (!target) {
          if (!fallbackResolved) {
            fallback = await newestSession()
            fallbackResolved = true
          }
          target = fallback
        }
        if (!target) {
          if (!held.has(row.id)) {
            held.add(row.id)
            console.error(`opencode-bgj: no session known for ${row.id}; holding its completion until one appears`)
          }
          continue
        }
        try {
          const res: unknown = await withTimeout(
            input.client.session.promptAsync({ path: { id: target }, body: { parts: [{ type: "text", text: render(row) }] } }),
            DELIVER_TIMEOUT_MS,
            "promptAsync",
          )
          if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
            throw new Error(`promptAsync returned an error: ${JSON.stringify((res as { error?: unknown }).error)}`)
          }
          db.query("DELETE FROM job_runs WHERE id = ?").run(row.id)
          db.query("DELETE FROM job_sessions WHERE job_id = ?").run(row.id)
          held.delete(row.id)
          try {
            await withTimeout(
              input.client.tui?.showToast?.({
                body: {
                  title: "Background job finished",
                  message: `${jobName(row)} (${row.status}, ${durationLabel(row)})`,
                  variant: row.status === "completed" && (row.exit_code ?? 0) === 0 ? "success" : "error",
                  duration: 8000,
                },
              }),
              DELIVER_TIMEOUT_MS,
              "showToast",
            )
          } catch {
            // no TUI attached (server mode); the wake message still records the completion
          }
        } catch (error) {
          held.add(row.id)
          console.error(`opencode-bgj: failed to deliver notification for ${row.id}:`, error)
        }
      }
    } catch (error) {
      console.error("opencode-bgj: poll failed:", error)
    } finally {
      try {
        db?.close()
      } catch {
        // already closed, or the connection is gone
      }
      polling = false
    }
  }

  const onError = (error: unknown) => console.error("opencode-bgj: poll failed:", error)
  const timer = setInterval(() => void poll().catch(onError), POLL_MS)
  timer.unref?.()
  void poll().catch(onError)

  return {
    event: async ({ event }: EventInput) => {
      const id = event?.properties?.sessionID
      if (typeof id === "string" && id.length > 0) sessionID = id
    },
    // Record which session started a job so its completion is delivered there,
    // even after a restart. Never throw: a hook error must not break the tool call.
    "tool.execute.after": async (hookInput: { tool?: string; sessionID?: string }, output: unknown) => {
      try {
        if (!directory || !hookInput?.tool || !hookInput?.sessionID) return
        if (!START_TOOL.test(hookInput.tool)) return
        const id = jobIdFromResult(output)
        if (typeof id !== "string" || !id.startsWith("bgj-")) return
        const db = openDatabase()
        if (!db) return
        try {
          ensureSchema(db)
          db.query("INSERT OR REPLACE INTO job_sessions (job_id, session_id, directory, created_at) VALUES (?, ?, ?, ?)").run(
            id,
            hookInput.sessionID,
            directory,
            Date.now(),
          )
        } finally {
          db.close()
        }
      } catch {
        // routing is best-effort; the top-level session fallback still applies
      }
    },
  }
}
