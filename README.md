# opencode-bgj

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that gives the opencode agent tools to launch and supervise long-running
shell jobs in the background, without blocking its turn.

The server is named `bgj`, so opencode exposes its tools to the model as
`bgj_start`, `bgj_list`, `bgj_status`, `bgj_output`, `bgj_stop`, and `bgj_wait`.

## Features

- Start any shell command and get a job id back immediately.
- Read captured stdout and stderr while the job runs, by byte offset or tail.
- Wait for a job to finish, or block for a bounded number of seconds.
- Stop a job and its entire child process tree (SIGTERM, then SIGKILL after a
  five second grace period).
- Kill a job automatically after an optional timeout.
- Jobs run detached in their own process group.

## Tools

| Tool | Input | Output |
|---|---|---|
| `start` | `{ command, cwd?, env?, shell?, timeout_ms? }` | job info |
| `list` | `{ active_only? }` | `{ jobs: [...] }` |
| `status` | `{ job_id }` | job info |
| `output` | `{ job_id, tail_bytes?, offset? }` | `{ text, size_bytes, truncated }` |
| `stop` | `{ job_id, signal? }` | job info |
| `wait` | `{ job_id, timeout_s? }` | `{ job, timed_out }` |

`start` takes a shell command string and runs it with `/bin/sh -c` by default.
Pass `shell` to choose another shell, `env` to add environment variables, `cwd`
to set the working directory, and `timeout_ms` to cap the run time.

### Job info

Every job info object contains:

- `job_id`: identifier of the form `bgj-xxxxxxxx`.
- `command`: the command that was run.
- `cwd`: the working directory.
- `pid`: the process id, or `-1` when the spawn failed.
- `status`: one of `running`, `completed`, `failed`, `timed_out`, `killed`.
- `exit_code`: the exit code, or `null` while running.
- `started_at` and `ended_at`: epoch milliseconds.
- `error`: present only when the process could not be spawned.

## Behaviour

- stdout and stderr share a single buffer capped at 1 MiB. When the cap is
  reached the oldest bytes are dropped, so `output` always returns the most
  recent data. `output` reads from a byte `offset` or from the last
  `tail_bytes`, and reports `size_bytes` and whether the result was
  `truncated`.
- `wait` blocks until the job reaches a terminal status or `timeout_s` elapses,
  returning `timed_out` to signal the latter.
- Jobs are in-memory only. They live as long as the opencode session and stop
  with the MCP server. There is no disk persistence or restart recovery.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.

## Install

```sh
bun install
```

## Test

```sh
bun test
bunx tsc --noEmit
```

## Configure opencode

Add the following to your `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "bgj": {
      "type": "local",
      "command": ["bun", "run", "/path/to/opencode-bgj/src/index.ts"]
    }
  }
}
```

An example is provided in `opencode.example.json`. After restarting opencode,
the tools appear as `bgj_start`, `bgj_list`, and so on.

## Project layout

```
src/jobs.ts        JobManager: spawn, track, capture output, stop, wait
src/tools.ts       Tool schemas and the pure dispatch function
src/index.ts       MCP server wiring and the stdio transport
test/jobs.test.ts  JobManager unit tests
test/tools.test.ts Tool dispatch unit tests
```

## Why not opencode's built-in BackgroundJob?

opencode ships an internal `@opencode/BackgroundJob` service for background
subagents. It is process-local and not exposed over MCP. This server is
standalone and usable by any MCP client.
