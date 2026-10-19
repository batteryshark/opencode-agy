# Protocol and operations reference

## Tool flow

Each session gets an AGY workspace with `.agents/agents/bridge.md`, MCP configuration and a PreToolUse gate. The agent declares `tools: []`; the gate allows only `mcp_harness_*` tools. A stdio MCP shim relays calls over a private Unix socket to the bridge. The harness executes those calls through its own permission system.

A matching tool result resumes a parked process. Retrying the same request re-emits its pending call. A superseding user turn stops the process and attempts conversation resume. Model, effective effort and system-prompt changes also restart it. Tool-set changes first attempt MCP list-change notification, then restart if the CLI doesn't re-list. Failed resume injects capped history. Rewritten initial history and optional token rollover start a fresh vendor conversation.

The resident pool defaults to six processes. It evicts the least recently used idle process, or a parked one if necessary; running turns aren't evicted. Calls are serialized unless batching is enabled. A parked-call timeout returns a tool error and drains the remaining turn. A client disconnect during a running turn stops that session's process.

## Sessions

Header priority is `x-opencode-session-id`, `x-opencode-session`, `x-session-id`, then `x-session-affinity`. The first nonblank string is trimmed and capped at 200 characters. Otherwise pending tool-call IDs are used to find a parked session, then the first user message supplies a fallback hash. Title and summary detection is heuristic; those requests use ephemeral tool-less sessions.

Workspace names are `workspace-v2-sha256-` plus the SHA-256 of the complete exact `JSON.stringify(key)` UTF-8 string. Workspace helpers accept only string keys and don't normalize or truncate them, including Unicode and lone UTF-16 surrogates. HTTP header normalization happens earlier, so hashing cannot restore distinctions already lost there.

Names are disjoint from the legacy sanitized names. Workspace preparation and MCP writes reject arbitrary destinations, symlink components (including dangling links), non-regular managed files and multiply linked managed files. Managed files use no-follow opens and descriptor validation. Use private real directories, with no symlinked cache parents. These checks cannot prevent hostile concurrent directory replacement: portable Node lacks directory-handle-relative `openat` operations.

### Existing state

The bridge doesn't migrate, merge or delete legacy workspaces. Stored conversation IDs may still be attempted from a new working directory; vendor resume across that change is unverified. An authorized operator changing workspace layouts should stop their old bridge normally, preserve its private state, and select fresh sessions with separate XDG data/cache roots. Don't assume a rewritten prompt/config migrates a resident conversation. There is no automatic reset or migration command.

## Model and effort mapping

The bridge strips the provider prefix from the request model. Only terminal, case-insensitive `-low`, `-medium`, `-high`, `-xhigh` and `-max` suffixes suppress explicit `--effort`.

Otherwise effort uses `reasoning_effort ?? reasoning.effort ?? effort`. Strings are trimmed and lowercased. Accepted values are low, medium, high, xhigh and max; minimal maps to low. None, empty, invalid and nonstring values omit the flag. Other suffixes and aliases have no special meaning. Actual supported models/efforts depend on your vendor version and account.

