import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "../src/store"

const dir = mkdtempSync(join(tmpdir(), "bgj-plugin-"))
const dbPath = join(dir, "jobs.db")
process.env.OPENCODE_BGJ_DB = dbPath
process.env.BGJ_POLL_MS = "20"
process.env.OPENCODE_BGJ_DELIVER_TIMEOUT_MS = "100"

afterAll(() => {
  process.env.OPENCODE_BGJ_DB = join(dir, "gone.db")
  rmSync(dir, { recursive: true, force: true })
})

test("plugin routes finished jobs to their session and survives a stuck delivery", async () => {
  const store = new JobStore(dbPath)
  store.recordRun({
    id: "bgj-plugin1",
    command: "echo hello from plugin",
    cwd: "/tmp",
    status: "completed",
    exit_code: 0,
    output: "hello from plugin\n",
    notify: true,
    started_at: 1,
    ended_at: 2,
    definition_name: "demo",
    definition_id: "job-abc",
    metadata: { owner: "test" },
    directory: "/proj/test",
  })
  store.recordRun({
    id: "bgj-silent",
    command: "true",
    status: "completed",
    exit_code: 0,
    output: "",
    notify: false,
    started_at: 1,
    ended_at: 2,
    directory: "/proj/test",
  })
  store.recordRun({
    id: "bgj-other",
    command: "echo elsewhere",
    status: "completed",
    exit_code: 0,
    output: "elsewhere\n",
    notify: true,
    started_at: 1,
    ended_at: 2,
    directory: "/proj/other",
  })
  store.close()

  const prompts: string[] = []
  const targets: string[] = []
  const parts: any[] = []
  const toasts: string[] = []
  let hangRetry = 1
  const client = {
    session: {
      promptAsync: async (options: { path: { id: string }; body: { parts: any[] } }) => {
        const text = options.body.parts[0].text as string
        targets.push(options.path.id)
        parts.push(options.body.parts[0])
        prompts.push(text)
        // Model a request that never settles: without a timeout this would wedge
        // the whole poll loop and the retry below would never be delivered.
        if (text.includes("bgj-retry") && hangRetry-- > 0) return new Promise<never>(() => {})
        return {}
      },
      messages: async (_options: { path: { id: string } }) => ({
        data: [{ info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "peeked" }] }],
      }),
      // A newer subagent session must never be chosen: only top-level sessions
      // are valid fallback targets.
      list: async () => ({
        data: [
          { id: "ses_parent", title: "parent", time: { updated: 1 } },
          { id: "ses_recent", title: "recent", time: { updated: 10 } },
          { id: "ses_child", parentID: "ses_parent", title: "subagent", time: { updated: 99 } },
        ],
      }),
      status: async () => ({ data: { ses_parent: { type: "idle" }, ses_child: { type: "busy" } } }),
      abort: async () => ({ data: true }),
    },
    tui: {
      showToast: async (options: { body: { message: string } }) => {
        toasts.push(options.body.message)
        return true
      },
    },
  }

  const mod = await import("../plugin/bgj-notify")
  const hooks = (await mod.default({ client, directory: "/proj/test", serverUrl: new URL("http://127.0.0.1:1234") })) as {
    event: (input: any) => Promise<void>
    "tool.execute.after": (input: any, output: any) => Promise<void>
  }
  await hooks.event({ event: { properties: { sessionID: "ses_test" } } })

  for (let i = 0; i < 200 && prompts.length === 0; i++) await Bun.sleep(20)

  // No mapping for bgj-plugin1, so it falls back to the newest top-level session.
  expect(prompts).toHaveLength(1)
  expect(targets[0]).toBe("ses_recent")
  expect(prompts[0]).toContain("echo hello from plugin")
  expect(prompts[0]).toContain("hello from plugin")
  expect(prompts[0]).toContain("definition: demo (job-abc)")
  expect(parts[0].synthetic).toBeUndefined()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain("demo")

  const check = new JobStore(dbPath)
  expect(check.pendingRuns("/proj/test")).toHaveLength(0)
  expect(check.pendingRuns("/proj/other").map((run) => run.id)).toEqual(["bgj-other"])
  expect(check.instanceURL("/proj/test")).toBe("http://127.0.0.1:1234/")

  // Per-session routing: the tool.execute.after hook persists job_id -> session.
  await hooks["tool.execute.after"]({ tool: "bgj_start", sessionID: "ses_owner" }, { structuredContent: { job_id: "bgj-owned" } })
  await hooks["tool.execute.after"](
    { tool: "bgj_run_job", sessionID: "ses_owner" },
    { content: [{ text: JSON.stringify({ job_id: "bgj-text" }) }] },
  )
  // a non-start tool is ignored even with a plausible id
  await hooks["tool.execute.after"]({ tool: "bgj_status", sessionID: "ses_owner" }, { structuredContent: { job_id: "bgj-ignored" } })
  // an id that is not ours is ignored even from a start tool
  await hooks["tool.execute.after"]({ tool: "bgj_start", sessionID: "ses_owner" }, { structuredContent: { job_id: "not-ours" } })

  expect(check.jobSession("bgj-owned")?.session_id).toBe("ses_owner")
  expect(check.jobSession("bgj-text")?.session_id).toBe("ses_owner")
  expect(check.jobSession("bgj-ignored")).toBeUndefined()

  check.recordRun({ id: "bgj-owned", command: "echo owned", status: "completed", exit_code: 0, output: "owned\n", notify: true, started_at: 1, ended_at: 3, directory: "/proj/test" })
  check.recordRun({ id: "bgj-text", command: "echo text", status: "completed", exit_code: 0, output: "text\n", notify: true, started_at: 1, ended_at: 4, directory: "/proj/test" })
  check.recordRun({ id: "bgj-ignored", command: "echo ignored", status: "completed", exit_code: 0, output: "ignored\n", notify: true, started_at: 1, ended_at: 5, directory: "/proj/test" })
  check.recordRun({ id: "not-ours", command: "echo notours", status: "completed", exit_code: 0, output: "notours\n", notify: true, started_at: 1, ended_at: 6, directory: "/proj/test" })

  for (let i = 0; i < 200 && prompts.length < 5; i++) await Bun.sleep(20)

  expect(targets[1]).toBe("ses_owner")
  expect(targets[2]).toBe("ses_owner")
  expect(targets[3]).toBe("ses_recent")
  expect(targets[4]).toBe("ses_recent")
  expect(toasts).toHaveLength(5)
  expect(check.jobSession("bgj-owned")).toBeUndefined()

  // A delivery that never settles must not stop later runs: the first attempt for
  // bgj-retry hangs, the poll times out, and a later poll delivers it.
  check.recordRun({ id: "bgj-retry", command: "echo retry", status: "completed", exit_code: 0, output: "retry\n", notify: true, started_at: 1, ended_at: 50, directory: "/proj/test" })
  for (let i = 0; i < 300 && check.pendingRuns("/proj/test").some((run) => run.id === "bgj-retry"); i++) await Bun.sleep(20)
  expect(hangRetry).toBeLessThan(0)
  expect(check.pendingRuns("/proj/test").map((run) => run.id)).not.toContain("bgj-retry")
  expect(prompts.some((prompt) => prompt.includes("bgj-retry"))).toBe(true)

  const peekID = check.createSessionRequest("/proj/test", "peek", "ses_peek")
  for (let i = 0; i < 200 && check.sessionRequest(peekID)?.status === "pending"; i++) await Bun.sleep(20)
  const peek = check.sessionRequest(peekID)
  expect(peek?.status).toBe("done")
  expect(peek?.result).toMatchObject({ text: "peeked", running: true, messages: 1 })

  const listID = check.createSessionRequest("/proj/test", "list")
  for (let i = 0; i < 200 && check.sessionRequest(listID)?.status === "pending"; i++) await Bun.sleep(20)
  expect(check.sessionRequest(listID)?.result).toMatchObject({
    sessions: [{ session_id: "ses_child", parent_id: "ses_parent", title: "subagent", running: true }],
  })

  const abortID = check.createSessionRequest("/proj/test", "abort", "ses_child")
  for (let i = 0; i < 200 && check.sessionRequest(abortID)?.status === "pending"; i++) await Bun.sleep(20)
  expect(check.sessionRequest(abortID)?.result).toEqual({ aborted: true })
  check.close()
})
