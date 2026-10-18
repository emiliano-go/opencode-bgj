import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const POLL_MS = Number(process.env.BGJ_POLL_MS ?? 1000)
const MAX_PREVIEW = 4000

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
  time?: { created?: number }
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

function databasePath(): string {
  if (process.env.OPENCODE_BGJ_DB) return process.env.OPENCODE_BGJ_DB
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode-bgj", "jobs.db")
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
    const parsed = JSON.parse(text) as { job_id?: unknown }
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
// this plugin watches the bgj start tools through tool.execute.after, remembers
// job_id -> sessionID, and delivers each completion to the session that started
// it. The most recently active session is only the fallback.
// It also answers session_requests rows: the MCP server is a separate process and
// cannot read or control a session, so the session tools file a request (op is
// peek, status, list, or abort) and this plugin, which runs inside opencode,
// answers it: peek/status read the latest assistant text, list returns the
// directory's child sessions (background subagents), abort cancels a session.
// ponytail: the job_id -> session map lives in memory. A runtime job can only
// finish while opencode (and this plugin) is alive, so it never needs to survive
// a restart; prune it if that ever changes.
const JOB_SESSION_TTL_MS = 60 * 60 * 1000

export default async function bgjNotify(input: PluginInput) {
  const directory = input.directory
  const jobSessions = new Map<string, { session: string; at: number }>()
  let sessionID: string | undefined
  let polling = false
  let registered = false

  const registerInstance = (db: Database) => {
    if (registered || !directory) return
    db.exec("CREATE TABLE IF NOT EXISTS instances (directory TEXT PRIMARY KEY, url TEXT NOT NULL, updated_at INTEGER NOT NULL)")
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
    const entries = (unwrap(await input.client.session.messages!({ path: { id: sessionID } })) ?? []) as MessageEntry[]
    const list = Array.isArray(entries) ? entries : []
    const last = list[list.length - 1]
    const running = last?.info?.role === "assistant" && last.info.time?.completed === undefined
    return { text: latestText(list), running, messages: list.length }
  }

  // Child sessions are the ones the task tool spawns for subagents; the parent
  // listing would include every top-level chat in the project.
  const listSubagents = async () => {
    if (!input.client.session.list || !input.client.session.status) throw new Error("session.list/status unavailable")
    const raw = (unwrap(await input.client.session.list({ query: { directory } })) ?? []) as SessionShape[]
    const sessions = (Array.isArray(raw) ? raw : []).filter((session) => typeof session.id === "string" && !!session.parentID)
    const statuses = (unwrap(await input.client.session.status({ query: { directory } })) ?? {}) as Record<string, SessionStatusShape>
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
          await input.client.session.abort?.({ path: { id: row.session_id } })
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

  const poll = async () => {
    if (polling || !directory) return
    const cutoff = Date.now() - JOB_SESSION_TTL_MS
    for (const [id, entry] of jobSessions) if (entry.at < cutoff) jobSessions.delete(id)
    const path = databasePath()
    if (!existsSync(path)) return
    polling = true
    let db: Database | undefined
    try {
      db = new Database(path)
      db.exec("PRAGMA busy_timeout = 3000")
      registerInstance(db)
      await serviceRequests(db)
      const rows = db
        .query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 AND directory = ? ORDER BY ended_at LIMIT 20")
        .all(directory) as RunRow[]
      for (const row of rows) {
        const target = jobSessions.get(row.id)?.session ?? sessionID
        if (!target) continue
        try {
          const res: unknown = await input.client.session.promptAsync({ path: { id: target }, body: { parts: [{ type: "text", text: render(row) }] } })
          if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
            throw new Error(`promptAsync returned an error: ${JSON.stringify((res as { error?: unknown }).error)}`)
          }
          db.query("DELETE FROM job_runs WHERE id = ?").run(row.id)
          jobSessions.delete(row.id)
          try {
            await input.client.tui?.showToast?.({
              body: {
                title: "Background job finished",
                message: `${jobName(row)} (${row.status}, ${durationLabel(row)})`,
                variant: row.status === "completed" && (row.exit_code ?? 0) === 0 ? "success" : "error",
                duration: 8000,
              },
            })
          } catch {
            // no TUI attached (server mode); the wake message still records the completion
          }
        } catch (error) {
          console.error(`opencode-bgj: failed to deliver notification for ${row.id}:`, error)
        }
      }
    } catch {
      // database missing, table not created yet, or temporarily busy
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
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
    // Record which session started a job so its completion is delivered there.
    // Never throw: a hook error must not break the tool call.
    "tool.execute.after": async (hookInput: { tool?: string; sessionID?: string }, output: unknown) => {
      try {
        if (!hookInput?.tool || !hookInput?.sessionID) return
        if (!START_TOOL.test(hookInput.tool)) return
        const id = jobIdFromResult(output)
        if (typeof id !== "string" || !id.startsWith("bgj-")) return
        jobSessions.set(id, { session: hookInput.sessionID, at: Date.now() })
      } catch {
        // ignore: routing is best-effort, the directory fallback still works
      }
    },
  }
}
