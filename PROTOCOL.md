# ACP wire behaviour relied on by dsh-acp

Everything here was observed against `opencode acp` (OpenCode 2.2.7) and is implemented in
`lib/rpc.js`, `lib/agent.js` and `lib/adapter.js`. It documents what the bridge depends on, so a
future agent change can be diagnosed against concrete expectations.

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

Note the field name drift: `model` uses `currentValue`, `effort` and `mode` used `current` in some
builds. The adapter reads both.

```json
→ {"jsonrpc":"2.0","id":3,"method":"session/set_config_option",
   "params":{"sessionId":"ses_…","configId":"model","value":"opencode/deepseek-v4.1-flash-free"}}
← {"jsonrpc":"2.0","id":3,"result":{"configOptions":[…]}}
```

`session/close` returns `{}` and is best-effort; the process tree is killed regardless.

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
| `session/request_permission` | Answered from `permission.policy`; chooses `allow_once`/`allow_always`/`allow_session`, or `reject_once`/`reject_always`, or `{outcome:'cancelled'}` when no offered option fits. |
| `fs/read_text_file` | Reads the requested file if it resolves inside the agent's `cwd`; honours `line`/`limit`. |
| `fs/write_text_file` | Writes inside the agent's `cwd`, creating parent directories. |
| `fs/*` outside `cwd` | Refused with `ACP_PATH_ESCAPE` rather than touching an unexpected path. |
| `terminal/*` | Not advertised (`terminal: false`), so a conforming agent will not ask. |

Path confinement uses `path.relative(base, resolved)` and refuses anything starting with `..`,
which also rejects a different drive on Windows.

## Cancellation

```json
→ {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"ses_…"}}
← {"jsonrpc":"2.0","id":4,"result":{"stopReason":"cancelled"}}
```

The bridge sends `session/cancel` on abort but **keeps the prompt request pending**: the agent's
`cancelled` result is what keeps session state consistent. The stream then ends with
`{kind:'aborted'}`, never a silent stop.

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
- Only one prompt per session is in flight at a time. The bridge serializes because it pools one
  session per DSH session id.
- Conversation continuity across prompts on one session is real: a second prompt referring to the
  first is answered from context, which is what makes incremental prompting safe.
