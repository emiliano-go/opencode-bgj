import { describe, expect, test } from "bun:test"
import { DetachedManager } from "../src/detached"
import { JobManager } from "../src/jobs"
import { JobStore } from "../src/store"
import { dispatch } from "../src/tools"

function harness() {
  const jobs = new JobManager()
  const store = new JobStore(":memory:")
  const detached = new DetachedManager(store)
  return {
    run: (name: string, args: Record<string, unknown> = {}) => dispatch(jobs, store, detached, name, args),
    jobs,
    store,
    detached,
  }
}

function structured(result: Record<string, unknown>) {
  return result.structuredContent as Record<string, any>
}

describe("runtime tools", () => {
  test("start returns a job id and wait surfaces output", async () => {
    const { run } = harness()
    const started = await run("start", { command: "printf dispatched" })
    expect(started.isError).toBeUndefined()
    const id = structured(started).job_id as string
    expect(id).toMatch(/^bgj-/)
    expect(structured(started).elapsed_ms).toBeGreaterThanOrEqual(0)

    const waited = await run("wait", { job_id: id, timeout_s: 5 })
    expect(structured(waited).job.status).toBe("completed")
    expect(structured(waited).job.elapsed_ms).toBeGreaterThanOrEqual(0)

    const out = await run("output", { job_id: id })
    expect(structured(out).text).toBe("dispatched")
  })

  test("list reports jobs", async () => {
    const { run } = harness()
    await run("start", { command: "sleep 30", timeout_ms: 1 })
    const listed = await run("list", {})
    expect(structured(listed).jobs).toHaveLength(1)
  })

  test("debug returns captured output and the exit code", async () => {
    const { run } = harness()
    const started = await run("start", { command: "printf hello; exit 3", notify: false })
    const id = structured(started).job_id as string
    await run("wait", { job_id: id, timeout_s: 5 })
    const debug = structured(await run("debug", { job_id: id }))
    expect(debug.exit_code).toBe(3)
    expect(debug.status).toBe("failed")
    expect(debug.output.text).toContain("hello")
  })

  test("debug lists the job's process group while it runs, and nothing once it stops", async () => {
    const { run } = harness()
    const started = await run("start", { command: "sleep 30", notify: false })
    const id = structured(started).job_id as string
    const debug = structured(await run("debug", { job_id: id }))
    expect(debug.status).toBe("running")
    expect(debug.processes.some((p: { pid: number }) => p.pid === debug.pid)).toBe(true)
    await run("stop", { job_id: id })
    const after = structured(await run("debug", { job_id: id }))
    expect(after.status).toBe("killed")
    expect(after.processes).toEqual([])
  })

  test("debug match greps command lines across all processes", async () => {
    const { run } = harness()
    const started = await run("start", { command: "sleep 30", notify: false })
    const id = structured(started).job_id as string
    await Bun.sleep(150)
    const debug = structured(await run("debug", { job_id: id, match: "sleep 30" }))
    expect(debug.processes.length).toBeGreaterThan(0)
    await run("stop", { job_id: id })
  })

  test("debug reports a detached job's on-disk exit and log", async () => {
    const { run } = harness()
    const started = await run("run_detached", { command: "printf detached-debug" })
    const id = structured(started).job_id as string
    await run("wait", { job_id: id, timeout_s: 5 })
    const debug = structured(await run("debug", { job_id: id }))
    expect(debug.detached).toBe(true)
    expect(debug.output.text).toContain("detached-debug")
  })

  test("detach promotes a runtime job and streams later output to disk", async () => {
    const { run, store } = harness()
    const started = await run("start", { command: "printf before; sleep 0.2; printf after", notify: false })
    const id = structured(started).job_id as string
    const promoted = structured(await run("detach", { job_id: id }))
    expect(promoted.detached).toBe(true)
    expect(promoted.status).toBe("running")
    expect(promoted.log).toContain(`${id}.log`)

    const waited = structured(await run("wait", { job_id: id, timeout_s: 5 }))
    expect(waited.timed_out).toBe(false)
    expect(waited.job.status).toBe("completed")

    const out = structured(await run("output", { job_id: id }))
    expect(out.text).toBe("beforeafter")

    const reloaded = new DetachedManager(store)
    expect(reloaded.status(id)?.status).toBe("completed")
  })

  test("detach preserves a finished runtime job", async () => {
    const { run } = harness()
    const started = await run("start", { command: "printf done", notify: false })
    const id = structured(started).job_id as string
    const waited = structured(await run("wait", { job_id: id, timeout_s: 5 }))

    const promoted = structured(await run("detach", { job_id: id }))
    expect(promoted.detached).toBe(true)
    expect(promoted.status).toBe("completed")
    expect(promoted.ended_at).toBe(waited.job.ended_at)
    expect(structured(await run("output", { job_id: id })).text).toBe("done")
  })

  test("a detached runtime job is stopped through the detached record", async () => {
    const { run } = harness()
    const started = await run("start", { command: "sleep 30", notify: false })
    const id = structured(started).job_id as string
    await run("detach", { job_id: id })
    const stopped = structured(await run("stop", { job_id: id }))
    expect(stopped.detached).toBe(true)
    expect(stopped.status).toBe("killed")
  })

  test("detach reports unknown and already-detached jobs", async () => {
    const { run } = harness()
    expect(await run("detach", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    const started = await run("run_detached", { command: "sleep 30" })
    const id = structured(started).job_id as string
    const again = structured(await run("detach", { job_id: id }))
    expect(again.detached).toBe(true)
    await run("stop", { job_id: id })
  })

  test("unknown tool and unknown job are error results, not throws", async () => {
    const { run } = harness()
    expect(await run("nope")).toMatchObject({ isError: true })
    expect(await run("status", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await run("wait", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await run("output", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await run("debug", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
  })

  test("malformed argument types are error results, not throws", async () => {
    const { run } = harness()
    expect(await run("start", { command: 123 })).toMatchObject({ isError: true })
    expect(await run("status", { job_id: 42 })).toMatchObject({ isError: true })
    expect(await run("output", { job_id: [] })).toMatchObject({ isError: true })
    expect(await run("wait", { job_id: "bgj-x", timeout_s: "soon" })).toMatchObject({ isError: true })
  })

  test("missing required command is an error result", async () => {
    const { run } = harness()
    expect(await run("start", {})).toMatchObject({ isError: true })
  })

  test("wait returns timed_out without finishing", async () => {
    const { run } = harness()
    const started = await run("start", { command: "sleep 30" })
    const id = structured(started).job_id as string
    const waited = await run("wait", { job_id: id, timeout_s: 0.05 })
    expect(structured(waited).timed_out).toBe(true)
    expect(structured(waited).waited_ms).toBeGreaterThanOrEqual(40)
    await run("stop", { job_id: id })
  })

  test("wait clamps a long timeout below the client request timeout", async () => {
    const previous = process.env.OPENCODE_BGJ_MAX_WAIT_MS
    process.env.OPENCODE_BGJ_MAX_WAIT_MS = "150"
    try {
      const { run } = harness()
      const started = await run("start", { command: "sleep 30" })
      const id = structured(started).job_id as string
      const began = Date.now()
      const waited = await run("wait", { job_id: id, timeout_s: 300 })
      expect(structured(waited).timed_out).toBe(true)
      expect(structured(waited).waited_ms).toBeGreaterThanOrEqual(100)
      expect(Date.now() - began).toBeLessThan(2000)
      await run("stop", { job_id: id })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BGJ_MAX_WAIT_MS
      else process.env.OPENCODE_BGJ_MAX_WAIT_MS = previous
    }
  })

  test("wait with no timeout_s uses the clamp too", async () => {
    const previous = process.env.OPENCODE_BGJ_MAX_WAIT_MS
    process.env.OPENCODE_BGJ_MAX_WAIT_MS = "120"
    try {
      const { run } = harness()
      const started = await run("start", { command: "sleep 30" })
      const id = structured(started).job_id as string
      const began = Date.now()
      const waited = await run("wait", { job_id: id })
      expect(structured(waited).timed_out).toBe(true)
      expect(Date.now() - began).toBeLessThan(2000)
      await run("stop", { job_id: id })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BGJ_MAX_WAIT_MS
      else process.env.OPENCODE_BGJ_MAX_WAIT_MS = previous
    }
  })

  test("output reads a session answered through the shared database", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          expect(pending.op).toBe("peek")
          store.answerSessionRequest(pending.id, { text: "working", running: true, messages: 4 })
          return
        }
        await Bun.sleep(10)
      }
    })()

    const result = await dispatch(new JobManager(), store, undefined, "output", { session_id: "ses_1" }, "/proj")
    await answered
    expect(structured(result).text).toBe("working")
    expect(structured(result).running).toBe(true)
    expect(structured(result).messages).toBe(4)
    expect(store.pendingSessionRequests("/proj")).toHaveLength(0)
  })

  test("output applies tail_bytes to a session answer", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          store.answerSessionRequest(pending.id, { text: "abcdef", running: false, messages: 1 })
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "output", { session_id: "ses_1", tail_bytes: 3 }, "/proj")
    await answered
    expect(structured(result).text).toBe("def")
    expect(structured(result).truncated).toBe(true)
  })

  test("output surfaces a session read error from the plugin", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          store.failSessionRequest(pending.id, "boom")
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "output", { session_id: "ses_1" }, "/proj")
    await answered
    expect(result).toMatchObject({ isError: true })
    expect((result.content as { text: string }[])[0]!.text).toContain("boom")
  })

  test("status reports a session through the shared database", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          expect(pending.op).toBe("status")
          store.answerSessionRequest(pending.id, { running: false, messages: 7 })
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "status", { session_id: "ses_1" }, "/proj")
    await answered
    expect(structured(result)).toMatchObject({ session_id: "ses_1", session: true, status: "completed", running: false, messages: 7 })
  })

  test("wait returns once a session goes idle", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          expect(pending.op).toBe("status")
          store.answerSessionRequest(pending.id, { running: false, messages: 2 })
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "wait", { session_id: "ses_1" }, "/proj")
    await answered
    expect(structured(result)).toMatchObject({ session_id: "ses_1", session: true, running: false, timed_out: false })
  })

  test("session wait clamps the block and returns timed_out while still running", async () => {
    const previous = process.env.OPENCODE_BGJ_MAX_WAIT_MS
    process.env.OPENCODE_BGJ_MAX_WAIT_MS = "150"
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    let serving = true
    const answered = (async () => {
      while (serving) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) store.answerSessionRequest(pending.id, { running: true, messages: 1 })
        await Bun.sleep(10)
      }
    })()
    try {
      const result = await dispatch(new JobManager(), store, undefined, "wait", { session_id: "ses_1" }, "/proj")
      expect(structured(result)).toMatchObject({ session_id: "ses_1", session: true, running: true, timed_out: true })
      expect(structured(result).waited_ms).toBeGreaterThanOrEqual(100)
    } finally {
      serving = false
      await answered
      if (previous === undefined) delete process.env.OPENCODE_BGJ_MAX_WAIT_MS
      else process.env.OPENCODE_BGJ_MAX_WAIT_MS = previous
    }
  })

  test("stop aborts a session through the shared database", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          expect(pending.op).toBe("abort")
          expect(pending.session_id).toBe("ses_1")
          store.answerSessionRequest(pending.id, { aborted: true })
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "stop", { session_id: "ses_1" }, "/proj")
    await answered
    expect(structured(result)).toMatchObject({ session_id: "ses_1", session: true, aborted: true })
  })

  test("list includes sessions answered through the shared database", async () => {
    const store = new JobStore(":memory:")
    store.setInstance("/proj", "http://localhost:4096/")
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const [pending] = store.pendingSessionRequests("/proj")
        if (pending) {
          expect(pending.op).toBe("list")
          store.answerSessionRequest(pending.id, {
            sessions: [{ session_id: "ses_child", parent_id: "ses_parent", title: "probe", running: true }],
          })
          return
        }
        await Bun.sleep(10)
      }
    })()
    const result = await dispatch(new JobManager(), store, undefined, "list", {}, "/proj")
    await answered
    const jobs = structured(result).jobs as { session_id?: string; session?: boolean }[]
    expect(jobs).toContainEqual(expect.objectContaining({ session_id: "ses_child", session: true }))
  })

  test("output errors for an unregistered session directory or no id", async () => {
    const { run } = harness()
    expect(await run("output", { session_id: "ses_1" })).toMatchObject({ isError: true })
    expect(await run("output", {})).toMatchObject({ isError: true })
    expect(await run("status", { session_id: "ses_1" })).toMatchObject({ isError: true })
    expect(await dispatch(new JobManager(), undefined, undefined, "output", { session_id: "ses_1" })).toMatchObject({ isError: true })
  })
})

