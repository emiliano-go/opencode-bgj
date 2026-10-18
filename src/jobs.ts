export type Status = "running" | "completed" | "failed" | "timed_out" | "killed"

export interface JobInfo {
  id: string
  command: string
  cwd: string
  pid: number
  status: Status
  exit_code: number | null
  started_at: number
  ended_at: number | null
  error?: string
}

export interface StartOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  shell?: string
  timeout_ms?: number
}

export interface OutputOptions {
  tailBytes?: number
  offset?: number
}

export interface OutputResult {
  text: string
  size_bytes: number
  truncated: boolean
}

export interface WaitResult {
  job: JobInfo
  timed_out: boolean
}

const MAX_OUTPUT_BYTES = 1024 * 1024
const KILL_GRACE_MS = 5_000
const DEFAULT_SHELL = "/bin/sh"

// ponytail: in-memory only. Jobs die with this process (the MCP server, a child
// of opencode). Add a disk+detached slice with an exit-code marker if jobs must
// outlive the session.
export class JobManager {
  private readonly jobs = new Map<string, Entry>()

  start(options: StartOptions): JobInfo {
    const id = newId()
    const cwd = options.cwd ?? process.cwd()
    const info: JobInfo = {
      id,
      command: options.command,
      cwd,
      pid: -1,
      status: "running",
      exit_code: null,
      started_at: Date.now(),
      ended_at: null,
    }
    let resolveExit = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const entry: Entry = { info, buffer: new OutputBuffer(), exited, resolveExit, stopReason: null }
    this.jobs.set(id, entry)

    let proc: Bun.Subprocess | undefined
    try {
      proc = Bun.spawn({
        cmd: [options.shell ?? DEFAULT_SHELL, "-c", options.command],
        cwd,
        env: { ...process.env, ...options.env },
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })
    } catch (error) {
      this.finalizeFailure(entry, errorMessage(error))
      return snapshot(entry)
    }

    entry.proc = proc
    info.pid = proc.pid
    if (options.timeout_ms !== undefined && options.timeout_ms > 0) this.armTimeout(entry, options.timeout_ms)
    void this.track(entry, proc)
    return snapshot(entry)
  }

  list(activeOnly = false): JobInfo[] {
    return Array.from(this.jobs.values())
      .map(snapshot)
      .filter((job) => !activeOnly || job.status === "running")
      .toSorted((a, b) => a.started_at - b.started_at)
  }

  status(id: string): JobInfo | undefined {
    const entry = this.jobs.get(id)
    return entry ? snapshot(entry) : undefined
  }

  output(id: string, options: OutputOptions = {}): OutputResult | undefined {
    const entry = this.jobs.get(id)
    if (!entry) return undefined
    const total = entry.buffer.total
    let start = 0
    if (options.offset !== undefined) start = Math.max(0, options.offset)
    else if (options.tailBytes !== undefined) start = Math.max(0, total - options.tailBytes)
    return {
      text: new TextDecoder().decode(entry.buffer.read(start)),
      size_bytes: total,
      truncated: start > 0 || entry.buffer.dropped > 0,
    }
  }

  async stop(id: string, signal?: string): Promise<JobInfo | undefined> {
    const entry = this.jobs.get(id)
    if (!entry) return undefined
    if (entry.info.status !== "running") return snapshot(entry)
    entry.stopReason = "user"
    await this.terminate(entry, signal ?? "SIGTERM")
    return snapshot(entry)
  }

