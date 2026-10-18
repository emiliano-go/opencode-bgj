import type { JobInfo } from "./jobs"
import { JobManager } from "./jobs"
import type { JobDefinition, JobDefinitionPatch, JobStore } from "./store"

export const TOOLS = [
  {
    name: "start",
    description: `Start a shell command as a background job and return immediately with a job id, without waiting for it to finish. Use it for long-running work (builds, tests, downloads, servers) so you can keep working while it runs.
The command runs detached in its own process group, so it can be signalled as a group. Its stdout and stderr are captured into one merged buffer in the order produced; only the most recent 1 MiB is kept and older output is dropped.
By default the job's final status and captured output are reported back to the agent as a message when it finishes, which also wakes an idle session. Set notify to false to suppress that, for example when you intend to call wait yourself.
Returns the new job's job_id, command, cwd, pid, status ("running"), and started_at. Use status, output, wait, and stop with the returned job_id to inspect or control it.

Arguments:
- command: shell command to run, invoked as <shell> -c <command>.
- cwd: working directory (defaults to the MCP server's current directory).
- env: extra environment variables merged over the server environment.
- shell: shell binary (default /bin/sh).
- timeout_ms: if set, the job is killed after this many milliseconds (SIGTERM, then SIGKILL 5s later) and its status becomes "timed_out".
- notify: report the result back to the agent on completion (default true).`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run, invoked as <shell> -c <command>." },
        cwd: { type: "string", description: "Working directory for the command. Defaults to the MCP server's current directory." },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra environment variables merged over the server's environment for this job.",
        },
        shell: { type: "string", description: "Shell binary used to run the command. Default /bin/sh." },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "If set, kill the job after this many milliseconds (SIGTERM, then SIGKILL 5s later). Its status becomes timed_out.",
        },
        notify: {
          type: "boolean",
          description: "Report the result back to the agent as a message when the job finishes (default true). Set false when you will call wait yourself, to avoid a duplicate notification.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list",
    description: `List the background jobs tracked by this server in the current session, oldest first (by start time).
Jobs are held in memory only and are lost when the MCP server exits; finished jobs stay listed until then. Use the returned id with status, output, wait, and stop.
Returns an array of jobs, each with job_id, command, cwd, pid, status ("running", "completed", "failed", "timed_out", or "killed"), exit_code, started_at, ended_at, and error (when the command could not be spawned).`,
    inputSchema: {
      type: "object",
      properties: {
        active_only: { type: "boolean", description: "When true, return only jobs that are still running. Default false (running and finished jobs)." },
      },
    },
  },
  {
    name: "status",
    description: `Get the current state of one background job by id. Use it to poll a running job without blocking, or to check how a finished job ended.
Returns the same fields as list for that job: job_id, command, cwd, pid, status, exit_code, started_at and ended_at (milliseconds since the Unix epoch), and error when the command could not be spawned. Returns an error result if no job with that id is tracked (for example after the server has restarted).`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start or run_job (for example bgj-1a2b3c4d)." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "output",
    description: `Read the captured stdout and stderr of a background job. Both streams are merged in the order they were produced. Use it to inspect a job's log while it is still running or after it finishes.
For large logs, pass tail_bytes to read only the end, or offset to resume from a byte position; otherwise the entire buffered output is returned. The buffer keeps only the most recent 1 MiB, so very old output may already have been dropped.
Returns job_id, text, size_bytes (total bytes the job has written so far, even if some were dropped), and truncated (true when text does not start at byte 0 of the job's output).`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start or run_job." },
        tail_bytes: { type: "integer", minimum: 0, description: "Return only the last N bytes of output instead of everything from the start." },
        offset: { type: "integer", minimum: 0, description: "Return output starting at this 0-based byte offset into the job's total output." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "stop",
    description: `Stop a background job that is still running. Sends the given signal (SIGTERM by default) to the job's process group, waits up to 5 seconds, and escalates to SIGKILL if it is still alive. The job's status becomes "killed".
Calling stop on a job that has already finished is a no-op and returns its final state. Returns the job's fields as in status.`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start or run_job." },
        signal: { type: "string", description: "Initial signal sent to the job's process group (default SIGTERM). SIGKILL is sent automatically if the job does not exit within 5 seconds." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "wait",
    description: `Block until a background job finishes, or until the timeout elapses, then return its final state. Use this instead of polling with status when you need the result before continuing.
Passing timeout_s: 0 returns immediately with the current state. When you wait inline, prefer starting the job with notify: false so you do not also receive a completion message.
Returns the finished job (or its latest state if the timeout elapsed) and timed_out, which is true when the timeout was reached before the job finished. Errors if the job id is not tracked.`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start or run_job." },
        timeout_s: { type: "number", minimum: 0, description: "Maximum seconds to wait. Omit to wait with no limit until the job finishes; 0 returns immediately." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "create_job",
    description: `Save a reusable job definition to the central database (shared by every project and session, stored on disk). A definition records a command together with pre-set run options (cwd, env, shell, timeout_ms) plus arbitrary metadata, so it can be started later by name with run_job instead of retyping the command.
Names must be unique; creating a definition with an existing name returns an error. This only saves the definition, it does not start anything. Returns the stored definition including its generated id (job-XXXXXXXX).`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name used to reference the definition in run_job, get_job, update_job, and delete_job." },
        command: { type: "string", description: "Shell command the definition will run." },
        cwd: { type: "string", description: "Working directory to run in. Omit to use the server's current directory at run time." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables to merge over the server's environment when the definition runs." },
        shell: { type: "string", description: "Shell binary used to run the command. Omit for /bin/sh." },
        timeout_ms: { type: "integer", minimum: 1, description: "Kill the job after this many milliseconds when this definition runs." },
        metadata: { type: "object", description: "Arbitrary JSON stored with the definition and included in completion notifications. Useful for tags, owner, or notes." },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "list_jobs",
    description: `List every persistent job definition in the central database, oldest first (by creation time, then name). Definitions persist across sessions and are independent of the in-memory runtime jobs.
Returns an array of definitions, each with id, name, command, cwd, env, shell, timeout_ms, metadata, created_at, and updated_at.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_job",
    description: `Fetch one persistent job definition by its id (job-XXXXXXXX) or its unique name. Use it to inspect a saved definition before running or editing it.
Returns the definition's fields as in list_jobs, or an error result if no definition matches.`,
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", description: "Definition id (job-XXXXXXXX) or unique name." } },
      required: ["job"],
    },
  },
  {
    name: "update_job",
    description: `Modify a saved job definition in place. Only the fields you pass are changed; every other field keeps its current value. This only edits the stored definition, it does not affect any job already running from it.
Renaming to a name that already exists returns an error. Returns the updated definition, or an error if the id or name is unknown.`,
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Definition id (job-XXXXXXXX) or unique name to update." },
        name: { type: "string", description: "New unique name for the definition." },
        command: { type: "string", description: "New shell command." },
        cwd: { type: "string", description: "New working directory." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "New environment variables (replaces the stored set)." },
        shell: { type: "string", description: "New shell binary." },
        timeout_ms: { type: "integer", minimum: 1, description: "New timeout in milliseconds." },
        metadata: { type: "object", description: "New metadata (replaces the stored value)." },
      },
      required: ["job"],
    },
  },
  {
    name: "delete_job",
    description: `Permanently remove a saved job definition by id or name. Any job already running from it keeps running; only the saved definition is removed.
Returns { "deleted": true, "job": <removed definition> }, or an error result if no definition matches.`,
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", description: "Definition id (job-XXXXXXXX) or unique name to delete." } },
      required: ["job"],
    },
  },
  {
    name: "run_job",
    description: `Start a background job from a saved definition, using its stored command and run options. Equivalent to calling start with the definition's fields, but the run is tagged with the definition's id and name so completion notifications identify it.
By default the result is reported back to the agent as a message when the job finishes; set notify to false to suppress that. Returns the new job's fields (as in start) plus definition_id and definition_name. Errors if the definition is unknown.`,
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Definition id (job-XXXXXXXX) or unique name to run." },
        notify: {
          type: "boolean",
          description: "Report the result back to the agent as a message when the job finishes (default true). Set false when you will call wait yourself, to avoid a duplicate notification.",
        },
      },
      required: ["job"],
    },
  },
]

