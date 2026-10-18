# opencode-bgj

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that gives the opencode agent tools to launch and supervise long-running
shell jobs in the background, without blocking its turn.

It has three parts:

- **Runtime jobs**: start a shell command now and monitor it while it runs.
- **Persistent job definitions**: save a command with pre-set metadata to a
  central database, then run it again later by name.
- **Completion notifications**: when a job finishes, a companion plugin reports
  the result back to the agent, waking an idle session.

The server is named `bgj`, so opencode exposes every tool to the model prefixed
with `bgj_`.

## Features

- Start any shell command and get a job id back immediately.
- Read captured stdout and stderr while the job runs, by byte offset or tail.
- Wait for a job to finish, or block for a bounded number of seconds.
- Stop a job and its entire child process tree (SIGTERM, then SIGKILL after a
  five second grace period).
- Kill a job automatically after an optional timeout.
- Save reusable job definitions with pre-set cwd, env, shell, timeout, and
  arbitrary JSON metadata.
- Full CRUD over definitions plus `run_job` to invoke one by name.
- `run_detached` to run a command that outlives the session, with its output and
  status kept on disk so it stays inspectable.
- Report finished jobs back to the agent through a companion plugin.
- Jobs run detached in their own process group.

## Tools

### Runtime jobs

| Tool | Input | Output |
|---|---|---|
| `start` | `{ command, cwd?, env?, shell?, timeout_ms?, notify? }` | job info |
| `run_detached` | `{ command, cwd?, env?, shell? }` | job info, `detached: true`, `log` |
| `list` | `{ active_only? }` | `{ jobs: [...] }` (shell, detached, and session entries) |
| `status` | `{ job_id?, session_id? }` | job info, or session status |
| `output` | `{ job_id?, session_id?, tail_bytes?, offset? }` | `{ text, size_bytes, truncated }` |
| `stop` | `{ job_id?, session_id?, signal? }` | job info, or `{ session_id, session, aborted }` |
| `wait` | `{ job_id?, session_id?, timeout_s? }` | `{ job, timed_out }` or `{ session_id, ..., timed_out }` |

`session_id` names an opencode session, for example the task id the `task` tool
reports for a background subagent. `output` with a `session_id` returns the
latest assistant message text, whether the session is still running, and its
message count; `status` reports just the running flag and message count; `wait`
polls until the session goes idle; `stop` aborts it (which cancels its turn).
`list` includes the directory's child sessions (background subagents) alongside
shell and detached jobs. Each tool takes exactly one of `job_id` or
`session_id`. Sessions need the `bgj-notify` plugin: the MCP server runs in a
separate process and cannot read or control a session itself, so it files the
request in the shared database and the plugin, which runs inside opencode,
answers it. Without the plugin a `session_id` call returns an error telling you
to install it.

`output` with a `job_id` reads a shell job's merged stdout and stderr buffer,
sliced by `tail_bytes` or `offset`.

`run_detached` starts a command fully detached in its own session so it keeps
running after opencode exits, and it never sends a completion notification:
fire-and-forget. Its merged stdout and stderr go to a per-job log file and its
exit status is kept on disk, so `status`, `output`, and `stop` still work on it
later, even in a new session. `list` includes detached jobs, flagged
`detached: true`, alongside the in-memory ones. Use it for a long download, a
build, or a server you want to survive a restart; use `start` for work you want
to observe and be woken about inside this session. There is no `timeout_ms`:
nothing stays resident to enforce one.

### Persistent job definitions

| Tool | Input | Output |
|---|---|---|
| `create_job` | `{ name, command, cwd?, env?, shell?, timeout_ms?, metadata? }` | definition |
| `list_jobs` | `{}` | `{ jobs: [...] }` |
| `get_job` | `{ job }` | definition |
| `update_job` | `{ job, name?, command?, cwd?, env?, shell?, timeout_ms?, metadata? }` | definition |
| `delete_job` | `{ job }` | `{ deleted, job }` |
| `run_job` | `{ job, notify? }` | job info plus `definition_id` and `definition_name` |

In the definition tools, `job` is either the definition id (`job-xxxxxxxx`) or
its unique `name`. `create_job` stores the command and pre-set metadata; later
`run_job` runs it exactly as a normal background job, using the stored command,
cwd, env, shell, and timeout.

## Persistent storage

Definitions and the completion log live in a single centralized SQLite database
shared by every project and session:

```
~/.local/share/opencode-bgj/jobs.db
```

The directory follows `$XDG_DATA_HOME` when set. Override the full path with the
`OPENCODE_BGJ_DB` environment variable (useful for tests or an alternate
location). The database is opened in WAL mode so concurrent servers do not block
each other. Detached job logs and exit markers live beside it in a `runs/`
directory, overridable with `OPENCODE_BGJ_RUNS`. Runtime jobs are not stored;
only definitions, the completion log, and detached job state are persistent.

## Completion notifications

By default every job reports back when it finishes. Set `notify: false` on
`start` or `run_job` to opt out, which is useful when you plan to call `wait`
inline.

The flow is:

1. When a job reaches a terminal status, the MCP server writes a row to the
   `job_runs` table in the central database, tagged with the instance directory
   that started it.
