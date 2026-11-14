# dsh-acp

Mount an [ACP](https://agentclientprotocol.com) (Agent Client Protocol) agent — `opencode`, or any other
ACP implementation — as a selectable model route inside DeepSeek Harness.

ACP is a JSON-RPC protocol in which the **agent** owns the conversation and the client only sends
prompts. DSH instead expects a provider adapter that receives a whole transcript and streams
token deltas. This plugin reconciles the two, supervises the agent process, and translates every
ACP `session/update` into DSH's `StreamChunk` vocabulary.

```
DSH agent loop ──► ctx.llm ──► dsh-acp adapter ──► JSON-RPC/stdio ──► opencode acp
                     ▲                │
                     └── StreamChunks ┴── session/update notifications
```

## Install

The package is a self-contained ESM bundle with no `@deepseek-ai/*` imports, so it installs into any
profile:

```
plugin_manager install_bundle  <path-to-this-directory>
```

Then mount it. `cordis.patch.yml` in this package is the ready-made row; edit `command` to whatever
launcher you have installed:

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
agent's models, and the tools below become available.

## Configuration

`agents` accepts a map keyed by agent id, or a list of objects carrying `id`.

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | — | Agent launcher. A bare name is resolved against `PATH` **and** `PATHEXT`, so `opencode` finds `opencode.cmd` on Windows. |
| `args` | `['acp']` | Arguments passed to the launcher. |
| `shell` | `auto` | `auto` uses a shell only for Windows `.cmd`/`.bat` wrappers; `never`/`always` force the choice. |
| `cwd` | DSH working directory | Directory the agent runs in. The agent's file tools write here. |
| `env` | `{}` | Extra environment; `${env:NAME}` expands from the Host, `null` deletes a variable. |
| `enabled` | `true` | Set `false` to keep a row in the composition without spawning anything. |
| `autoStart` | `true` | Start the agent when the plugin activates. |
| `startupTimeoutMs` | `30000` | Ceiling for spawn + handshake + `session/new`. |
| `turnTimeoutMs` | `900000` | Ceiling for one `session/prompt`. |
| `protocolVersion` | `1` | ACP version sent in `initialize`. |
| `clientInfo` | `dsh-acp` | `{name,title,version}` reported to the agent. |

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

Each `models[]` entry is `{id, name?, contextWindow?, maxTokens?}`.

### `session`

ACP exposes model, reasoning effort and mode as **session config options**, not per-request
parameters.

| Field | Meaning |
| --- | --- |
| `modelOptionId` | Force a model, overriding the route's selected model. |
| `effortOptionId` | Value for the `thought_level` option (`low`, `high`, `max`, `default` in opencode). |
| `modeValue` | Value for the `mode` option (`build`, `plan` in opencode). |

The DSH-selected model id is applied automatically when it appears in the agent's model options; an
unknown id is skipped and logged rather than failing the turn.

### `permission`

| Field | Default | Meaning |
| --- | --- | --- |
| `policy` | `allow` | `allow` grants `session/request_permission`; `deny` refuses and lets the agent continue. |
| `allowReadOnly` | `true` | Under `deny`, still allow `read`/`search`/`think`/`fetch` tool kinds. |

Every decision is logged, which is how you audit what an agent did on your behalf.

### `prompt` and `stream`

| Field | Default | Meaning |
| --- | --- | --- |
| `prompt.includeToolActivity` | `true` | Include DSH tool calls and results when rendering a transcript for a fresh ACP session. |
| `prompt.maxTranscriptChars` | `400000` | Prompt budget; older turns degrade to an omission marker. |
| `stream.includeThoughts` | `true` | Map `agent_thought_chunk` onto DSH reasoning blocks. |
| `stream.includeToolActivity` | `false` | Inline the agent's own tool activity as text. Off by default: it is the agent's work, not this turn's answer. |

### `logs`

| Field | Default | Meaning |
| --- | --- | --- |
| `maxLines` / `maxBytes` | `2000` / `1048576` | In-memory ring buffer bounds. |
| `file` | — | Optional JSONL trace file (appended, never rotated). |

Log entries are redacted for bearer tokens, API keys and credential-looking assignments.

## Tools

| Tool | Purpose |
| --- | --- |
| `acp_status` | State, PID, restarts, protocol version, capabilities, auth methods, live session count, last error. |
| `acp_control` | `start`, `stop`, `restart` one agent. |
| `acp_logs` | Bounded, redacted JSON-RPC frames, stderr and traces — filtered by stream or substring. |
| `acp_selftest` | Run one real turn through `ctx.llm` and report text, reasoning, stop reason, usage, latency. |

## How a turn works

1. **Session reuse.** DSH rebuilds the whole transcript on every call, but an ACP agent replays its
   own. The plugin records exactly which transcript prefix an agent has seen. If the new call
   extends that prefix, it prompts the existing session with only the new user turn; otherwise
   (edited history, regeneration, model switch) it retires the session and sends the transcript as
   one prompt.
2. **Streaming.** `session/prompt` returns only a stop reason, so content arrives as
   `session/update` notifications. The adapter pumps those notifications while the request is in
   flight, mapping them to blocks.
3. **Block shape.** `agent_thought_chunk` opens a reasoning block; `agent_message_chunk` opens a
   text block and closes reasoning first. A new thought after prose opens a second reasoning block,
   because DSH closes blocks by index and never reopens one.
4. **Termination.** Every stream ends in exactly one `finish` chunk. `end_turn → stop`,
   `max_tokens → max-tokens`, `cancelled → aborted`, `refusal → stop`. A JSON-RPC error becomes
   `{kind: 'error', failure}` carrying the agent's code.
5. **Cancellation.** Aborting the DSH stream sends `session/cancel` but keeps the wire request
   pending, so the agent's `cancelled` answer still arrives and the session stays consistent.

Usage is normalized to DSH's disjoint counts: ACP folds cache reads into `inputTokens`, so the
adapter subtracts `cachedReadTokens` to keep `input + cacheRead + output` consistent. ACP's
`usage_update` (context pressure, cost) is traced, not reported as usage — the authoritative totals
arrive with the prompt result.

## Limits

- **No DSH tools.** ACP agents run their own tool loop internally; DSH tool definitions are not
  forwarded. A route backed by this plugin answers, reads and writes files through the agent's own
  capabilities, and its permission policy decides what it may touch.
- **No per-call sampling controls.** `temperature`, `maxTokens` and `stop` are ignored: ACP has no
  per-turn field for them. Use the agent's own config or `session` options.
- **No image input forwarding.** ACP can carry images, but DSH attachments are not transmitted;
  they appear as placeholders in the transcript.
- **Serialized per session.** One ACP session serves one turn at a time, matching how agents work.

See [PROTOCOL.md](./PROTOCOL.md) for the exact wire behaviour this plugin relies on and the
[stream mapping](./PROTOCOL.md#stream-mapping) it produces.

## Development

```
node --test test/*.test.mjs
```

The suite runs a scripted ACP agent (`test/fake-agent.mjs`) as a real child process, so it covers
spawn quoting, the handshake, notification interleaving, cancellation, permission decisions,
restart, and the chunk protocol as DSH's assembler would consume it.

## License

MIT
