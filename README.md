# opencode-agy

<p><a href="assets/workstack-mark-full.png"><img src="assets/workstack-mark.png" alt="A green chameleon holding a connector" width="160"></a></p>

opencode-agy lets a coding harness use the official Antigravity CLI (`agy`) for text generation while keeping tool execution in the harness. It exposes chat completions over local HTTP and translates the harness's function tools into MCP tools for a resident CLI conversation.

Use it when you want an authorized AGY account behind an OpenAI-style client without handing the CLI its own filesystem and shell tools. When the model asks for a tool, the bridge returns `tool_calls` to the client and parks the CLI. The client applies its permissions, runs the tool, and sends the result back to resume the same process. Session reuse avoids replaying the whole harness transcript on every step.

## Before you start

- Node.js 22 or newer and Git. The bridge uses built-in Node modules; there are no npm dependencies or build steps.
- The official `agy` executable, installed separately and signed in by you. Your account must permit the models and workflow you use. Requests consume vendor quota and may incur charges under your plan.
- A Unix-like host with Unix-domain sockets and process-group signals. The implementation assumes these facilities; Windows support is unverified.
- A client that supports chat completions, function tools and tool-result round trips. OpenCode uses this as a custom HTTP provider. This repository has no OpenCode plugin hooks or SDK dependency.

The CLI still uses its own login, network access and global settings. The workspace and tool gate provide defense in depth; OS-level sandboxing requires separate controls. Use a trusted local client, keep harness permissions enabled, and run the bridge with only the environment it needs. Vendor terms and account access apply separately from this project's MIT license.

## Run from source

From the checked-out repository:

```sh
cd opencode-agy
export OPENCODE_AGY_BIN="$(command -v agy)"
# Set OPENCODE_AGY_TOKEN to a private value before serving.
node bin/opencode-agy.js serve --port 4600
```

Choose an unused port. This example uses `http://127.0.0.1:4600/v1`; the default is 4517. Keep the foreground process running and use Ctrl-C to close it. Installation, service registration and config sync are never automatic. The npm package is marked private.

Set `OPENCODE_AGY_TOKEN` in both the bridge and client environments to require bearer authentication. If it is unset, protected routes accept any local caller. Health routes remain unauthenticated and reveal the CLI path and process counts. The CLI binds to loopback; the exported library accepts another host, so embedding callers must preserve that boundary.

`node bin/opencode-agy.js models` lists models through the vendor CLI. `doctor` also runs `agy models`; neither command is an offline check. Sign in through the vendor's own workflow before using them. The bridge doesn't install the CLI or manage credentials.

### OpenCode V2

Merge this provider into a project `opencode.jsonc`. Replace `example-model` with an ID you have independently verified for your CLI/account, and set the same token in the OpenCode server environment. The placeholder is deliberately not a model recommendation.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "agy": {
      "name": "Local agy bridge",
      "env": ["OPENCODE_AGY_TOKEN"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:4600/v1",
        "apiKey": "{env:OPENCODE_AGY_TOKEN}"
      },
      "models": {
        "example-model": {
          "modelID": "example-model",
          "capabilities": {"tools": true, "input": ["text"], "output": ["text"]}
        }
      }
    }
  }
}
```

Select `agy/<your-model-key>` in the client. Add verified model `limit` values before relying on context budgeting; this bridge doesn't discover context windows, prices or entitlements. The shape follows the OpenCode V2 [custom-provider](https://opencode.ai/v2/docs/providers#custom) and [configuration](https://opencode.ai/v2/docs/config) APIs. Only chat completions are implemented; the Responses API is unsupported. Current OpenCode/AGY end-to-end compatibility has not been tested for this snapshot. The parser documents AGY 1.3.3 event shapes.

For reliable continuity, the client must send a distinct, stable session header per conversation. Without one, the bridge falls back to a hash of the first user message and identical openings can collide. Automatic affinity headers depend on the client version. See [protocol and session behavior](docs/reference.md#sessions).

### Optional model-list sync

For an existing strict-JSON config, you can explicitly preview and apply a model-list update:

```sh
node bin/opencode-agy.js sync-config --config ./opencode.json --url http://127.0.0.1:4600/v1 --dry-run
node bin/opencode-agy.js sync-config --config ./opencode.json --url http://127.0.0.1:4600/v1
```

Both commands fetch the selected bridge's `/models` route, which can invoke `agy models`. Use only your intended, trusted bridge. Sync keeps existing advertised model overrides, removes IDs the bridge no longer advertises, and adds supported new IDs. Unknown new families refuse the whole update: add verified entries manually first. Only the public GPT-OSS mapping has an automatic limit entry; this does not promise account availability.

Apply makes a timestamped `.bak` beside the config and replaces only the model block. Dry-run and no-op make no backup. The command accepts one explicit V2 AGY block or one legacy block; it doesn't migrate schemas, rewrite JSONC, restart a client or restore a backup for you. Without `--config`, it targets the user config, so use an explicit path when you mean a project file. See [sync behavior and failure limits](docs/reference.md#explicit-config-sync).

## Boundaries

The endpoint supports `POST /v1/chat/completions` (SSE or JSON), `GET /v1/models` (cached vendor CLI output), and `GET /health`. It forwards text only. Image, file and audio parts become omission notes; thinking text is not streamed. Sampling and format fields such as `temperature`, `top_p`, `max_tokens`, `stop` and `response_format` are ignored.

Prompts, tool results and conversation identifiers can reach the vendor and remain in local state. Logs can contain paths, session IDs and vendor errors without redaction. Prompt compaction, schema minification and tool-result truncation are enabled by default and can lose information. Tune or disable them for work that needs exact fidelity. Earlier edits to a resident conversation aren't generally replayed; start a fresh session when history changes matter.

State belongs outside the source checkout. [The reference](docs/reference.md) covers environment settings, storage, effort mapping, workspace safety and fresh-state cutovers. No model access, quota savings or compatibility with every harness is guaranteed.

## Source and tests

`bin/` contains the CLI. `src/` contains the HTTP adapter, resident-session pool, MCP shim, workspace and event mapping. `test/` contains synthetic event streams, in-memory doubles and integration tests. The four JSONL streams are authored fixtures; no recorded conversations are included.

For development, read [the check boundaries](docs/reference.md#development-checks) before running tests. The full test command opens listeners and launches test subprocesses. Source setup and live vendor/client behavior require separate operator validation.

Owned source, documentation and synthetic tests are [MIT licensed](LICENSE). The included AI-generated comic artwork is offered under MIT to the extent applicable, without a claim of exclusive copyright. Vendor software and services retain their own terms. See [rights and outside notices](RIGHTS.md).
