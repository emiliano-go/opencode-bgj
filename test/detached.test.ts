import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DetachedManager } from "../src/detached"
import { JobStore } from "../src/store"

const tempFiles: string[] = []

function tempDb(): string {
  const path = join(tmpdir(), `opencode-bgj-detached-${crypto.randomUUID()}.db`)
  tempFiles.push(path)
  return path
}

afterEach(() => {
  for (const path of tempFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  }
})

async function settled(manager: DetachedManager, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = manager.status(id)
    if (status && status.status !== "running") return status
    await Bun.sleep(25)
  }
  return manager.status(id)
}

describe("DetachedManager", () => {
  test("captures the exit code and output of a detached run", async () => {
    const store = new JobStore(tempDb())
    const manager = new DetachedManager(store)
    const run = manager.start({ command: "echo hi; exit 3" }, "/proj")
    expect(run.status).toBe("running")
    expect(run.detached).toBe(true)
    expect(run.pid).toBeGreaterThan(0)
    expect(run.elapsed_ms).toBeGreaterThanOrEqual(0)
    const status = await settled(manager, run.job_id)
    expect(status?.status).toBe("failed")
    expect(status?.exit_code).toBe(3)
    expect(status?.elapsed_ms).toBeGreaterThanOrEqual(0)
    expect(manager.output(run.job_id)?.text).toContain("hi")
    store.close()
  })

  test("a successful run completes and output supports tail and offset", async () => {
    const store = new JobStore(tempDb())
    const manager = new DetachedManager(store)
    const run = manager.start({ command: "printf abcdef" }, "/proj")
    const status = await settled(manager, run.job_id)
    expect(status?.status).toBe("completed")
    expect(status?.exit_code).toBe(0)
    expect(manager.output(run.job_id, { tailBytes: 3 })).toMatchObject({ text: "def", truncated: true })
    expect(manager.output(run.job_id, { offset: 2 })?.text).toBe("cdef")
    store.close()
  })

  test("stop kills a running detached job", async () => {
    const store = new JobStore(tempDb())
    const manager = new DetachedManager(store)
    const run = manager.start({ command: "sleep 60" }, "/proj")
    await Bun.sleep(150)
    expect(manager.status(run.job_id)?.status).toBe("running")
    const stopped = await manager.stop(run.job_id)
    expect(stopped?.status).toBe("killed")
    expect(manager.status(run.job_id)?.status).toBe("killed")
    store.close()
  })

  test("a finished run is readable through a fresh manager over the same store", async () => {
    const dbPath = tempDb()
    const first = new JobStore(dbPath)
    const run = new DetachedManager(first).start({ command: "printf persisted" }, "/proj")
    await settled(new DetachedManager(first), run.job_id)
    first.close()
    const second = new JobStore(dbPath)
    const manager = new DetachedManager(second)
    expect(manager.status(run.job_id)?.status).toBe("completed")
    expect(manager.output(run.job_id)?.text).toBe("persisted")
    second.close()
  })

  test("list is scoped to the directory", async () => {
    const store = new JobStore(tempDb())
    const manager = new DetachedManager(store)
    const a = manager.start({ command: "sleep 30" }, "/proj/a")
    const b = manager.start({ command: "sleep 30" }, "/proj/b")
    expect(manager.list("/proj/a")).toHaveLength(1)
    expect(manager.list("/proj/b")).toHaveLength(1)
    expect(manager.list()).toHaveLength(2)
    await manager.stop(a.job_id)
    await manager.stop(b.job_id)
    store.close()
  })

  test("prune removes finished runs but keeps running ones", async () => {
    const store = new JobStore(tempDb())
    const manager = new DetachedManager(store)
    const done = manager.start({ command: "true" }, "/proj")
    await settled(manager, done.job_id)
    const running = manager.start({ command: "sleep 30" }, "/proj")
    await Bun.sleep(50)
    expect(store.pruneDetached(0)).toBe(1)
    expect(store.detached(done.job_id)).toBeUndefined()
    expect(store.detached(running.job_id)).toBeDefined()
    await manager.stop(running.job_id)
    store.close()
  })
})
