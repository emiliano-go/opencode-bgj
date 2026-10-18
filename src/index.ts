import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { JobManager } from "./jobs"
import { TOOLS, dispatch } from "./tools"

const jobs = new JobManager()
const server = new Server({ name: "opencode-bgj", version: "0.1.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  dispatch(jobs, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
)

await server.connect(new StdioServerTransport())
