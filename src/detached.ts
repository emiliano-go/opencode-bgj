import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs"
import type { Status } from "./jobs"
import type { DetachedRun, JobStore } from "./store"

export interface DetachedStatus {
  job_id: string
  command: string
  cwd?: string
  pid: number
  status: Status
  exit_code: number | null
  started_at: number
  ended_at: number | null
  elapsed_ms: number
  log: string
  detached: true
}

export interface DetachedOutput {
  text: string
  size_bytes: number
  truncated: boolean
}

export interface RunDetachedOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  shell?: string
}

export interface DetachedOutputOptions {
  tailBytes?: number
  offset?: number
}

const DEFAULT_SHELL = "/bin/sh"
const KILL_GRACE_MS = 5_000

// The tracked process is one shell that runs the command and records its exit
// code, so completion is known without a resident supervisor. The command
// itself travels in BGJ_COMMAND, never interpolated into the script, so there
// is nothing to escape. The EXIT trap fires even when the command calls exit,
// so the marker is always written.
const WRAPPER = `trap 'printf "%s" "$?" > "$BGJ_EXIT"' EXIT
eval "$BGJ_COMMAND"`

export class DetachedManager {
  constructor(private readonly store: JobStore) {}

  start(options: RunDetachedOptions, directory?: string): DetachedStatus {
    const id = this.newId()
    const logPath = this.store.detachedLogPath(id)
    const exitPath = this.store.detachedExitPath(id)
    const fd = openSync(logPath, "a")
    let proc: Bun.Subprocess
    try {
      proc = Bun.spawn({
        cmd: [options.shell ?? DEFAULT_SHELL, "-c", WRAPPER],
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...options.env, BGJ_COMMAND: options.command, BGJ_EXIT: exitPath },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        detached: true,
      })
    } catch (error) {
      closeSync(fd)
      throw error
    }
    closeSync(fd)
    // Let Bun reap the child's exit without blocking; the marker file, not this
    // promise, is what records the outcome.
    void proc.exited.catch(() => {})
    this.store.createDetached({
      id,
      command: options.command,
      cwd: options.cwd,
      pid: proc.pid,
      status: "running",
      exit_code: null,
      started_at: Date.now(),
      ended_at: null,
      directory,
    })
    return this.snapshot(this.store.detached(id)!)
  }

  list(directory?: string): DetachedStatus[] {
    return this.store
      .listDetached()
      .filter((row) => directory === undefined || row.directory === directory)
      .map((row) => this.snapshot(this.reconcile(row)))
  }

  status(id: string): DetachedStatus | undefined {
    const row = this.store.detached(id)
    return row ? this.snapshot(this.reconcile(row)) : undefined
  }

  output(id: string, options: DetachedOutputOptions = {}): DetachedOutput | undefined {
    const row = this.store.detached(id)
    if (!row) return undefined
    this.reconcile(row)
    const path = this.store.detachedLogPath(id)
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    const start =
      options.offset !== undefined
        ? Math.max(0, options.offset)
        : options.tailBytes !== undefined
          ? Math.max(0, bytes.length - options.tailBytes)
          : 0
    return {
      text: bytes.subarray(start).toString(),
      size_bytes: bytes.length,
      truncated: start > 0,
    }
  }

  async stop(id: string, signal?: string): Promise<DetachedStatus | undefined> {
    const row = this.store.detached(id)
    if (!row) return undefined
    const current = this.reconcile(row)
    if (current.status !== "running") return this.snapshot(current)
    // Record the intent before signalling so a job that dies on the signal
    // reconciles as killed rather than as a generic failure.
    try {
      writeFileSync(this.store.detachedStopPath(id), "")
    } catch {
      // a missing marker only downgrades the reported status; keep going
    }
    await this.terminate(current.pid, signal ?? "SIGTERM")
    return this.status(id)
  }

  // Turns a stored row into its present state, reading the exit marker and, if
  // there is none yet, whether the process is still alive. The final state is
  // persisted the first time it is observed.
  private reconcile(row: DetachedRun): DetachedRun {
    if (row.status !== "running") return row
    const code = this.readExit(row.id)
    const stopped = existsSync(this.store.detachedStopPath(row.id))
    if (code !== undefined || stopped) {
      const status: Status = stopped ? "killed" : code === 0 ? "completed" : "failed"
      this.store.updateDetached(row.id, { status, exit_code: code ?? null, ended_at: Date.now() })
      return this.store.detached(row.id)!
    }
    if (this.alive(row.pid)) return row
    this.store.updateDetached(row.id, { status: "failed", exit_code: null, ended_at: Date.now() })
    return this.store.detached(row.id)!
  }

  private readExit(id: string): number | undefined {
    const path = this.store.detachedExitPath(id)
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text === "") return undefined
      const code = Number.parseInt(text, 10)
      return Number.isNaN(code) ? undefined : code
    } catch {
      return undefined
    }
  }

  private alive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  private async terminate(pid: number, signal: string) {
    this.signal(pid, signal)
    if (await this.waitGone(pid, KILL_GRACE_MS)) return
    this.signal(pid, "SIGKILL")
    await this.waitGone(pid, KILL_GRACE_MS)
  }

  private signal(pid: number, signal: string) {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // process already gone
      }
    }
  }

  private waitGone(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        if (!this.alive(pid)) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  private snapshot(row: DetachedRun): DetachedStatus {
    return {
      job_id: row.id,
      command: row.command,
      cwd: row.cwd,
      pid: row.pid,
      status: row.status as Status,
      exit_code: row.exit_code,
      started_at: row.started_at,
      ended_at: row.ended_at,
      elapsed_ms: Math.max(0, (row.ended_at ?? Date.now()) - row.started_at),
      log: this.store.detachedLogPath(row.id),
      detached: true,
    }
  }

  private newId(): string {
    let id = ""
    do {
      id = `bgj-${randomSuffix()}`
    } while (this.store.detached(id) !== undefined)
    return id
  }
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ""
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
  return suffix
}
