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

interface PeekRow {
  id: string
  session_id: string
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

// Bridges background jobs to the agent: the MCP server writes finished runs to
// the central jobs.db, and this plugin injects them as visible session messages
// (which both wake an idle session and leave a persistent record in the chat),
// plus a TUI toast for immediate feedback.
// Runs are matched by the instance directory so a job started in one project is
// only ever delivered to that project; within a project, the most recently
// active session receives it.
// It also answers session_peeks rows: the MCP server is a separate process and
// cannot read a session, so bgj_output(session_id) files a request and this
// plugin, which runs inside opencode, reads the session and writes the answer.
// ponytail: notifies the most recently active session in the directory. Tag
// runs with a session id if multiple concurrent sessions need their own
// notifications.
export default async function bgjNotify(input: PluginInput) {
  const directory = input.directory
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

  const servicePeeks = async (db: Database) => {
    if (!directory || !input.client.session.messages) return
    const rows = db
      .query("SELECT id, session_id FROM session_peeks WHERE status = 'pending' AND directory = ? ORDER BY created_at LIMIT 10")
      .all(directory) as PeekRow[]
    for (const row of rows) {
      try {
        const entries = (unwrap(await input.client.session.messages({ path: { id: row.session_id } })) ?? []) as MessageEntry[]
        const list = Array.isArray(entries) ? entries : []
        const last = list[list.length - 1]
        const running = last?.info?.role === "assistant" && last.info.time?.completed === undefined
        db.query("UPDATE session_peeks SET status = 'done', text = ?, running = ?, messages = ?, answered_at = ? WHERE id = ?").run(
          latestText(list),
          running ? 1 : 0,
          list.length,
          Date.now(),
          row.id,
        )
      } catch (error) {
        db.query("UPDATE session_peeks SET status = 'error', error = ?, answered_at = ? WHERE id = ?").run(
          error instanceof Error ? error.message : String(error),
          Date.now(),
          row.id,
        )
      }
    }
  }

  const poll = async () => {
    if (polling || !directory) return
    const path = databasePath()
    if (!existsSync(path)) return
    polling = true
    let db: Database | undefined
    try {
      db = new Database(path)
      db.exec("PRAGMA busy_timeout = 3000")
      registerInstance(db)
      await servicePeeks(db)
      if (!sessionID) return
      const rows = db
        .query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 AND directory = ? ORDER BY ended_at LIMIT 20")
        .all(directory) as RunRow[]
      for (const row of rows) {
        const id = sessionID
        try {
          const res: unknown = await input.client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text: render(row) }] } })
          if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
            throw new Error(`promptAsync returned an error: ${JSON.stringify((res as { error?: unknown }).error)}`)
          }
          db.query("DELETE FROM job_runs WHERE id = ?").run(row.id)
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
  }
}
