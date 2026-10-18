import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "../src/store"

const dir = mkdtempSync(join(tmpdir(), "bgj-plugin-"))
const dbPath = join(dir, "jobs.db")
process.env.OPENCODE_BGJ_DB = dbPath
process.env.BGJ_POLL_MS = "20"

afterAll(() => {
  process.env.OPENCODE_BGJ_DB = join(dir, "gone.db")
  rmSync(dir, { recursive: true, force: true })
})

test("plugin delivers only its directory's finished jobs and clears their rows", async () => {
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
  const client = {
    session: {
      promptAsync: async (options: { path: { id: string }; body: { parts: any[] } }) => {
        targets.push(options.path.id)
        parts.push(options.body.parts[0])
        prompts.push(options.body.parts[0].text)
        return {}
      },
      messages: async (_options: { path: { id: string } }) => ({
        data: [{ info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "peeked" }] }],
      }),
      list: async () => ({
        data: [
          { id: "ses_parent", title: "parent" },
          { id: "ses_child", parentID: "ses_parent", title: "probe" },
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

  expect(prompts).toHaveLength(1)
  expect(targets[0]).toBe("ses_test")
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

  // Per-session routing: the tool.execute.after hook maps job_id -> session.
  await hooks["tool.execute.after"]({ tool: "bgj_start", sessionID: "ses_owner" }, { structuredContent: { job_id: "bgj-owned" } })
  await hooks["tool.execute.after"](
    { tool: "bgj_run_job", sessionID: "ses_owner" },
    { content: [{ text: JSON.stringify({ job_id: "bgj-text" }) }] },
  )
  // a non-start tool is ignored even with a plausible id
  await hooks["tool.execute.after"]({ tool: "bgj_status", sessionID: "ses_owner" }, { structuredContent: { job_id: "bgj-ignored" } })
  // an id that is not ours is ignored even from a start tool
  await hooks["tool.execute.after"]({ tool: "bgj_start", sessionID: "ses_owner" }, { structuredContent: { job_id: "not-ours" } })

  check.recordRun({ id: "bgj-owned", command: "echo owned", status: "completed", exit_code: 0, output: "owned\n", notify: true, started_at: 1, ended_at: 3, directory: "/proj/test" })
  check.recordRun({ id: "bgj-text", command: "echo text", status: "completed", exit_code: 0, output: "text\n", notify: true, started_at: 1, ended_at: 4, directory: "/proj/test" })
  check.recordRun({ id: "bgj-ignored", command: "echo ignored", status: "completed", exit_code: 0, output: "ignored\n", notify: true, started_at: 1, ended_at: 5, directory: "/proj/test" })
  check.recordRun({ id: "not-ours", command: "echo notours", status: "completed", exit_code: 0, output: "notours\n", notify: true, started_at: 1, ended_at: 6, directory: "/proj/test" })

  for (let i = 0; i < 200 && prompts.length < 5; i++) await Bun.sleep(20)

  expect(targets[1]).toBe("ses_owner")
  expect(targets[2]).toBe("ses_owner")
  expect(targets[3]).toBe("ses_test")
  expect(targets[4]).toBe("ses_test")
  expect(toasts).toHaveLength(5)

  const peekID = check.createSessionRequest("/proj/test", "peek", "ses_peek")
  for (let i = 0; i < 200 && check.sessionRequest(peekID)?.status === "pending"; i++) await Bun.sleep(20)
  const peek = check.sessionRequest(peekID)
  expect(peek?.status).toBe("done")
  expect(peek?.result).toMatchObject({ text: "peeked", running: true, messages: 1 })

  const listID = check.createSessionRequest("/proj/test", "list")
  for (let i = 0; i < 200 && check.sessionRequest(listID)?.status === "pending"; i++) await Bun.sleep(20)
  expect(check.sessionRequest(listID)?.result).toMatchObject({
    sessions: [{ session_id: "ses_child", parent_id: "ses_parent", title: "probe", running: true }],
  })

  const abortID = check.createSessionRequest("/proj/test", "abort", "ses_child")
  for (let i = 0; i < 200 && check.sessionRequest(abortID)?.status === "pending"; i++) await Bun.sleep(20)
  expect(check.sessionRequest(abortID)?.result).toEqual({ aborted: true })
  check.close()
})