  async wait(id: string, timeoutMs?: number): Promise<WaitResult> {
    const entry = this.jobs.get(id)
    if (!entry) throw new Error(`unknown job: ${id}`)
    if (entry.info.status !== "running") return { job: snapshot(entry), timed_out: false }
    if (timeoutMs === undefined) {
      await entry.exited
      return { job: snapshot(entry), timed_out: false }
    }
    if (timeoutMs <= 0) return { job: snapshot(entry), timed_out: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const winner = await Promise.race([entry.exited.then(() => "exit" as const), timeout])
    if (timer !== undefined) clearTimeout(timer)
    return { job: snapshot(entry), timed_out: winner === "timeout" }
  }

  private async track(entry: Entry, proc: Bun.Subprocess) {
    const pumps: Promise<void>[] = []
    const stdout = proc.stdout
    const stderr = proc.stderr
    if (stdout && typeof stdout !== "number") pumps.push(pump(stdout, (chunk) => entry.buffer.append(chunk)))
    if (stderr && typeof stderr !== "number") pumps.push(pump(stderr, (chunk) => entry.buffer.append(chunk)))
    const code = await proc.exited
    await Promise.allSettled(pumps)
    if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer)
    if (entry.info.status === "running") {
      entry.info.ended_at = Date.now()
      entry.info.exit_code = code
      entry.info.status =
        entry.stopReason === "timeout" ? "timed_out" : entry.stopReason === "user" ? "killed" : code === 0 ? "completed" : "failed"
    }
    entry.resolveExit()
  }

  private armTimeout(entry: Entry, timeoutMs: number) {
    entry.timeoutTimer = setTimeout(() => {
      if (entry.info.status !== "running") return
      entry.stopReason = "timeout"
      void this.terminate(entry, "SIGTERM")
    }, timeoutMs)
    entry.timeoutTimer.unref?.()
  }

  private async terminate(entry: Entry, signal: string) {
    if (entry.info.status !== "running") return
    const proc = entry.proc
    if (!proc) return
    this.signal(entry, signal)
    const killed = await this.raceExit(entry, KILL_GRACE_MS)
    if (killed) return
    this.signal(entry, "SIGKILL")
    await entry.exited
  }

  private signal(entry: Entry, signal: string) {
    const pid = entry.info.pid
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        entry.proc?.kill(signal as Parameters<Bun.Subprocess["kill"]>[0])
      } catch {
        // process already gone
      }
    }
  }

  private raceExit(entry: Entry, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    return Promise.race([entry.exited.then(() => true), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  private finalizeFailure(entry: Entry, message: string) {
    entry.info.status = "failed"
    entry.info.ended_at = Date.now()
    entry.info.error = message
    entry.buffer.append(new TextEncoder().encode(message + "\n"))
    entry.resolveExit()
  }
}

interface Entry {
  info: JobInfo
  proc?: Bun.Subprocess
  buffer: OutputBuffer
  exited: Promise<void>
  resolveExit: () => void
  stopReason: "user" | "timeout" | null
  timeoutTimer?: ReturnType<typeof setTimeout>
}

class OutputBuffer {
  private chunks: Uint8Array[] = []
  private head = 0
  dropped = 0
  total = 0

  append(chunk: Uint8Array) {
    if (chunk.byteLength === 0) return
    const copy = chunk.slice()
    this.chunks.push(copy)
    this.total += copy.byteLength
    let over = this.total - this.dropped - MAX_OUTPUT_BYTES
    while (over > 0 && this.head < this.chunks.length) {
      const first = this.chunks[this.head]!
      if (first.byteLength <= over) {
        this.head++
        this.dropped += first.byteLength
        over -= first.byteLength
      } else {
        this.chunks[this.head] = first.subarray(over)
        this.dropped += over
        over = 0
      }
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  read(start: number): Uint8Array {
    const from = Math.max(this.dropped, start)
    const to = this.total
    if (to <= from) return new Uint8Array(0)
    const out = new Uint8Array(to - from)
    let pos = this.dropped
    let written = 0
    for (let i = this.head; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!
      const chunkStart = pos
      const chunkEnd = pos + chunk.byteLength
      pos = chunkEnd
      if (chunkEnd <= from || chunkStart >= to) continue
      const sliceStart = Math.max(0, from - chunkStart)
      const sliceEnd = Math.min(chunk.byteLength, to - chunkStart)
      out.set(chunk.subarray(sliceStart, sliceEnd), written)
      written += sliceEnd - sliceStart
    }
    return out
  }
}

async function pump(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) onChunk(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function snapshot(entry: Entry): JobInfo {
  return { ...entry.info }
}

function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ""
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
  return `bgj-${suffix}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