Usage mapping combines vendor step and cumulative counters; cache reads count toward prompt tokens and thinking toward reasoning tokens. It doesn't establish billing rates, quota economics or guaranteed cache reuse.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_AGY_PORT` | `4517` | HTTP port; CLI `--port` overrides it |
| `OPENCODE_AGY_BIN` | `~/.local/bin/agy` | Official CLI executable |
| `OPENCODE_AGY_TOKEN` | unset | Optional bearer authentication |
| `OPENCODE_AGY_MAX_PROCS` | `6` | Resident process cap |
| `OPENCODE_AGY_STALL_MS` | `600000` | Stdout silence ceiling while running |
| `OPENCODE_AGY_PARK_MS` | `1800000` | Tool-result wait ceiling |
| `OPENCODE_AGY_INIT_TIMEOUT_MS` | `60000` | Init-event wait |
| `OPENCODE_AGY_HISTORY_MAX_CHARS` | `200000` | Transferred history cap |
| `OPENCODE_AGY_MCP_TIMEOUT_S` | `-1` | Vendor shim timeout; version-sensitive |
| `OPENCODE_AGY_CWD` | unset | Project directory override |
| `OPENCODE_AGY_LOG_LEVEL` | `info` | stderr verbosity |
| `OPENCODE_AGY_TOOLS_CHANGE` | `notify` | Set `restart` to always restart |
| `OPENCODE_AGY_GATE_HOOK` | `1` | `0` disables the tool gate |
| `OPENCODE_AGY_EXCLUDE_DEFAULTS` | `1` | Exclude vendor default agent components |
| `OPENCODE_AGY_COMPACT_PROMPT` | `1` | `0` off, `1` compact, `2` aggressive |
| `OPENCODE_AGY_MINIFY_TOOLS` | `1` | Tool schema/description minification |
| `OPENCODE_AGY_TOOL_DESC_MAX` | `400` | Minified description character cap |
| `OPENCODE_AGY_TOOLS_ALLOW` / `OPENCODE_AGY_TOOLS_DENY` | unset | Comma-separated tool filters |
| `OPENCODE_AGY_BATCH` / `OPENCODE_AGY_BATCH_MAX` | `0` / `8` | Optional batching and call cap |
| `OPENCODE_AGY_TOOL_OUTPUT_MAX` | `40000` | Result truncation; `0` disables |
| `OPENCODE_AGY_ROLLOVER_TOKENS` | `0` | Fresh-conversation threshold; `0` off |
| `OPENCODE_AGY_MODELS_CACHE_MS` | `600000` | Vendor model-list cache duration |
| `OPENCODE_AGY_SOCKET_PATH` | cache `run/hub-<pid>.sock` | Hub socket override; keep private and short |

`XDG_DATA_HOME` relocates state from `~/.local/share/opencode-agy/sessions.json`. `XDG_CACHE_HOME` relocates workspaces and sockets from `~/.cache/opencode-agy/`. Session mappings are atomically written mode 0600; new workspace directories use mode 0700. Use a private data root too: the session-store directory creation relies on the operator's umask. The generated shim environment carries socket/session/generation values; operators don't need to set those internal variables.

State and logs may contain prompts, tools, results, paths and conversation identifiers. Keep them out of Git and source archives. The child environment removes `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_GENAI_API_KEY`, but inherits other variables. Launch with a minimal environment. Vendor global settings and login remain outside workspace isolation.

## HTTP and host compatibility

Both `/v1/` routes and unprefixed `/chat/completions` and `/models` aliases are accepted. Health is available at `/health` and `/v1/health`. Setting a bearer token protects chat/models, while health still reveals basic process/binary information. Session statistics require authorization when a token is set.

This is a single-operator local adapter. It has no tenant isolation, TLS listener, complete OpenAI API implementation or automatic model enrollment. Verify affinity, tool-result handling, timeouts and model limits for each client/version. The AGY stream parser describes 1.3.3-era events; later CLI behavior needs separate validation. An infinite MCP timeout is version-sensitive; choose a finite one if your workflow needs a hard ceiling.

## Explicit config sync

`sync-config` is operator opt-in. It reads an existing strict-JSON file, fetches `<baseURL>/models`, then updates the AGY model map. `--dry-run` prints added/removed/retained counts without writing. The default preview omits all model IDs, config lines and values, including retained settings/headers; it is not a value diff. Apply creates an exclusive timestamp/UUID `.bak`, writes a temporary file and renames it over the config, then prints the same counts-only summary. Review counts with dry-run before applying. Backups can contain credentials and must stay private. There is no automatic rollback.

Exactly one of these layouts must exist:

