import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import pkg from "../package.json" with { type: "json" }
import { DetachedManager } from "./detached"
import { JobManager } from "./jobs"
import type { JobRunInput } from "./store"
import { JobStore } from "./store"
import { TOOLS, dispatch } from "./tools"

function log(message: string) {
  console.error(`opencode-bgj: ${message}`)
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Never let an unexpected error or a rejected promise take the server down. A
// dropped MCP server would strand the session, so log and keep serving.
process.on("uncaughtException", (error) => log(`uncaught exception: ${reason(error)}`))
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${reason(error)}`))

let store: JobStore | undefined
try {
  store = new JobStore()
  store.pruneRuns(24 * 60 * 60 * 1000)
  store.pruneSessionPeeks(24 * 60 * 60 * 1000)
  store.pruneDetached(24 * 60 * 60 * 1000)
} catch (error) {
  log(`persistent job store unavailable: ${reason(error)}`)
}

const detached = store ? new DetachedManager(store) : undefined

// opencode spawns stdio servers with cwd set to the instance directory, so this
// identifies the project a run belongs to and lets the plugin deliver the
// completion only to that project's session.
// ponytail: assumes the default spawn cwd; switch to an MCP roots/list query if
// a custom mcp.cwd is ever configured.
const directory = process.cwd()

const jobs = new JobManager((result) => {
  if (!store) return
  const info = result.info
  const meta = result.meta ?? {}
  const run: JobRunInput = {
    id: info.id,
    command: info.command,
    cwd: info.cwd,
    status: info.status,
    exit_code: info.exit_code,
    output: result.output,
    notify: result.notify,
    started_at: info.started_at,
    ended_at: info.ended_at ?? Date.now(),
    definition_id: typeof meta.definition_id === "string" ? meta.definition_id : undefined,
    definition_name: typeof meta.definition_name === "string" ? meta.definition_name : undefined,
    metadata: isRecord(meta.metadata) ? meta.metadata : undefined,
    directory,
  }
  try {
    store.recordRun(run)
  } catch (error) {
    log(`failed to record run ${info.id}: ${reason(error)}`)
  }
})

const server = new Server({ name: "opencode-bgj", version: pkg.version }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  dispatch(jobs, store, detached, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, directory),
)

function shutdown(signal: string) {
  log(`received ${signal}, shutting down`)
  store?.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("exit", () => store?.close())

try {
  await server.connect(new StdioServerTransport())
  log(`ready (v${pkg.version})`)
} catch (error) {
  log(`failed to start: ${reason(error)}`)
  process.exit(1)
}
