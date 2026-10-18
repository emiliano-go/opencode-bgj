# Bug report: `wait` returns `MCP error -32001: Request timed out`

- Date: 2026-10-18
- Component: `opencode-bgj` MCP server, `wait` tool
- Version: 1.0.0
- Severity: high (the tool is unusable for any wait longer than the client's `mcp_timeout`)

## Summary

`wait` blocks server-side until the job finishes or `timeout_s` elapses, but the
opencode client abandons any MCP call that runs longer than `mcp_timeout`
(observed: 60000 ms). Any `wait` with `timeout_s > 60`, or with no `timeout_s`
at all (documented as "wait with no limit"), is therefore guaranteed to return
`MCP error -32001: Request timed out` instead of the job state. The tool cannot
do what its description promises under the default configuration.

## Reproduction

1. Start a job that runs for more than 60 seconds:
   `start { command: "sleep 300" }` -> `bgj-XXXX`
2. Call `wait { job_id: "bgj-XXXX", timeout_s: 300 }`.
3. Observe: `MCP error -32001: Request timed out` after ~60 s, rather than
   `{ job: {...}, timed_out: true }` after 300 s.

Calling `wait { job_id }` with no `timeout_s` fails the same way.

## Evidence

- Client timeout, `/home/eclipse/.config/opencode/opencode.json`:
  ```json
  { "mcp": { ... }, "mcp_timeout": 60000 }
  ```
- Server blocks for the full (or unbounded) duration, `src/jobs.ts:145`:
  ```ts
  async wait(id: string, timeoutMs?: number): Promise<WaitResult> {
    ...
    if (timeoutMs === undefined) {
      await entry.exited            // unbounded
      return { job: snapshot(entry), timed_out: false }
    }
    ...
    const winner = await Promise.race([entry.exited.then(() => "exit"), timeout])
    return { job: snapshot(entry), timed_out: winner === "timeout" }
  }
  ```
- Tool handler passes `timeout_s` straight through, `src/tools.ts:315`:
  ```ts
  const result = await jobs.wait(id, timeout_s === undefined ? undefined : timeout_s * 1000)
  ```
- The description actively promises unbounded blocking, `src/tools.ts:135`
  ("Omit to wait with no limit until the job finishes").
- `sessionWait` has the same shape: it loops until `deadline`, where
  `timeoutSeconds === undefined` sets `deadline = Infinity` (`src/tools.ts:536`).

## Root cause

The server's wait horizon (`timeout_s`, or infinity) is independent of the
transport's request timeout (`mcp_timeout`). When the former exceeds the latter,
the JSON-RPC request is cancelled with error `-32001` before the handler can
return. The server cannot see the client's `mcp_timeout`, so it has no way to
know a long wait will be discarded.

## Recommended fix

Clamp the effective wait to a conservative ceiling that is safely below typical
client timeouts, and return normally with `timed_out: true` when the ceiling is
hit, so the call always resolves before the transport cancels it. The agent
then calls `wait` again (progress is preserved).

```ts
// ponytail: cap below the client's mcp_timeout (60s default); re-call to continue
const MAX_WAIT_MS = 45_000

const wanted = timeoutMs === undefined ? MAX_WAIT_MS : Math.min(timeoutMs, MAX_WAIT_MS)
if (wanted <= 0) return { job: snapshot(entry), timed_out: true, ... }
```

Then:

- Update the `timeout_s` description and README (`README.md:161`) to state the
  effective maximum and that a `timed_out: true` result means "call again",
  not "the job is gone".
- Apply the same clamp in `sessionWait` (`src/tools.ts:536`), where it is even
  more important because the omitted-timeout case is `Infinity`.
- Consider echoing the applied cap in the result (for example
  `waited_ms`) so a caller can tell a real timeout from the clamp.

Alternatives considered:

- Raise `mcp_timeout`: helps only up to the new number, penalises every other
  MCP call, and still cannot support the documented "no limit" case. Not
  sufficient alone.
- Make `wait` re-entrant without a cap: still cancelled at `mcp_timeout`; the
  cap is what makes it reliable.

## Verification

- A test that starts `sleep 2`, calls `wait` with `timeout_s: 300`, and asserts
  the call returns within `MAX_WAIT_MS + slack` with `timed_out: true` (not a
  transport error).
- A test that omits `timeout_s` and asserts the same bounded return.
- Existing fast-path tests (`timeout_s: 0`, already-finished jobs) must still
  return immediately.