const PERSISTENT_TOOLS = new Set(["create_job", "list_jobs", "get_job", "update_job", "delete_job", "run_job"])

export type ToolResult = Record<string, unknown>

export async function dispatch(
  jobs: JobManager,
  store: JobStore | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (PERSISTENT_TOOLS.has(name) && !store) return fail("job store unavailable")
    switch (name) {
      case "start":
        return ok(toWire(jobs.start(readStart(args))))
      case "list":
        return ok({ jobs: jobs.list(args.active_only === true).map(toWire) })
      case "status":
        return withId(args.job_id, (id) => {
          const info = jobs.status(id)
          return info ? ok(toWire(info)) : unknownJob(id)
        })
      case "output":
        return withId(args.job_id, (id) => {
          const result = jobs.output(id, { tailBytes: optionalInt(args.tail_bytes), offset: optionalInt(args.offset) })
          return result ? ok({ job_id: id, ...result }) : unknownJob(id)
        })
      case "stop":
        return await withIdAsync(args.job_id, async (id) => {
          const info = await jobs.stop(id, optionalStr(args.signal))
          return info ? ok(toWire(info)) : unknownJob(id)
        })
      case "wait":
        return await withIdAsync(args.job_id, async (id) => {
          if (!jobs.status(id)) return unknownJob(id)
          const timeout_s = optionalNumber(args.timeout_s)
          const result = await jobs.wait(id, timeout_s === undefined ? undefined : timeout_s * 1000)
          return ok({ job: toWire(result.job), timed_out: result.timed_out })
        })
      case "create_job":
        return ok(toWireDefinition(store!.create(readDefinition(args))))
      case "list_jobs":
        return ok({ jobs: store!.list().map(toWireDefinition) })
      case "get_job":
        return withRef(args.job, (ref) => {
          const definition = store!.get(ref)
          return definition ? ok(toWireDefinition(definition)) : unknownDefinition(ref)
        })
      case "update_job":
        return withRef(args.job, (ref) => {
          const definition = store!.update(ref, readPatch(args))
          return definition ? ok(toWireDefinition(definition)) : unknownDefinition(ref)
        })
      case "delete_job":
        return withRef(args.job, (ref) => {
          const definition = store!.get(ref)
          if (!definition) return unknownDefinition(ref)
          store!.delete(ref)
          return ok({ deleted: true, job: toWireDefinition(definition) })
        })
      case "run_job":
        return withRef(args.job, (ref) => {
          const definition = store!.get(ref)
          if (!definition) return unknownDefinition(ref)
          const info = jobs.start({
            command: definition.command,
            cwd: definition.cwd,
            env: definition.env,
            shell: definition.shell,
            timeout_ms: definition.timeout_ms,
            notify: args.notify !== false,
            meta: { definition_id: definition.id, definition_name: definition.name, metadata: definition.metadata },
          })
          return ok({ ...toWire(info), definition_id: definition.id, definition_name: definition.name })
        })
      default:
        return fail(`unknown tool: ${name}`)
    }
  } catch (error) {
    return fail(errorMessage(error))
  }
}

