import { describe, expect, test } from "bun:test"
import { JobManager } from "../src/jobs"
import { dispatch } from "../src/tools"

function structured(result: Record<string, unknown>) {
  return result.structuredContent as Record<string, any>
}

describe("dispatch", () => {
  test("start returns a job id and wait surfaces output", async () => {
    const jobs = new JobManager()
    const started = await dispatch(jobs, "start", { command: "printf dispatched" })
    expect(started.isError).toBeUndefined()
    const id = structured(started).job_id as string
    expect(id).toMatch(/^bgj-/)

    const waited = await dispatch(jobs, "wait", { job_id: id, timeout_s: 5 })
    expect(structured(waited).job.status).toBe("completed")

    const out = await dispatch(jobs, "output", { job_id: id })
    expect(structured(out).text).toBe("dispatched")
  })

  test("list reports jobs", async () => {
    const jobs = new JobManager()
    await dispatch(jobs, "start", { command: "sleep 30", timeout_ms: 1 })
    const listed = await dispatch(jobs, "list", {})
    expect(structured(listed).jobs).toHaveLength(1)
  })

  test("unknown tool and unknown job are error results, not throws", async () => {
    const jobs = new JobManager()
    expect(await dispatch(jobs, "nope", {})).toMatchObject({ isError: true })
    expect(await dispatch(jobs, "status", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await dispatch(jobs, "wait", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
    expect(await dispatch(jobs, "output", { job_id: "bgj-missing" })).toMatchObject({ isError: true })
  })

  test("missing required command is an error result", async () => {
    const jobs = new JobManager()
    expect(await dispatch(jobs, "start", {})).toMatchObject({ isError: true })
  })

  test("wait returns timed_out without finishing", async () => {
    const jobs = new JobManager()
    const started = await dispatch(jobs, "start", { command: "sleep 30" })
    const id = structured(started).job_id as string
    const waited = await dispatch(jobs, "wait", { job_id: id, timeout_s: 0.05 })
    expect(structured(waited).timed_out).toBe(true)
    await dispatch(jobs, "stop", { job_id: id })
  })
})
