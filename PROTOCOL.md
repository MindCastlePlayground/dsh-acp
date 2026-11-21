# ACP wire behaviour relied on by dsh-acp

Everything here was observed against `opencode acp` (OpenCode 2.2.7), and where it matters against
the ACP schema. It is implemented in `lib/rpc.js`, `lib/agent.js`, `lib/adapter.js` and the `lib/mcp*`
modules. It documents what the bridge depends on, so a future agent change can be diagnosed against
concrete expectations.

## Transport

JSON-RPC 2.0 over the child's stdio, one JSON object per line, `\n` terminated, no framing
headers. Messages must not contain embedded newlines. The client writes requests and
notifications to stdin and correlates responses by `id`; the agent interleaves
`session/update` notifications with its own requests.

Malformed stdout lines are kept in the log as diagnostics instead of killing the connection:
agents commonly print a startup banner before the handshake.

## Handshake

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
     "protocolVersion":1,
     "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false},
     "clientInfo":{"name":"dsh-acp","title":"DSH ACP Bridge","version":"0.1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{
     "protocolVersion":1,
     "agentCapabilities":{"loadSession":true,
       "promptCapabilities":{"image":true,"embeddedContext":true},
       "mcpCapabilities":{"http":true,"sse":false},
       "sessionCapabilities":{"close":true,"delete":true,"fork":true,"list":true,"resume":true}},
     "authMethods":[{"id":"opencode-login","name":"Login with opencode","description":"Run `opencode auth login` in the terminal"}],
     "agentInfo":{"name":"OpenCode","version":"2.2.7"}}}
```

`authMethods` being non-empty does **not** block the bridge: opencode reports a login method even
when it is already authenticated.

## Sessions

```json
→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"<absolute path>","mcpServers":[]}}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses_…","configOptions":[…]}}
```

`cwd` must be absolute. `configOptions` carries the agent's selectable options; opencode reports
three:

| `id` | `category` | `type` | Notes |
| --- | --- | --- | --- |
| `model` | `model` | `select` | 81 values in 2.2.7; `currentValue` is a real model id such as `opencode-go/deepseek-v4.1-flash`. |
| `effort` | `thought_level` | `select` | `low`, `high`, `max`, `default`. |
| `mode` | `mode` | `select` | `build`, `plan`. |

Options are matched by `category`, never by id, so an agent that renames `effort` to `reasoning` still
gets its value set. Note the field name drift: `model` uses `currentValue`, `effort` and `mode` used
`current` in some builds. The adapter reads both.

An agent with no model option at all (Claude Code, Codex) returns a short or empty `configOptions`.
That is not an error: the route registers one synthetic model id and skips `session/set_config_option`
entirely.

```json
→ {"jsonrpc":"2.0","id":3,"method":"session/set_config_option",
   "params":{"sessionId":"ses_…","configId":"model","value":"opencode/deepseek-v4.1-flash-free"}}
← {"jsonrpc":"2.0","id":3,"result":{"configOptions":[…]}}
```

`session/close` returns `{}` and is best-effort; the process tree is killed regardless.

## Authentication

```json
→ {"jsonrpc":"2.0","id":5,"method":"authenticate","params":{"methodId":"opencode-login"}}
← {"jsonrpc":"2.0","id":5,"result":{}}
```

Only sent when `auth.methodId` is configured (and `auth.auto`, or via `acp_control`). It is safe to
call for an agent that is already logged in: opencode reports `opencode-login` unconditionally and
answers.

## MCP injection

`session/new` is the only way to give an ACP agent tools. `mcpServers` is a list of server
descriptors in one of two shapes; both were verified against opencode 2.2.7, driven by this plugin.

```json
// HTTP: sent when the agent advertises agentCapabilities.mcpCapabilities.http === true
{"type":"http","name":"dsh",
 "url":"http://127.0.0.1:53370/mcp/<token>",
 "headers":[{"name":"Authorization","value":"Bearer <token>"}]}

// stdio: the baseline every ACP agent supports
{"name":"dsh",
 "command":"C:\\nvm4w\\nodejs\\node.exe",
 "args":["<package>/lib/mcp-stdio.js","http://127.0.0.1:53433/mcp/<token>"],
 "env":[{"name":"DSH_ACP_MCP_URL","value":"http://127.0.0.1:53433/mcp/<token>"},
        {"name":"DSH_ACP_MCP_TOKEN","value":"<token>"}]}
