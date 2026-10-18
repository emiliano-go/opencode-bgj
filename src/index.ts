import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { JobManager } from "./jobs"
import type { JobRunInput } from "./store"
import { JobStore } from "./store"
import { TOOLS, dispatch } from "./tools"

let store: JobStore | undefined
try {
  store = new JobStore()
  store.pruneRuns(24 * 60 * 60 * 1000)
} catch (error) {
  console.error(`opencode-bgj: persistent job store unavailable: ${error instanceof Error ? error.message : error}`)
}

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
  }
  store.recordRun(run)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const server = new Server({ name: "opencode-bgj", version: "0.3.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  dispatch(jobs, store, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
)

await server.connect(new StdioServerTransport())
