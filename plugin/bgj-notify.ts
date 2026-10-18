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
}

interface PluginInput {
  client: {
    session: {
      promptAsync: (options: { path: { id: string }; body: { parts: unknown[] } }) => Promise<unknown>
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

// Bridges background jobs to the agent: the MCP server writes finished runs to
// the central jobs.db, and this plugin injects them as visible session messages
// (which both wake an idle session and leave a persistent record in the chat),
// plus a TUI toast for immediate feedback.
// ponytail: notifies the most recently active session. Tag runs with a session
// id if multiple concurrent sessions need their own notifications.
export default async function bgjNotify(input: PluginInput) {
  let sessionID: string | undefined
  let polling = false

  const poll = async () => {
    if (polling || !sessionID) return
    const path = databasePath()
    if (!existsSync(path)) return
    polling = true
    let db: Database | undefined
    try {
      db = new Database(path)
      db.exec("PRAGMA busy_timeout = 3000")
      const rows = db.query("SELECT * FROM job_runs WHERE notify = 1 AND notified = 0 ORDER BY ended_at LIMIT 20").all() as RunRow[]
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