describe("persistent job tools", () => {
  test("create, get, update, list, delete round trip", async () => {
    const { run } = harness()

    const created = await run("create_job", {
      name: "build",
      command: "make build",
      cwd: "/tmp",
      env: { NODE_ENV: "production" },
      timeout_ms: 1000,
      metadata: { team: "core" },
    })
    const definition = structured(created)
    expect(definition.id).toMatch(/^job-/)
    expect(definition.name).toBe("build")
    expect(definition.metadata).toEqual({ team: "core" })

    const fetched = await run("get_job", { job: "build" })
    expect(structured(fetched).command).toBe("make build")

    const fetchedById = await run("get_job", { job: definition.id })
    expect(structured(fetchedById).name).toBe("build")

    const updated = await run("update_job", { job: "build", command: "make test", metadata: { team: "infra" } })
    expect(structured(updated).command).toBe("make test")
    expect(structured(updated).metadata).toEqual({ team: "infra" })
    expect(structured(updated).cwd).toBe("/tmp")

    const listed = await run("list_jobs", {})
    expect(structured(listed).jobs).toHaveLength(1)

    const deleted = await run("delete_job", { job: "build" })
    expect(structured(deleted).deleted).toBe(true)
    expect(structured(await run("list_jobs", {})).jobs).toHaveLength(0)
  })

  test("duplicate names and unknown refs are error results", async () => {
    const { run } = harness()
    await run("create_job", { name: "dup", command: "true" })
    expect(await run("create_job", { name: "dup", command: "true" })).toMatchObject({ isError: true })
    expect(await run("get_job", { job: "nope" })).toMatchObject({ isError: true })
    expect(await run("update_job", { job: "nope", command: "x" })).toMatchObject({ isError: true })
    expect(await run("delete_job", { job: "nope" })).toMatchObject({ isError: true })
    expect(await run("run_job", { job: "nope" })).toMatchObject({ isError: true })
  })

  test("run_job uses the stored command and metadata", async () => {
    const { run } = harness()
    await run("create_job", { name: "greet", command: "printf 'from definition'", metadata: { k: "v" } })
    const started = await run("run_job", { job: "greet" })
    const info = structured(started)
    expect(info.definition_name).toBe("greet")
    expect(info.status).toBe("running")

    await run("wait", { job_id: info.job_id, timeout_s: 5 })
    expect(structured(await run("output", { job_id: info.job_id })).text).toBe("from definition")
  })

  test("persistent tools fail cleanly when the store is unavailable", async () => {
    const jobs = new JobManager()
    expect(await dispatch(jobs, undefined, undefined, "list_jobs", {})).toMatchObject({ isError: true })
    expect(await dispatch(jobs, undefined, undefined, "start", { command: "true" })).not.toMatchObject({ isError: true })
  })

  test("run_job records a completion with definition metadata", async () => {
    const store = new JobStore(":memory:")
    const jobs = new JobManager((result) => {
      const meta = result.meta ?? {}
      store.recordRun({
        id: result.info.id,
        command: result.info.command,
        status: result.info.status,
        exit_code: result.info.exit_code,
        output: result.output,
        notify: result.notify,
        started_at: result.info.started_at,
        ended_at: result.info.ended_at ?? Date.now(),
        definition_id: typeof meta.definition_id === "string" ? meta.definition_id : undefined,
        definition_name: typeof meta.definition_name === "string" ? meta.definition_name : undefined,
        metadata: meta.metadata as Record<string, unknown> | undefined,
      })
    })
    const run = (name: string, args: Record<string, unknown> = {}) => dispatch(jobs, store, new DetachedManager(store), name, args)
    await run("create_job", { name: "greet", command: "printf hi", metadata: { k: "v" } })
    const started = await run("run_job", { job: "greet" })
    const jobID = structured(started).job_id as string
    await run("wait", { job_id: jobID, timeout_s: 5 })

    const pending = store.pendingRuns()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.definition_name).toBe("greet")
    expect(pending[0]!.output).toBe("hi")
    expect(pending[0]!.metadata).toEqual({ k: "v" })
  })

  test("run_detached is routed through dispatch and inspectable", async () => {
    const { run } = harness()
    const started = await run("run_detached", { command: "printf routed" })
    expect(structured(started).detached).toBe(true)
    const id = structured(started).job_id as string
    let status = structured(started)
    for (let i = 0; i < 200 && status.status === "running"; i++) {
      await Bun.sleep(25)
      status = structured(await run("status", { job_id: id }))
    }
    expect(status.status).toBe("completed")
    expect(structured(await run("output", { job_id: id })).text).toBe("routed")
    const listed = structured(await run("list", {})).jobs as { detached?: boolean }[]
    expect(listed.at(-1)?.detached).toBe(true)
  })

  test("run_detached errors without a store", async () => {
    const jobs = new JobManager()
    expect(await dispatch(jobs, undefined, undefined, "run_detached", { command: "true" })).toMatchObject({ isError: true })
  })

  test("wait polls and reports a detached job, which no other job type can", async () => {
    const { run } = harness()
    const started = await run("run_detached", { command: "printf detached-wait" })
    const id = structured(started).job_id as string
    const waited = await run("wait", { job_id: id, timeout_s: 5 })
    expect(structured(waited).job.status).toBe("completed")
    expect(structured(waited).job.detached).toBe(true)
    expect(structured(waited).timed_out).toBe(false)
  })

  test("wait with timeout_s 0 checks a running detached job without blocking", async () => {
    const { run } = harness()
    const started = await run("run_detached", { command: "sleep 30" })
    const id = structured(started).job_id as string
    const began = Date.now()
    const checked = await run("wait", { job_id: id, timeout_s: 0 })
    expect(structured(checked).job.status).toBe("running")
    expect(structured(checked).timed_out).toBe(true)
    expect(structured(checked).waited_ms).toBeLessThan(150)
    expect(Date.now() - began).toBeLessThan(2000)
    await run("stop", { job_id: id })
  })
})
