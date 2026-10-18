import { describe, expect, test } from "bun:test"
import { JobManager } from "../src/jobs"

describe("JobManager", () => {
  test("runs a job to completion and captures output", async () => {
    const jobs = new JobManager()
    const started = jobs.start({ command: "printf 'hello'; printf 'world' >&2" })
    expect(started.status).toBe("running")
    expect(started.pid).toBeGreaterThan(0)

    const { job, timed_out } = await jobs.wait(started.id, 5_000)
    expect(timed_out).toBe(false)
    expect(job.status).toBe("completed")
    expect(job.exit_code).toBe(0)
    expect(job.ended_at).not.toBeNull()

    const out = jobs.output(started.id)!
    expect(out.text).toContain("hello")
    expect(out.text).toContain("world")
    expect(out.size_bytes).toBe(10)
  })

  test("marks a non-zero exit as failed", async () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "exit 3" })
    const { job: done } = await jobs.wait(job.id, 5_000)
    expect(done.status).toBe("failed")
    expect(done.exit_code).toBe(3)
  })

  test("kills a job on timeout", async () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "sleep 30", timeout_ms: 200 })
    const started = Date.now()
    const { job: done } = await jobs.wait(job.id, 10_000)
    expect(done.status).toBe("timed_out")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("stops a running job", async () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "sleep 30" })
    const stopped = await jobs.stop(job.id)
    expect(stopped!.status).toBe("killed")
  })

  test("output supports offset and tail", async () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "printf abcdefghij" })
    await jobs.wait(job.id, 5_000)

    const all = jobs.output(job.id)!
    expect(all.text).toBe("abcdefghij")
    expect(all.truncated).toBe(false)

    expect(jobs.output(job.id, { offset: 3 })!.text).toBe("defghij")
    expect(jobs.output(job.id, { tailBytes: 3 })!.text).toBe("hij")
    expect(jobs.output(job.id, { offset: 3 })!.truncated).toBe(true)
  })

  test("lists active jobs and reports unknown ids", async () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "sleep 30" })
    expect(jobs.list(true).map((j) => j.id)).toContain(job.id)
    expect(jobs.status("bgj-nope")).toBeUndefined()
    expect(jobs.output("bgj-nope")).toBeUndefined()
    await expect(jobs.wait("bgj-nope")).rejects.toThrow()
    await jobs.stop(job.id)
  })

  test("reports a spawn failure as a failed job", () => {
    const jobs = new JobManager()
    const job = jobs.start({ command: "true", shell: "/nonexistent/shell" })
    expect(job.status).toBe("failed")
    expect(jobs.output(job.id)!.text.length).toBeGreaterThan(0)
  })

  test("invokes the finish callback with output, notify flag and meta", async () => {
    const results: { status: string; output: string; notify: boolean; meta?: Record<string, unknown> }[] = []
    const jobs = new JobManager((result) => {
      results.push({ status: result.info.status, output: result.output, notify: result.notify, meta: result.meta })
    })
    const job = jobs.start({ command: "printf finished", notify: false, meta: { definition_name: "demo" } })
    await jobs.wait(job.id, 5_000)

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe("completed")
    expect(results[0]!.output).toBe("finished")
    expect(results[0]!.notify).toBe(false)
    expect(results[0]!.meta).toEqual({ definition_name: "demo" })
  })
})