export function toWire(info: JobInfo) {
  return compact({
    job_id: info.id,
    command: info.command,
    cwd: info.cwd,
    pid: info.pid,
    status: info.status,
    exit_code: info.exit_code,
    started_at: info.started_at,
    ended_at: info.ended_at,
    error: info.error,
  })
}

export function toWireDefinition(definition: JobDefinition) {
  return compact({
    id: definition.id,
    name: definition.name,
    command: definition.command,
    cwd: definition.cwd,
    env: definition.env,
    shell: definition.shell,
    timeout_ms: definition.timeout_ms,
    metadata: definition.metadata,
    created_at: definition.created_at,
    updated_at: definition.updated_at,
  })
}

function readStart(args: Record<string, unknown>) {
  return {
    command: str(args.command, "command"),
    cwd: optionalStr(args.cwd),
    env: strRecord(args.env),
    shell: optionalStr(args.shell),
    timeout_ms: optionalInt(args.timeout_ms),
    notify: optionalBool(args.notify),
  }
}

function readDefinition(args: Record<string, unknown>) {
  return {
    name: str(args.name, "name"),
    command: str(args.command, "command"),
    cwd: optionalStr(args.cwd),
    env: strRecord(args.env),
    shell: optionalStr(args.shell),
    timeout_ms: optionalInt(args.timeout_ms),
    metadata: objectRecord(args.metadata),
  }
}

function readPatch(args: Record<string, unknown>): JobDefinitionPatch {
  const patch: JobDefinitionPatch = {}
  if (args.name !== undefined) patch.name = str(args.name, "name")
  if (args.command !== undefined) patch.command = str(args.command, "command")
  if (args.cwd !== undefined) patch.cwd = optionalStr(args.cwd)
  if (args.env !== undefined) patch.env = strRecord(args.env)
  if (args.shell !== undefined) patch.shell = optionalStr(args.shell)
  if (args.timeout_ms !== undefined) patch.timeout_ms = optionalInt(args.timeout_ms)
  if (args.metadata !== undefined) patch.metadata = objectRecord(args.metadata)
  return patch
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

function unknownDefinition(ref: string): ToolResult {
  return fail(`unknown job definition: ${ref}`)
}

function withId(value: unknown, handler: (id: string) => ToolResult): ToolResult {
  if (typeof value !== "string" || value.length === 0) return fail("job_id is required")
  return handler(value)
}

async function withIdAsync(value: unknown, handler: (id: string) => Promise<ToolResult>): Promise<ToolResult> {
  if (typeof value !== "string" || value.length === 0) return fail("job_id is required")
  return handler(value)
}

function withRef(value: unknown, handler: (ref: string) => ToolResult): ToolResult {
  if (typeof value !== "string" || value.length === 0) return fail("job is required")
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

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (value !== undefined) out[key] = value
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