```

An SSE descriptor (`{"type":"sse","url":…}`) is never sent: opencode reports `sse: false`, and the
HTTP shape covers the agents that implement either.

The agent connects on its own schedule, often a few seconds after `session/new` returns:

```json
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
← {"jsonrpc":"2.0","method":"notifications/initialized"}   // relayed, never answered
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
     "protocolVersion":"2025-11-25","clientInfo":{"name":"opencode","version":"2.2.7"},
     "capabilities":{"elicitation":{"form":{},"url":{}},"roots":{}}}}
← {"jsonrpc":"2.0","id":1,"result":{
     "protocolVersion":"2025-11-25",
     "capabilities":{"tools":{"listChanged":false},"prompts":{"listChanged":false},
                     "resources":{"subscribe":false,"listChanged":false,"templates":true}},
     "serverInfo":{"name":"dsh-opencode","title":"DeepSeek Harness (OpenCode)","version":"0.2.0"}}}
```

The server answers with the client's revision when it can speak it. `2025-11-25`, `2025-06-18`,
`2025-03-26` and `2024-11-05` are accepted; the tools/prompts/resources surface is identical across
them, and unknown methods return `-32601` rather than pretending.

Methods served: `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`,
`resources/list`, `resources/templates/list`, `resources/read`. Notifications are never answered.
`GET` returns 405 — there is no server-initiated stream and no resumable session — and a
notification-only `POST` returns `202` with an empty body.

Authentication is by capability token only: the token is in the URL path, and it must also arrive as
`Authorization: Bearer <token>` (HTTP) or in `DSH_ACP_MCP_TOKEN` (stdio). A token is minted per ACP
session, withdrawn when that session retires, and the listener binds to loopback on an OS-assigned
port only after the first session needs it.

### What a `tools/call` does

```json
→ {"jsonrpc":"2.0","id":2,"method":"tools/call",
   "params":{"name":"bash","arguments":{"command":"pwd"}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"…"}]}}
```

The call executes through `ctx.tools.execute` with the DSH **Agent that owns the model call**, looked
up from the `sessionId` DSH passed to the adapter. That is what makes an agent's tool use respect the
session's workspace, approvals, sandbox policy and per-agent tool restrictions, instead of running
with a global view.

A failing tool returns `{"content":[…],"isError":true}` — never a JSON-RPC error, because the model
has to read the failure to recover. Only protocol mistakes (unknown method, missing `name`) become
JSON-RPC errors.

## Prompts

```json
→ {"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{
     "sessionId":"ses_…","prompt":[{"type":"text","text":"…"}]}}
← {"jsonrpc":"2.0","id":4,"result":{
     "stopReason":"end_turn",
     "usage":{"inputTokens":14736,"outputTokens":97,"totalTokens":29608,
              "thoughtTokens":55,"cachedReadTokens":14720}}}