- V2: `providers.agy.models` and `providers.agy.settings`, both objects. New entries use `capabilities: {"tools":true,"input":["text"],"output":["text"]}`.
- Legacy: `provider.agy.models` and `provider.agy.options`, both objects. New entries use `tool_call: true`.

Both AGY blocks, mixed settings/options, duplicate JSON keys, malformed model maps and non-object entries are refused before fetch or mutation. Other providers may coexist. Existing advertised model entries retain every explicit override, including names, limits and provider-specific fields; they aren't converted between schemas. Models absent from the response are removed, including any manually configured aliases whose keys the bridge doesn't advertise. New model IDs must be nonempty alphanumeric/dot/underscore/hyphen identifiers beginning with an alphanumeric character. Empty, invalid and duplicate inventories refuse without partial writes.

The only automatic mapping is `gpt-oss-120b-medium`: context 131072 from the public [GPT-OSS configuration](https://huggingface.co/openai/gpt-oss-120b/blob/b5c939de8f754692c1647ca79fbf85e8c1e70f8a/config.json), with a conservative configured output cap of 32768. That cap is not a vendor-reported maximum. No model/account discovery establishes these limits through AGY. Other new IDs require a manually configured entry with independently verified limits before sync can proceed.

V2 field names and the text/tool capability shape follow the public [provider](https://opencode.ai/v2/docs/providers) and [model](https://opencode.ai/v2/docs/models) references, also available in pinned [provider source](https://github.com/anomalyco/opencode/blob/d889cb20447f3b31d88719786f46a1a75ed2e6fa/services/www/src/docs/content/providers.mdx) and [model source](https://github.com/anomalyco/opencode/blob/d889cb20447f3b31d88719786f46a1a75ed2e6fa/services/www/src/docs/content/models.mdx). Legacy support is limited to this explicit editing shape; it isn't a claim of current OpenCode V1 runtime acceptance.

Path selection is `--config`, otherwise `$XDG_CONFIG_HOME/opencode/opencode.json`, otherwise `~/.config/opencode/opencode.json`. The default does not search for project configs or `opencode.jsonc`. URL selection is `--url`, the selected block's `settings.baseURL` or `options.baseURL`, then `http://127.0.0.1:4517/v1`. Only HTTP/HTTPS are accepted, redirects are refused and fetch has a 30-second timeout. `OPENCODE_AGY_TOKEN` supplies bearer authentication; config `apiKey` substitutions are not resolved. An explicit URL can send that token to the named host, so review it carefully.

Only the model map's separators/keys and generated public entries are serialized. Each retained model VALUE is copied as an exact raw JSON span, including nested objects/arrays, escaped keys, whitespace and number literals (large integers, overflow exponents, long fractions and negative zero included). No retained numeric value is round-tripped through JavaScript serialization. Bytes before and after the map value are retained, including unrelated fields and line endings. A no-op leaves all bytes unchanged.

The target must be a regular single-link file; final-component symlinks and hardlinks are refused. Parent directories remain operator-selected and trusted. Replacement requests the existing ordinary permission bits; the process umask can narrow them. ACLs, ownership and extended attributes are not preserved by the replacement-file mechanism.

Ordinary content edits during fetch and before rename are checked and refused. These checks aren't a filesystem lock or protection against hostile concurrent path replacement. A late failure can leave a backup; any created temporary file is removed on the normal error path. HTTP, parse, inventory and pre-write validation failures leave the config untouched.

## Development checks

`npm test` runs all built-in Node tests, including an HTTP listener, Unix sockets, shim processes and synthetic workspace writes. It requires an isolated environment and is unsuitable as an inert source check. `test/fake-agy.js` is a process-based test double and must never be substituted into an existing live service.

Pure mapping/compaction/tool tests and in-memory session/SSE tests can run offline with subprocess/network guards and fake HOME/XDG/temp roots. Workspace tests need a mocked `git init` as well. Run syntax checks with `node --check`; don't import the CLI or shim for a syntax check because their top-level code activates runtime behavior. No dependency installation is required.
