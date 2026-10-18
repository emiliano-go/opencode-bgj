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

  test("unknown tool and unknown job are error results, not throws", async () => {
    const { run } = harness()
    expect(await run("nope")).toMatchObject({ isError: true })
    expect(await run("status", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await run("wait", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await run("output", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
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
    await run("stop", { job_id: id })
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
})