```

Observed `stopReason` values: `end_turn`, `cancelled`, `max_tokens`. `refusal` appears in the ACP
specification and is mapped defensively.

The result carries **no content**. Everything the user sees arrives as notifications:

| `sessionUpdate` | Payload | Bridge handling |
| --- | --- | --- |
| `agent_message_chunk` | `{messageId, content:{type:'text',text}}` | Text block; closes reasoning first. |
| `agent_thought_chunk` | `{content:{type:'text',text}}` | Reasoning block. |
| `tool_call` | `{toolCallId,name,title,kind,status,locations,rawInput}` | Traced; inlined only when `stream.includeToolActivity`. |
| `tool_call_update` | `{toolCallId,status,content:[{type:'content',content:{type:'text',text}}]}` | Same. |
| `usage_update` | `{used,size,cost:{amount,currency}}` | Context pressure, not token totals — traced only. |
| `available_commands_update` | `{availableCommands:[…]}` | Traced (`/init`, `/review`, …). |
| `current_mode_update` | `{modeId}` | Traced. |
| `user_message_chunk` | echo of the sent prompt | Traced. |

## Agent → client requests

| Method | Bridge behaviour |
| --- | --- |
| `session/request_permission` | One handler per *process*, routed by `params.sessionId` into a per-session table; an unroutable ask answers `{outcome:'cancelled'}` instead of leaving the agent waiting. Answered from `permission.policy`; chooses `allow_once` then `allow_always`, or `reject_once` then `reject_always`, or `{outcome:'cancelled'}` when no offered option fits. |
| `fs/read_text_file` | Reads the requested file if it resolves inside the **requesting session's** `cwd`; honours `line`/`limit` (either field alone is enough). |
| `fs/write_text_file` | Writes inside the requesting session's `cwd`, creating parent directories. |
| `fs/*` outside `cwd` | Refused with `ACP_PATH_ESCAPE` rather than touching an unexpected path. |
| `terminal/*` | Not advertised (`terminal: false`), so a conforming agent will not ask. |

Path confinement is per session, not per agent: one process holds many sessions, so a shared boundary
would apply the newest session's cwd to every other one and write into the wrong directory. An fs
request whose `sessionId` is unknown falls back to the most recently established cwd, because some
agents omit the field. Both the base and the target are canonicalized with `realpath` before the
`path.relative(base, resolved)` test, so a symlink or junction inside the tree that points out of it is
refused; a write target that does not exist yet is canonicalized through its deepest existing ancestor.
The `..` test compares whole segments, so `..draft.md` is a legal child name.

Every agent→client request is bounded: a handler that has not answered within 5 minutes is abandoned
with `ACP_INBOUND_TIMEOUT` and traced, so a future asynchronous decision cannot wedge a tool call.

## Cancellation

```json
→ {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"ses_…"}}
← {"jsonrpc":"2.0","id":4,"result":{"stopReason":"cancelled"}}
```

The bridge sends `session/cancel` on abort but **keeps the prompt request pending**: the agent's
`cancelled` result is what keeps session state consistent. The stream then ends with
`{kind:'aborted'}`, never a silent stop.

`session/cancel` is a notification, so nothing forces the agent to honour it. A 15 s fallback closes
the update queue and abandons the turn — the session is retired, because an agent that ignored a
cancel is in an unknown state. Without the fallback an ignored cancel would hold the turn, and its
session slot, until `turnTimeoutMs` (900 s by default).

## Errors

A prompt for an unknown session returns a JSON-RPC error:

```json
{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Invalid params: session not found: ses_does_not_exist"}}
```

The adapter surfaces this as `{kind:'error', failure:{code:'ACP_-32602', message:'…'}}` — the
numeric JSON-RPC code is preserved so a consumer can route on it.

opencode reports exhausted credit as `-32603` with an "Insufficient balance" message; that is a
billing condition on the agent side, not a bridge failure, and the message is passed through
verbatim.

## Stream mapping

The chunk protocol DSH assembles, in order:

```
block-start {index, blockType: 'text' | 'reasoning'}
text-delta  {index, text}
reasoning-delta {index, text}
block-end   {index, block: {type, text}}   # text must equal the concatenated deltas
usage       {usage: {inputTokens, outputTokens, totalTokens, cacheReadTokens?, reasoningTokens?}}
finish      {reason: {kind: 'stop'|'max-tokens'|'aborted'|'error', failure?}}
```

Rules the mapper enforces:

- Blocks are opened lazily and closed in ascending index order before `usage`/`finish`.
- A reasoning block closes when prose starts; prose closes when thinking resumes. A block index is
  never reopened.
- `block-end.text` always equals the accumulated deltas of that block.
- Exactly one terminal `finish` chunk, including on abort and on failure.
- `inputTokens` excludes cache reads.

## Sequencing notes

- `initialize` must complete before `session/new`; `session/new` before `session/prompt`.
- The transport choice for MCP reads `agentCapabilities`, so the handshake must have finished before
  the descriptors are built. The bridge starts the agent first for exactly this reason; otherwise a
  first call would always fall back to stdio.
- Only one prompt per session is in flight at a time, and this is enforced rather than assumed: a
  second concurrent call on the same DSH session awaits the first turn's slot, because two prompts on
  one ACP session interleave two histories. The slot is released in the turn's `finally`, including on
  error and cancellation.
- Conversation continuity across prompts on one session is real: a second prompt referring to the
  first is answered from context, which is what makes incremental prompting safe.
- The agent may connect to the MCP endpoint at any point after `session/new` — before, during, or
  seconds after the first prompt. The token is therefore registered before `session/new` is sent and
  the session context is filled in when it returns.
