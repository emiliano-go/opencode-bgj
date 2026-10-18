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

test("plugin injects a synthetic message for a finished job and clears the row", async () => {
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
  })
  store.close()

  const prompts: string[] = []
  const parts: any[] = []
  const toasts: string[] = []
  const client = {
    session: {
      promptAsync: async (options: { path: { id: string }; body: { parts: any[] } }) => {
        parts.push(options.body.parts[0])
        prompts.push(options.body.parts[0].text)
        return {}
      },
    },
    tui: {
      showToast: async (options: { body: { message: string } }) => {
        toasts.push(options.body.message)
        return true
      },
    },
  }

  const mod = await import("../plugin/bgj-notify")
  const hooks = (await mod.default({ client })) as { event: (input: any) => Promise<void> }
  await hooks.event({ event: { properties: { sessionID: "ses_test" } } })

  for (let i = 0; i < 200 && prompts.length === 0; i++) await Bun.sleep(20)

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain("echo hello from plugin")
  expect(prompts[0]).toContain("hello from plugin")
  expect(prompts[0]).toContain("definition: demo (job-abc)")
  expect(parts[0].synthetic).toBeUndefined()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain("demo")

  const check = new JobStore(dbPath)
  expect(check.pendingRuns()).toHaveLength(0)
  expect(check.list()).toHaveLength(0)
  check.close()
})
