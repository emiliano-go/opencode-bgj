import type { JobInfo } from "./jobs"
import { JobManager } from "./jobs"

export const TOOLS = [
  {
    name: "start",
    description: "Start a shell command as a background job. Returns immediately with a job id.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        cwd: { type: "string", description: "Working directory (defaults to the server cwd)." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables." },
        shell: { type: "string", description: "Shell binary (default /bin/sh)." },
        timeout_ms: { type: "integer", minimum: 1, description: "Kill the job after this many milliseconds." },
      },
      required: ["command"],
    },
  },
  {
    name: "list",
    description: "List background jobs.",
    inputSchema: {
      type: "object",
      properties: { active_only: { type: "boolean", description: "Only running jobs (default false)." } },
    },
  },
  {
    name: "status",
    description: "Get one job's status.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "output",
    description: "Read a job's captured stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        tail_bytes: { type: "integer", minimum: 0, description: "Return only the last N bytes." },
        offset: { type: "integer", minimum: 0, description: "Return output from this byte offset." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "stop",
    description: "Terminate a job (SIGTERM, then SIGKILL after a grace period).",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        signal: { type: "string", description: "Initial signal (default SIGTERM)." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "wait",
    description: "Wait for a job to finish, or until a timeout.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        timeout_s: { type: "number", minimum: 0, description: "Max seconds to wait (default: no limit)." },
      },
      required: ["job_id"],
    },
  },
]

export type ToolResult = Record<string, unknown>

export async function dispatch(jobs: JobManager, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "start":
        return ok(toWire(jobs.start({
          command: str(args.command, "command"),
          cwd: optionalStr(args.cwd),
          env: strRecord(args.env),
          shell: optionalStr(args.shell),
          timeout_ms: optionalInt(args.timeout_ms),
        })))
      case "list":
        return ok({ jobs: jobs.list(args.active_only === true).map(toWire) })
      case "status":
        return withJob(args.job_id, (id) => {
          const info = jobs.status(id)
          return info ? ok(toWire(info)) : unknownJob(id)
        })
      case "output":
        return withJob(args.job_id, (id) => {
          const result = jobs.output(id, { tailBytes: optionalInt(args.tail_bytes), offset: optionalInt(args.offset) })
          return result ? ok({ job_id: id, ...result }) : unknownJob(id)
        })
      case "stop":
        return await withJobAsync(args.job_id, async (id) => {
          const info = await jobs.stop(id, optionalStr(args.signal))
          return info ? ok(toWire(info)) : unknownJob(id)
        })
      case "wait":
        return await withJobAsync(args.job_id, async (id) => {
          if (!jobs.status(id)) return unknownJob(id)
          const timeout_s = optionalNumber(args.timeout_s)
          const result = await jobs.wait(id, timeout_s === undefined ? undefined : timeout_s * 1000)
          return ok({ job: toWire(result.job), timed_out: result.timed_out })
        })
      default:
        return fail(`unknown tool: ${name}`)
    }
  } catch (error) {
    return fail(errorMessage(error))
  }
}

export function toWire(info: JobInfo) {
  return {
    job_id: info.id,
    command: info.command,
    cwd: info.cwd,
    pid: info.pid,
    status: info.status,
    exit_code: info.exit_code,
    started_at: info.started_at,
    ended_at: info.ended_at,
    ...(info.error !== undefined ? { error: info.error } : {}),
  }
}

function ok(structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function unknownJob(id: string): ToolResult {
  return fail(`unknown job: ${id}`)
}

function withJob(value: unknown, handler: (id: string) => ToolResult): ToolResult {
  if (typeof value !== "string" || value.length === 0) return fail("job_id is required")
  return handler(value)
}

async function withJobAsync(value: unknown, handler: (id: string) => Promise<ToolResult>): Promise<ToolResult> {
  if (typeof value !== "string" || value.length === 0) return fail("job_id is required")
  return handler(value)
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`)
  return value
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function strRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