2. A companion opencode plugin, `plugin/bgj-notify.ts`, polls that table and
   injects each result into the session that started the job as a message, and
   shows a TUI toast. It claims only runs whose directory matches its own, so a
   job started in one project is never delivered to another, and it remembers
   the starting session per job so concurrent sessions each get their own.
   See the caveats below for the fallback.
3. Injecting a message starts a turn, so an idle agent wakes up and can act on
   the result.

This works because opencode's MCP client cannot push messages into a session on
its own. Only a plugin can call `client.session.promptAsync`, the same injection
path opencode uses for background subagents.

### Install the plugin

opencode auto-loads plugins from a directory; no config entry is needed:

```sh
cp plugin/bgj-notify.ts ~/.config/opencode/plugin/bgj-notify.ts
```

Then restart opencode. The plugin is optional: without it, runtime and
definition tools still work, and finished runs simply accumulate in `job_runs`
until pruned on the next server start (runs older than 24 hours are removed).

Caveats:

- The plugin only runs while opencode is running.
- It delivers each finished job to the session that started it: the plugin sees
  the `bgj_start`/`bgj_run_job` result through the `tool.execute.after` hook and
  remembers the job's session, so concurrent sessions in one directory each get
  their own completions. If a run's session is unknown (for example the start
  call was never observed), it falls back to the most recently active session in
  the directory. The mapping lives in memory and is only needed while opencode
  runs, since a runtime job can only finish then.
- The plugin, the server, and any pruner must agree on the database path, so set
  `OPENCODE_BGJ_DB` consistently if you override it.

## Behaviour

- stdout and stderr of a running job share a single buffer capped at 1 MiB. When
  the cap is reached the oldest bytes are dropped, so `output` always returns the
  most recent data. `output` reads from a byte `offset` or from the last
  `tail_bytes`, and reports `size_bytes` and whether the result was `truncated`.
- `wait` blocks until the job reaches a terminal status or `timeout_s` elapses,
  returning `timed_out` to signal the latter.
- Runtime jobs are in-memory only. They live as long as the opencode session and
  stop with the MCP server. Detached jobs are the exception: they keep running
  after the server exits and their output and status persist on disk. Job
  definitions and the completion log persist in the central database.

### Runtime job info

Every runtime job info object contains:

- `job_id`: identifier of the form `bgj-xxxxxxxx`.
- `command`: the command that was run.
- `cwd`: the working directory.
- `pid`: the process id, or `-1` when the spawn failed.
- `status`: one of `running`, `completed`, `failed`, `timed_out`, `killed`.
- `exit_code`: the exit code, or `null` while running.
- `started_at` and `ended_at`: epoch milliseconds.
- `elapsed_ms`: how long the job has been running in milliseconds; once it
  finishes this is its total duration (`ended_at - started_at`), otherwise the
  time so far. Shown by `start`, `status`, `list`, `output`, `wait`,
  `run_job`, and `run_detached`.
- `error`: present only when the process could not be spawned.

A detached job also carries `detached: true` and `log`, the path to its output
file. It can never be `timed_out`, and `killed` means it was stopped on request.

### Job definition info

Every definition object contains `id`, `name`, `command`, `cwd`, `env`, `shell`,
`timeout_ms`, `metadata`, `created_at`, and `updated_at`. Optional fields are
omitted when unset.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer. SQLite support comes from Bun's built-in
  `bun:sqlite`, so there are no extra dependencies.

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

An example is provided in `opencode.example.json`. After restarting opencode, the
tools appear as `bgj_start`, `bgj_run_detached`, `bgj_create_job`, and so on.

## Project layout

```
src/jobs.ts          JobManager: in-memory spawn, track, capture output, stop, wait
src/detached.ts      DetachedManager: sessions that outlive the server, log on disk
src/store.ts         JobStore: centralized SQLite definitions, run log, detached state
src/tools.ts         Tool schemas and the pure dispatch function
src/index.ts         MCP server wiring, stdio transport, run log callback
plugin/bgj-notify.ts opencode plugin that delivers finished runs to the agent
test/jobs.test.ts    JobManager unit tests
test/detached.test.ts DetachedManager unit tests
test/store.test.ts   JobStore CRUD, run log, and persistence tests
test/tools.test.ts   Tool dispatch unit tests
test/plugin.test.ts  Plugin delivery test
```

## Background agents

opencode can run subagents in the background itself, gated behind an
experimental flag. Enable it with the environment variable
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (it is read from the
environment only; there is no `opencode.json` key). The `task` tool then accepts
`background: true`: it returns immediately and injects the subagent's result as
a message when it finishes.

To check on a background subagent before it finishes, call `output`, `status`,
`wait`, or `stop` with its session id, the task id the `task` tool reported.
`output` returns what it has produced so far, `status` polls it, `wait` blocks
until it goes idle, and `stop` aborts it. `list` shows the directory's child
sessions (background subagents) alongside shell jobs. The MCP server runs in a
separate process and cannot read or control a session itself, so it files a
request in the central database and the plugin, which runs inside opencode,
answers it; the tool waits briefly for the answer. Without the plugin, any
`session_id` call returns an error telling you to install it.

## Why not opencode's built-in BackgroundJob?

opencode ships an internal `@opencode/BackgroundJob` service for background
subagents. It is process-local and not exposed over MCP. This server is
standalone and usable by any MCP client, and it ships its own plugin bridge for
notifications.
