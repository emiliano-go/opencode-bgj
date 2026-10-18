import { DetachedManager } from "./detached"
import type { JobInfo } from "./jobs"
import { JobManager } from "./jobs"
import type { JobDefinition, JobDefinitionPatch, JobStore, SessionOp } from "./store"

const SESSION_REQUEST_TIMEOUT_MS = 5000
const SESSION_WAIT_REQUEST_TIMEOUT_MS = 10000
const SESSION_WAIT_POLL_MS = 1000
const SESSION_REQUEST_POLL_MS = 50

interface PeekResult {
  text: string
  running: boolean
  messages: number
}

interface StatusResult {
  running: boolean
  messages: number
}

interface AbortResult {
  aborted: boolean
}

interface SessionSummary {
  session_id: string
  parent_id?: string
  title?: string
  running: boolean
  created?: number
}

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
    description: `List the background jobs and opencode sessions tracked by this server for the current directory, oldest first (by start time).
Shell jobs are held in memory only and are lost when the MCP server exits; finished jobs stay listed until then. Sessions come from the bgj-notify plugin: the directory's child sessions (background subagents), so a background subagent shows up here. Detached jobs (run_detached) are included too.
Returns an array of jobs, each with job_id, command, cwd, pid, status ("running", "completed", "failed", "timed_out", or "killed"), exit_code, started_at, ended_at, and error (when the command could not be spawned). Session entries carry session_id, parent_id, title, status ("running" or "completed"), session (true), and running instead. Use the returned id with status, output, wait, and stop.
Set active_only to true to show only entries that are still running.`,
    inputSchema: {
      type: "object",
      properties: {
        active_only: { type: "boolean", description: "When true, return only jobs that are still running. Default false (running and finished jobs)." },
      },
    },
  },
  {
    name: "status",
    description: `Get the current state of one background job or session. Pass job_id for a shell or detached job, or session_id for an opencode session (for example a background subagent): a session is "running" while busy and "completed" once idle.
Use it to poll a running job without blocking, or to check how a finished job ended. Pass exactly one of job_id or session_id.
For a job, returns job_id, command, cwd, pid, status, exit_code, started_at and ended_at (milliseconds since the Unix epoch), and error when the command could not be spawned. For a session, returns session_id, session (true), status, running, and messages.
Returns an error result if no job or session with that id is tracked, or if the plugin is not running.`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start, run_job, or run_detached (for example bgj-1a2b3c4d)." },
        session_id: { type: "string", description: "Session id to check, for example a background subagent's task id." },
      },
    },
  },
  {
    name: "output",
    description: `Read the current output of a job. Pass job_id for a background shell job, or session_id to read what a running opencode session (for example a background subagent) has produced so far.
For a shell job both streams are merged in the order produced; the buffer keeps the most recent 1 MiB and tail_bytes or offset select a slice.
For a session it returns the latest assistant message text, whether the session is still running, and how many messages it has. Pass exactly one of job_id or session_id.
Returns the id, text, size_bytes (total produced so far, even if some was dropped), and truncated (true when text does not start at the beginning).`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start or run_job." },
        session_id: { type: "string", description: "Session id to read the current output of, for example a background subagent's task id." },
        tail_bytes: { type: "integer", minimum: 0, description: "Return only the last N bytes of output instead of everything from the start." },
        offset: { type: "integer", minimum: 0, description: "Return output starting at this 0-based byte offset into the job's total output." },
      },
    },
  },
  {
    name: "stop",
    description: `Stop a running background job or abort an opencode session.
For a job (job_id), sends the given signal (SIGTERM by default) to the job's process group, waits up to 5 seconds, and escalates to SIGKILL if it is still alive. The job's status becomes "killed". For a detached job this also stops work started with run_detached.
For a session (session_id), aborts the session, which cancels the turn it is running (for example a background subagent). Pass exactly one of job_id or session_id.
Calling stop on a job that has already finished is a no-op and returns its final state. Returns the job's fields as in status, or { session_id, session, aborted } for a session.`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start, run_job, or run_detached." },
        session_id: { type: "string", description: "Session id to abort, for example a background subagent's task id." },
        signal: { type: "string", description: "Initial signal sent to the job's process group (default SIGTERM). SIGKILL is sent automatically if the job does not exit within 5 seconds." },
      },
    },
  },
  {
    name: "wait",
    description: `Block until a background job or session finishes, or until the timeout elapses, then return its final state. Pass job_id for a shell job, or session_id to wait until an opencode session goes idle (for example a background subagent's turn completes). Pass exactly one of job_id or session_id.
Use wait ONLY when you have nothing else to do in the meantime but wait for this job; it suspends the turn until the job ends or timeout_s elapses. If you could be doing other work while the job runs, do NOT call wait: start the job with notify left at its default and continue, and the completion message will wake you when it is done. Never call wait merely to poll for progress.
Passing timeout_s: 0 returns immediately with the current state. When you wait inline, prefer starting the job with notify: false so you do not also receive a completion message.
Returns the finished job (or its latest state if the timeout elapsed) and timed_out, which is true when the timeout was reached before the job finished. Errors if the job id is not tracked.`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Background job id returned by start, run_job, or run_detached." },
        session_id: { type: "string", description: "Session id to wait for, for example a background subagent's task id." },
        timeout_s: { type: "number", minimum: 0, description: "Maximum seconds to wait. Omit to wait with no limit until the job finishes; 0 returns immediately." },
      },
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
  {
    name: "run_detached",
    description: `Run a shell command fully detached from this session and return immediately with its job id and log path. The command keeps running after the session (and this server) exits, and it never sends a completion notification: it is fire-and-forget.
Its merged stdout and stderr are written to a per-job log file and its exit status is recorded on disk, so status, output, and stop keep working later, even in a new session, by reading the log file and checking whether the process is still alive.
Use it for work that must outlive the session: a long download, a build, or a one-off server you want to survive a restart. For work you want to observe and be woken about inside this session, use start instead.
There is no timeout_ms: nothing stays resident to enforce one.
Returns the job_id, command, cwd, pid, status ("running"), started_at, the log file path, and detached ("true").`,
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
      },
      required: ["command"],
    },
  },
]

