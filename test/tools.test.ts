import { describe, expect, test } from "bun:test"
import { JobManager } from "../src/jobs"
import { JobStore } from "../src/store"
import { dispatch } from "../src/tools"

function harness() {
  const jobs = new JobManager()
  const store = new JobStore(":memory:")
  return {
    run: (name: string, args: Record<string, unknown> = {}) => dispatch(jobs, store, name, args),
    jobs,
    store,
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

    const waited = await run("wait", { job_id: id, timeout_s: 5 })
    expect(structured(waited).job.status).toBe("completed")

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
    expect(await dispatch(jobs, undefined, "list_jobs", {})).toMatchObject({ isError: true })
    expect(await dispatch(jobs, undefined, "start", { command: "true" })).not.toMatchObject({ isError: true })
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
    const run = (name: string, args: Record<string, unknown> = {}) => dispatch(jobs, store, name, args)
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
})
