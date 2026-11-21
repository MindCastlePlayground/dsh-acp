# dsh-acp

Mount any [ACP](https://agentclientprotocol.com) (Agent Client Protocol) agent — opencode, Claude
Code, Gemini CLI, Goose, or your own — as a selectable model route inside DeepSeek Harness, and hand
it DSH's tools through MCP.

ACP is a JSON-RPC protocol in which the **agent** owns the conversation and the client only sends
prompts. DSH instead expects a provider adapter that receives a whole transcript and streams token
deltas. This plugin reconciles the two, supervises the agent process, and translates every ACP
`session/update` into DSH's `StreamChunk` vocabulary.

It is deliberately agent-agnostic: no agent name, model id, config option id, or transport appears in
the code paths. Everything agent-specific is either configured or discovered from the handshake.

```
                  ┌──────────────── DSH Host ─────────────────┐
DSH agent loop ──►│ ctx.llm ──► dsh-acp adapter ──► JSON-RPC  │──► any ACP agent
                  │    ▲              │                       │
                  │    └ StreamChunks─┘                       │
                  │ ctx.tools ◄── MCP server ◄── tools/call ──┼──► (the agent calls
                  │ ctx.skills                                │     DSH tools)
                  └───────────────────────────────────────────┘
```

## Install

The package is a self-contained ESM bundle with no `@deepseek-ai/*` imports, so it installs into any
profile:

```
plugin_manager install_bundle  <path-to-this-directory>
```

Then mount a row. `cordis.patch.yml` in this package is a ready-made one; edit `command` for your
agent:

```yaml
- insert:
    - id: acp
      name: '@local/dsh-acp'
      config:
        agents:
          opencode:
            command: opencode
            args: [acp]
            provider:
              route: acp-opencode
```

After a Host restart, `ctx.llm.listProviders()` reports `acp-opencode`, the model picker lists the
agent's models, and the plugin's own tools (`acp_status`, `acp_mcp`, …) become available.

## Supported agents

ACP is a protocol, not a vendor. Any agent that speaks ACP v1 over stdio works; these are known
launchers, and the exact flags are worth confirming with `<command> --help` because projects rename
them:

| Agent | `command` | `args` | Notes |
| --- | --- | --- | --- |
| opencode | `opencode` | `[acp]` | Verified against 2.2.7. Advertises HTTP MCP, a model picker, effort and mode options. |
| Claude Code | `claude-code-acp` | `[]` | Via `@zed-industries/claude-code-acp`. No model picker: the route falls back to one model id. |
| Gemini CLI | `gemini` | `[--experimental-acp]` | |
| Qwen Code | `qwen` | `[--experimental-acp]` | Fork of Gemini CLI with the same ACP surface. |
| Goose | `goose` | `[acp]` | |
| Codex CLI | `codex-acp` | `[]` | Via `@zed-industries/codex-acp`. |
| Kiro CLI | `kiro-cli` | `[acp]` | May require `kiro-cli login` first. |

Agents that keep credentials in their own store (opencode, Claude Code) need no `env`. Agents that
take an API key from the environment get it from `env`, and agents that expose ACP `authenticate`
can be logged in with `auth.methodId` or `acp_control`.

Nothing here is opencode-specific: if an agent has a model picker, every value is listed; if it has
none, one synthetic id is registered so the route stays addressable; if it advertises HTTP MCP, that
is used; otherwise the stdio shim is.

## Configuration

`agents` accepts a map keyed by agent id, or a list of objects carrying `id`.

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | — | Agent launcher. A bare name is resolved against `PATH` **and** `PATHEXT`, so `opencode` finds `opencode.cmd` on Windows. |
| `args` | `['acp']` | Arguments passed to the launcher. |
| `shell` | `auto` | `auto` uses a shell only for Windows `.cmd`/`.bat` wrappers; `never`/`always` force the choice. |
| `cwd` | DSH working directory | Directory the agent runs in. The agent's file tools write here, and MCP resource reads are confined to it. |
| `env` | `{}` | Extra environment; `${env:NAME}` expands from the Host, `null` deletes a variable. |
| `enabled` | `true` | Set `false` to keep a row in the composition without spawning anything. |
| `autoStart` | `true` | Start the agent when the plugin activates. |
| `startupTimeoutMs` | `30000` | Ceiling for spawn + handshake + `session/new`. |
| `turnTimeoutMs` | `900000` | Ceiling for one `session/prompt`. |
| `protocolVersion` | `1` | ACP version sent in `initialize`. |
| `clientInfo` | `dsh-acp` | `{name,title,version}` reported to the agent. |

### `auth`

| Field | Default | Meaning |
| --- | --- | --- |
| `methodId` | — | ACP login method to run after the handshake. |
| `auto` | `true` | Run it automatically on start; `false` leaves it to `acp_control`. |

An agent that reports `authMethods` but keeps its own credentials (opencode) needs nothing here.

### `provider`

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the DSH model route. `false` makes the agent tool-only. |
| `route` | `acp-<id>` | Provider id used in `provider:` fields and the model picker. |
| `displayName` | `<displayName> (ACP)` | Name shown for the route. |
| `models` | `[]` | Explicit catalog. When empty, models are discovered from the agent. |
| `discoverModels` | `models.length === 0` | Read the catalog from a probe session's `configOptions`. |
| `modelCacheMs` | `300000` | How long a discovered catalog is trusted. `listModels` runs on every picker render. |
| `defaultModel` | first catalog entry | Model `acp_selftest` uses when none is named. |
| `contextWindow` | `200000` | Advertised context window for discovered models. |
| `maxTokens` | `32768` | Advertised output cap for discovered models. |
| `fallbackModel` | `default` | Id registered when the agent has no model picker. Never sent to the agent. |
| `fallbackModelName` | `<agent> (agent default)` | Display name for that id. |

Each `models[]` entry is `{id, name?, contextWindow?, maxTokens?}`.

### `session`

ACP exposes model, reasoning effort and mode as **session config options**, not per-request
parameters.

| Field | Meaning |
| --- | --- |
| `modelOptionId` | Force a model, overriding the route's selected model. |
| `effortOptionId` | Value for the `thought_level` option (`low`, `high`, `max`, `default` in opencode). |
| `modeValue` | Value for the `mode` option (`build`, `plan` in opencode). |
| `options` | Escape hatch: `{configId: value}` applied verbatim, for an agent whose option ids this plugin does not recognise. Applied last, so it wins. |
| `reuse` | `reuse` (default) keeps one ACP session per DSH session while the transcript prefix is stable; `fresh` opens one per call. |

Options are matched by `category`, falling back to the configured `*OptionId`, so a different agent
rearranging its option ids keeps working. The DSH-selected model id is applied automatically when it
appears in the agent's model options; an unknown id is skipped and logged rather than failing the
turn.

### `mcp` — give the agent DSH's tools

ACP has exactly one way to hand tools to an agent: an MCP server listed in `session/new`. This plugin
runs one, scoped to the DSH session that owns the model call.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Inject the MCP server. `false` restores a pure chat route. |
| `name` | `dsh` | Server name the agent sees. |
| `transport` | `auto` | `auto` uses HTTP when the agent advertises `mcpCapabilities.http`, else the stdio shim. |
| `tools.include` | `[]` | Tool-name masks to include; empty means every tool the agent's scope can see. |
| `tools.exclude` | `['acp_*']` | Masks to remove. Always applied last, and `acp_*` is re-applied even if you clear it. |
| `prompts` | `true` | Expose DSH skills as MCP prompts. Prompts are a human surface, so they follow `userInvocable`. |
| `resources` | `true` | Expose skills, a session summary, and read-only workspace files as MCP resources. |
| `skills` | `true` | Expose the generated skill tools when the profile has skills but no `skill` tool. |
| `skillToolName` | `dsh_skills` | Name of the catalog/load tool. |
| `skillReadToolName` | `dsh_skill_read` | Name of the tool that reads `SKILL.md` or a sibling reference file. |
| `skillMaxBytes` | `120000` | Per-call budget for skill text (catalog or body), separate from `maxResultBytes`. |
| `timeoutMs` | `600000` | Ceiling for one tool call. |
| `maxResultBytes` | `262144` | Per-call result budget; longer output is truncated with a marker. |

What the agent receives:

- **`tools`** — every tool visible to the owning DSH agent, which means every Cordis plugin's tools
  in this profile. Calls run through `ctx.tools.execute`, so DSH's approval policy, sandbox, guards,
  and result pipeline still apply. `acp_*` is never injected, whatever the config says: an agent that
  can restart or reconfigure the process serving its own turn is a deadlock, not a capability.
- **`dsh_skills` / `dsh_skill_read`** — the skill catalog, the full instructions of one skill, and any
  file beside its `SKILL.md` (`reference/schema.md`, scripts). Both follow `modelInvocable`: a skill
  flagged `disable-model-invocation` is neither listed nor loadable by name. Bodies are line-bounded
  (`maxLines`, default 400, ceiling 2000) and the `<skill_resources>` section names the skill's own
  directory, which is how an agent reaches its sibling files — they live outside the session cwd.
- **`prompts`** — DSH skills, one prompt each, rendering the skill's instructions under the same
  `<skill_content>` wrapper DSH models see.
- **`resources`** — `dsh://skill/<name>`, `dsh://session` (a JSON summary), and the
  `dsh://file/{+path}` template for UTF-8 files under the session directory.

Every path crossing this bridge — workspace files, skill reference files, and the agent's own
`fs/read_text_file` — is canonicalized with `realpath` and re-checked for containment, so a symlink
pointing out of the tree is refused rather than followed.

Every session gets its own token and endpoint; the token is the only credential, and passing it in an
`Authorization` header (HTTP) or the shim's environment (stdio) is required. The listener binds to
`127.0.0.1` on an OS-assigned port, lazily, on the first session that needs it.

### `restart`

Exponential backoff with a bounded budget, so a broken agent cannot spin forever.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Restart after an unexpected exit. |
| `maxRestarts` | `5` | Attempts per window before the agent is left `failed`. |
| `windowMs` | `3600000` | Budget window. |
| `initialDelayMs` / `maxDelayMs` | `1000` / `15000` | Backoff bounds. |

A deliberate `acp_control stop`, a failed handshake, and an exhausted budget do **not** arm a
restart — only an agent that dies while running does.

Every spawned agent is also registered with a synchronous exit hook, so a crashed *host* does not
orphan an agent (and the server it booted) holding a port and burning CPU. That hook only runs on
process exit; a clean shutdown still goes through the ordinary `killTree` path.

### `permission`, `prompt`, `stream`, `logs`

| Field | Default | Meaning |
| --- | --- | --- |
| `permission.policy` | `allow` | `allow` grants `session/request_permission`; `deny` refuses and lets the agent continue. |
| `permission.allowReadOnly` | `true` | Under `deny`, still allow `read`/`search`/`think`/`fetch`/`switch_mode` tool kinds. |
| `prompt.includeToolActivity` | `true` | Include DSH tool calls and results when rendering a transcript for a fresh ACP session. |
| `prompt.maxTranscriptChars` | `400000` | Prompt budget; older turns degrade to an omission marker. |
| `stream.includeThoughts` | `true` | Map `agent_thought_chunk` onto DSH reasoning blocks. |
| `stream.includeToolActivity` | `false` | Inline the agent's own tool activity as text. Off by default: it is the agent's work, not this turn's answer. |
| `logs.maxLines` / `logs.maxBytes` | `2000` / `1048576` | In-memory ring buffer bounds. |
| `logs.file` | — | Optional JSONL trace file (appended, never rotated). |

`permission` governs the agent's *own* tool calls, which happen inside the agent process. MCP tool
calls are the other direction — DSH decides those, through its own approval and sandbox policy.
Decisions are routed per ACP session, so two live sessions never share (or steal) a handler, and every
decision is traced with its `sessionId`, tool `kind`, the option `kind` actually granted, and the full
list offered. A grant that is not `allow_once` is also logged as a warning: a session-long grant is not
a one-shot approval.

`fs/read_text_file` and `fs/write_text_file` are confined to the **requesting session's** cwd, not the
agent's most recent one — one process serves many sessions, so a shared boundary would write into the
wrong directory. Both ends are canonicalized, so a symlink or junction pointing out of the tree is
refused rather than followed.

## Tools

| Tool | Purpose |
| --- | --- |
| `acp_status` | State, PID, restarts, protocol version, capabilities, auth methods, MCP settings, live session count, last error. |
| `acp_control` | `start`, `stop`, `restart`, `authenticate` one agent. |
| `acp_logs` | Bounded, redacted JSON-RPC frames, stderr and traces — filtered by stream or substring. |
| `acp_selftest` | Run one real turn through `ctx.llm` and report text, reasoning, stop reason, usage, latency. |
| `acp_mcp` | What the agent can currently call: tool names, skills, resources. |

## How a turn works

1. **Session reuse.** DSH rebuilds the whole transcript on every call, but an ACP agent replays its
   own. The plugin records exactly which transcript prefix an agent has seen. If the new call extends
   that prefix, it prompts the existing session with only the new user turn; otherwise (edited
   history, regeneration, model switch) it retires the session and sends the transcript as one
   prompt.
2. **Streaming.** `session/prompt` returns only a stop reason, so content arrives as `session/update`
   notifications. The adapter pumps those notifications while the request is in flight, mapping them
   to blocks.
3. **Block shape.** `agent_thought_chunk` opens a reasoning block; `agent_message_chunk` opens a text
   block and closes reasoning first. A new thought after prose opens a second reasoning block,
   because DSH closes blocks by index and never reopens one.
4. **Termination.** Every stream ends in exactly one `finish` chunk. `end_turn → stop`,
   `max_tokens → max-tokens`, `cancelled → aborted`, `refusal → stop`. A JSON-RPC error becomes
   `{kind: 'error', failure}` carrying the agent's code.
5. **Cancellation.** Aborting the DSH stream sends `session/cancel` but keeps the wire request
   pending, so the agent's `cancelled` answer still arrives and the session stays consistent. An agent
   that ignores the cancel for 15 s has its turn abandoned and its session retired, rather than being
   left to run into `turnTimeoutMs`.
6. **No retry.** `providerRetryPolicy` states `maxRetries: 0` explicitly. DSH's default is five
   retries for an HTTP endpoint; an ACP turn is a conversation, so a retry would replay a message the
   agent already answered. Recovery belongs to the agent's restart budget instead.

Usage is normalized to DSH's disjoint counts: ACP folds cache reads into `inputTokens`, so the
adapter subtracts `cachedReadTokens` to keep `input + cacheRead + output` consistent. ACP's
`usage_update` (context pressure, cost) is traced, not reported as usage — the authoritative totals
arrive with the prompt result.

## Limits

- **Per-call sampling controls are ignored.** `temperature`, `maxTokens` and `stop` have no ACP
  equivalent; use the agent's own configuration or `session.options`.
- **No image forwarding in either direction.** DSH attachments become placeholders in the transcript,
  and tool results carrying images are described rather than transferred.
- **One turn at a time per session.** That matches how agents work: a second concurrent call on the
  same DSH session waits for the first to settle rather than putting two prompts on one ACP session,
  which would interleave two histories into one.
- **MCP tool calls are not written to the DSH transcript.** They appear in `acp_logs`; the DSH session
  records the model's answer, not the agent's internal tool use.
- **Agent-specific config option ids are guesses when unrecognised.** `session.options` is the escape
  hatch.

See [PROTOCOL.md](./PROTOCOL.md) for the exact wire behaviour, including the MCP injection handshake,
and the [stream mapping](./PROTOCOL.md#stream-mapping) it produces.

## Development

```
node --test test/*.test.mjs
```

The suite runs a scripted ACP agent (`test/fake-agent.mjs`) as a real child process and a real MCP
gateway, so it covers spawn quoting, the handshake, notification interleaving, cancellation,
permission decisions, restart, token authentication, the stdio shim, session-scoped tool binding, and
the chunk protocol as DSH's assembler would consume it.

## License

MIT
