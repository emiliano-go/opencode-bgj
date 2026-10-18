import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore, defaultDatabasePath } from "../src/store"

const tempFiles: string[] = []

function tempDb(): string {
  const path = join(tmpdir(), `opencode-bgj-test-${crypto.randomUUID()}.db`)
  tempFiles.push(path)
  return path
}

afterEach(() => {
  for (const path of tempFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  }
})

describe("JobStore", () => {
  test("create assign id, timestamps and defaults", () => {
    const store = new JobStore(":memory:")
    const created = store.create({ name: "a", command: "echo a" })
    expect(created.id).toMatch(/^job-/)
    expect(created.created_at).toBe(created.updated_at)
    expect(created.env).toBeUndefined()
    expect(created.metadata).toBeUndefined()
  })

  test("rejects duplicate names and empty fields", () => {
    const store = new JobStore(":memory:")
    store.create({ name: "a", command: "echo a" })
    expect(() => store.create({ name: "a", command: "echo b" })).toThrow(/already exists/)
    expect(() => store.create({ name: "", command: "x" })).toThrow(/name is required/)
    expect(() => store.create({ name: "b", command: "" })).toThrow(/command is required/)
  })

  test("get resolves by id or name", () => {
    const store = new JobStore(":memory:")
    const created = store.create({ name: "a", command: "echo a" })
    expect(store.get(created.id)?.name).toBe("a")
    expect(store.get("a")?.id).toBe(created.id)
    expect(store.get("missing")).toBeUndefined()
  })

  test("update merges only provided fields", () => {
    const store = new JobStore(":memory:")
    const created = store.create({ name: "a", command: "echo a", cwd: "/tmp", metadata: { x: 1 } })
    const updated = store.update("a", { command: "echo b" })!
    expect(updated.command).toBe("echo b")
    expect(updated.cwd).toBe("/tmp")
    expect(updated.metadata).toEqual({ x: 1 })
    expect(updated.updated_at).toBeGreaterThanOrEqual(created.updated_at)
    expect(store.update("missing", { command: "x" })).toBeUndefined()
  })

  test("update can rename and refuses an existing name", () => {
    const store = new JobStore(":memory:")
    store.create({ name: "a", command: "echo a" })
    const b = store.create({ name: "b", command: "echo b" })
    expect(store.update(b.id, { name: "c" })?.name).toBe("c")
    expect(() => store.update("c", { name: "a" })).toThrow(/already exists/)
  })

  test("delete removes and reports presence", () => {
    const store = new JobStore(":memory:")
    store.create({ name: "a", command: "echo a" })
    expect(store.delete("a")).toBe(true)
    expect(store.delete("a")).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  test("persists to a centralized file across instances", () => {
    const path = tempDb()
    const first = new JobStore(path)
    const created = first.create({ name: "a", command: "echo a", metadata: { k: "v" } })
    first.close()

    const second = new JobStore(path)
    const loaded = second.get("a")
    expect(loaded?.id).toBe(created.id)
    expect(loaded?.metadata).toEqual({ k: "v" })
    second.close()
  })

  test("survives corrupt JSON in stored rows instead of throwing", () => {
    const path = tempDb()
    const first = new JobStore(path)
    const created = first.create({ name: "a", command: "echo a", metadata: { k: "v" } })
    first.recordRun({
      id: "bgj-x",
      command: "true",
      status: "completed",
      exit_code: 0,
      output: "",
      notify: true,
      started_at: 1,
      ended_at: 1,
      metadata: { k: "v" },
    })
    first.close()

    const raw = new Database(path)
    raw.query("UPDATE job_definitions SET metadata = ? WHERE id = ?").run("{not json", created.id)
    raw.query("UPDATE job_runs SET metadata = ? WHERE id = ?").run("{not json", "bgj-x")
    raw.close()

    const second = new JobStore(path)
    expect(second.get(created.id)?.metadata).toBeUndefined()
    expect(second.get(created.id)?.name).toBe("a")
    expect(second.list()).toHaveLength(1)
    expect(second.pendingRuns()[0]?.metadata).toBeUndefined()
    second.close()
  })

  test("close is idempotent", () => {
    const store = new JobStore(":memory:")
    store.close()
    expect(() => store.close()).not.toThrow()
  })

  test("defaultDatabasePath honours OPENCODE_BGJ_DB", () => {
    const previous = process.env.OPENCODE_BGJ_DB
    process.env.OPENCODE_BGJ_DB = "/custom/jobs.db"
    expect(defaultDatabasePath()).toBe("/custom/jobs.db")
    if (previous === undefined) delete process.env.OPENCODE_BGJ_DB
    else process.env.OPENCODE_BGJ_DB = previous
  })
})

describe("JobStore run log", () => {
  test("records runs and lists only pending notifications", () => {
    const store = new JobStore(":memory:")
    store.recordRun({
      id: "bgj-1",
      command: "echo a",
      cwd: "/tmp",
      status: "completed",
      exit_code: 0,
      output: "a\n",
      notify: true,
      started_at: 1,
      ended_at: 2,
      definition_id: "job-x",
      definition_name: "x",
      metadata: { k: "v" },
    })
    store.recordRun({ id: "bgj-2", command: "true", status: "completed", exit_code: 0, output: "", notify: false, started_at: 1, ended_at: 2 })

    const pending = store.pendingRuns()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe("bgj-1")
    expect(pending[0]!.metadata).toEqual({ k: "v" })
    expect(pending[0]!.definition_name).toBe("x")
  })

  test("pendingRuns scopes by directory", () => {
    const store = new JobStore(":memory:")
    const base = { command: "true", status: "completed", exit_code: 0, output: "", notify: true, started_at: 1 }
    store.recordRun({ ...base, id: "bgj-a", ended_at: 1, directory: "/proj/a" })
    store.recordRun({ ...base, id: "bgj-b", ended_at: 2, directory: "/proj/b" })
    store.recordRun({ ...base, id: "bgj-c", ended_at: 3, directory: "/proj/a" })
    store.recordRun({ ...base, id: "bgj-legacy", ended_at: 4 })

    expect(store.pendingRuns("/proj/a").map((run) => run.id)).toEqual(["bgj-a", "bgj-c"])
    expect(store.pendingRuns("/proj/b").map((run) => run.id)).toEqual(["bgj-b"])
    expect(store.pendingRuns("/proj/a")[0]!.directory).toBe("/proj/a")
    expect(store.pendingRuns().map((run) => run.id)).toEqual(["bgj-a", "bgj-b", "bgj-c", "bgj-legacy"])
  })

  test("migrates a pre-directory job_runs table without losing rows", () => {
    const path = tempDb()
    const raw = new Database(path)
    raw.exec(
      "CREATE TABLE job_runs (id TEXT PRIMARY KEY, definition_id TEXT, definition_name TEXT, command TEXT NOT NULL, cwd TEXT, status TEXT NOT NULL, exit_code INTEGER, output TEXT, notify INTEGER NOT NULL DEFAULT 1, notified INTEGER NOT NULL DEFAULT 0, metadata TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL)",
    )
    raw.query("INSERT INTO job_runs (id, command, status, notify, notified, started_at, ended_at) VALUES ('bgj-old', 'true', 'completed', 1, 0, 1, 1)").run()
    raw.close()

    const store = new JobStore(path)
    expect(store.pendingRuns("/proj/a")).toHaveLength(0)
    expect(store.pendingRuns().map((run) => run.id)).toEqual(["bgj-old"])
    store.close()
  })

  test("deleteRun removes a row and pruneRuns drops old rows", () => {
    const store = new JobStore(":memory:")
    store.recordRun({ id: "bgj-old", command: "true", status: "completed", exit_code: 0, output: "", notify: true, started_at: 1, ended_at: 1 })
    store.recordRun({ id: "bgj-new", command: "true", status: "completed", exit_code: 0, output: "", notify: true, started_at: 1, ended_at: Date.now() })

    expect(store.pruneRuns(60_000)).toBe(1)
    expect(store.pendingRuns().map((run) => run.id)).toEqual(["bgj-new"])
    expect(store.deleteRun("bgj-new")).toBe(true)
    expect(store.deleteRun("bgj-new")).toBe(false)
    expect(store.pendingRuns()).toHaveLength(0)
  })
})