const PERSISTENT_TOOLS = new Set(["create_job", "list_jobs", "get_job", "update_job", "delete_job", "run_job"])

export type ToolResult = Record<string, unknown>

export async function dispatch(
  jobs: JobManager,
  store: JobStore | undefined,
  detached: DetachedManager | undefined,
  name: string,
  args: Record<string, unknown>,
  directory: string = process.cwd(),
): Promise<ToolResult> {
  try {
    if (name === "run_detached" && (!store || !detached)) return fail("job store unavailable")
    if (!store && PERSISTENT_TOOLS.has(name)) return fail("job store unavailable")
    switch (name) {
      case "start":
        return ok(toWire(jobs.start(readStart(args))))
      case "run_detached":
        return ok(detached!.start(readDetached(args), directory))
      case "list": {
        const activeOnly = args.active_only === true
        const entries: object[] = jobs.list(activeOnly).map(toWire)
        if (detached) entries.push(...detached.list(directory).filter((job) => !activeOnly || job.status === "running"))
        entries.push(...(await sessionList(store, directory, activeOnly)).map(sessionToWire))
        entries.sort((a, b) => (a as { started_at: number }).started_at - (b as { started_at: number }).started_at)
        return ok({ jobs: entries })
      }
      case "status": {
        const sessionID = optionalStr(args.session_id)
        if (sessionID !== undefined) return await sessionStatus(store, directory, sessionID)
        return withId(args.job_id, (id) => {
          const info = jobs.status(id)
          if (info) return ok(toWire(info))
          const job = detached?.status(id)
          return job ? ok(job) : unknownJob(id)
        })
      }
      case "output": {
        const sessionID = optionalStr(args.session_id)
        if (sessionID !== undefined) return await sessionOutput(store, directory, sessionID, args)
        return withId(args.job_id, (id) => {
          const options = { tailBytes: optionalInt(args.tail_bytes), offset: optionalInt(args.offset) }
          const result = jobs.output(id, options)
          if (result) return ok({ job_id: id, ...result })
          const job = detached?.output(id, options)
          return job ? ok({ job_id: id, ...job }) : unknownJob(id)
        })
      }
      case "stop": {
        const sessionID = optionalStr(args.session_id)
        if (sessionID !== undefined) return await sessionStop(store, directory, sessionID)
        return await withIdAsync(args.job_id, async (id) => {
          const info = await jobs.stop(id, optionalStr(args.signal))
          if (info) return ok(toWire(info))
          const job = await detached?.stop(id, optionalStr(args.signal))
          return job ? ok(job) : unknownJob(id)
        })
      }
      case "wait": {
        const sessionID = optionalStr(args.session_id)
        if (sessionID !== undefined) return await sessionWait(store, directory, sessionID, optionalNumber(args.timeout_s))
        return await withIdAsync(args.job_id, async (id) => {
          if (!jobs.status(id)) return unknownJob(id)
          const timeout_s = optionalNumber(args.timeout_s)
          const result = await jobs.wait(id, timeout_s === undefined ? undefined : timeout_s * 1000)
          return ok({ job: toWire(result.job), timed_out: result.timed_out })
        })
      }
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

function readDetached(args: Record<string, unknown>) {
  return {
    command: str(args.command, "command"),
    cwd: optionalStr(args.cwd),
    env: strRecord(args.env),
    shell: optionalStr(args.shell),
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

function ok(structured: object): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function unknownJob(id: string): ToolResult {
  return fail(`unknown job: ${id}`)
}

// Files one request for the plugin and waits for its answer. Every session tool
// goes through here; op selects the action and sessionID is omitted for list.
async function sessionRequest<T>(
  store: JobStore,
  directory: string,
  op: SessionOp,
  sessionID: string | undefined,
  timeoutMs = SESSION_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const id = store.createSessionRequest(directory, op, sessionID)
  try {
    const deadline = Date.now() + timeoutMs
    let request = store.sessionRequest(id)
    while ((!request || request.status === "pending") && Date.now() < deadline) {
      await delay(SESSION_REQUEST_POLL_MS)
      request = store.sessionRequest(id)
    }
    if (!request || request.status === "pending") {
      const target = sessionID ? ` for session ${sessionID}` : ""
      throw new Error(`timed out waiting for the plugin to answer ${op}${target}; is the bgj-notify plugin running?`)
    }
    if (request.status === "error") throw new Error(request.error ?? `the plugin could not answer ${op}`)
    return request.result as T
  } finally {
    store.deleteSessionRequest(id)
  }
}

function sessionReady(store: JobStore | undefined, directory: string): ToolResult | undefined {
  if (!store) return fail("job store unavailable")
  if (!store.hasInstance(directory)) {
    return fail(`no opencode instance registered for ${directory}; install and restart the bgj-notify plugin`)
  }
  return undefined
}

async function sessionOutput(
  store: JobStore | undefined,
  directory: string,
  sessionID: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const notReady = sessionReady(store, directory)
  if (notReady) return notReady
  try {
    const peek = await sessionRequest<PeekResult>(store!, directory, "peek", sessionID)
    const bytes = Buffer.from(peek.text ?? "")
    const offset = optionalInt(args.offset)
    const tailBytes = optionalInt(args.tail_bytes)
    const start =
      offset !== undefined ? Math.max(0, offset) : tailBytes !== undefined ? Math.max(0, bytes.length - tailBytes) : 0
    return ok({
      session_id: sessionID,
      text: bytes.subarray(start).toString(),
      size_bytes: bytes.length,
      truncated: start > 0,
      running: peek.running ?? false,
      messages: peek.messages ?? 0,
    })
  } catch (error) {
    return fail(errorMessage(error))
  }
}

async function sessionStatus(store: JobStore | undefined, directory: string, sessionID: string): Promise<ToolResult> {
  const notReady = sessionReady(store, directory)
  if (notReady) return notReady
  try {
    const status = await sessionRequest<StatusResult>(store!, directory, "status", sessionID)
    return ok(sessionWire(sessionID, status))
  } catch (error) {
    return fail(errorMessage(error))
  }
}

async function sessionWait(
  store: JobStore | undefined,
  directory: string,
  sessionID: string,
  timeoutSeconds: number | undefined,
): Promise<ToolResult> {
  const notReady = sessionReady(store, directory)
  if (notReady) return notReady
  const deadline = timeoutSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutSeconds * 1000
  try {
    while (true) {
      const status = await sessionRequest<StatusResult>(store!, directory, "status", sessionID, SESSION_WAIT_REQUEST_TIMEOUT_MS)
      if (!status.running) return ok({ ...sessionWire(sessionID, status), timed_out: false })
      if (Date.now() >= deadline) return ok({ ...sessionWire(sessionID, status), timed_out: true })
      await delay(SESSION_WAIT_POLL_MS)
    }
  } catch (error) {
    return fail(errorMessage(error))
  }
}

async function sessionStop(store: JobStore | undefined, directory: string, sessionID: string): Promise<ToolResult> {
  const notReady = sessionReady(store, directory)
  if (notReady) return notReady
  try {
    const result = await sessionRequest<AbortResult>(store!, directory, "abort", sessionID)
    return ok({ session_id: sessionID, session: true, aborted: result.aborted ?? true })
  } catch (error) {
    return fail(errorMessage(error))
  }
}

async function sessionList(
  store: JobStore | undefined,
  directory: string,
  activeOnly: boolean,
): Promise<SessionSummary[]> {
  if (!store || !store.hasInstance(directory)) return []
  try {
    const result = await sessionRequest<{ sessions: SessionSummary[] }>(store, directory, "list", undefined)
    const sessions = result.sessions ?? []
    return activeOnly ? sessions.filter((session) => session.running) : sessions
  } catch {
    // the plugin may be gone; fall back to shell and detached jobs only
    return []
  }
}

function sessionWire(sessionID: string, status: StatusResult) {
  return {
    session_id: sessionID,
    session: true,
    status: status.running ? "running" : "completed",
    running: status.running,
    messages: status.messages,
  }
}

function sessionToWire(summary: SessionSummary) {
  return compact({
    session_id: summary.session_id,
    parent_id: summary.parent_id,
    title: summary.title,
    session: true,
    status: summary.running ? "running" : "completed",
    running: summary.running,
    started_at: summary.created,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
