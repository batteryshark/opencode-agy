#!/usr/bin/env node
/**
 * Offline stand-in for `agy` used by the integration tests. It speaks the same
 * stream-json protocol and, like agy, launches the MCP server declared in
 * ./.agents/mcp_config.json (our shim) and talks JSON-RPC to it.
 *
 * Behaviour is driven by the user text of each turn:
 *   CALL <tool> <json-args>   call an MCP tool, then answer with its output
 *   STALL                     never answer
 *   CRASH                     exit(3) before producing anything
 *   FAIL                      result status ERROR
 *   QUOTA                     result ERROR with a quota message
 *   TOOLS                     answer with the names from the latest tools/list
 *   anything else             "echo: <text>"
 * Env FAKE_AGY_REPLAY=<file>: replay a captured agy run instead (first turn).
 * Env FAKE_AGY_LOG=<file>: append argv per spawn (for assertions).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "models") {
  process.stdout.write("Fetching available models...\nfake-model\tFake Model\nbad-model\tBad Model\n");
  process.exit(0);
}
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : "";
};
if (process.env.FAKE_AGY_LOG) {
  appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), env: pickEnv() }) + "\n");
}
function pickEnv() {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? null,
    GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY ?? null,
  };
}

const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const model = arg("--model");
if (model === "bad-model") {
  out({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: `invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings` } });
  process.stderr.write(`error: invalid model selection\n`);
  process.exit(1);
}
const wanted = arg("--conversation");
let conversationId = wanted && !wanted.startsWith("missing") ? wanted : randomUUID();
if (wanted && wanted.startsWith("missing")) process.stderr.write(`warning: conversation "${wanted}" not found\n`);

// ---- MCP client to the configured server ------------------------------------
let mcp = null;
let mcpId = 0;
const mcpWait = new Map();
let tools = [];
function startMcp() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(process.cwd(), ".agents", "mcp_config.json"), "utf8"));
  } catch {
    return Promise.resolve();
  }
  const [name, server] = Object.entries(cfg.mcpServers || {})[0] || [];
  if (!server) return Promise.resolve();
  mcp = spawn(server.command, server.args || [], { env: { ...process.env, ...(server.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
  mcp.serverName = name;
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "notifications/tools/list_changed") {
      rpc("tools/list", {}).then((r) => (tools = r.result?.tools || []));
      return;
    }
    if (msg.id !== undefined && mcpWait.has(msg.id)) {
      mcpWait.get(msg.id)(msg);
      mcpWait.delete(msg.id);
    }
  });
  return rpc("server/discover", {})
    .then(() => rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-agy", version: "0" } }))
    .then(() => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"))
    .then(() => rpc("tools/list", {}))
    .then((r) => (tools = r.result?.tools || []));
}
function rpc(method, params) {
  const id = ++mcpId;
  return new Promise((resolve) => {
    mcpWait.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ---- turns -------------------------------------------------------------------
let step = 0;
const cum = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
const stepUsage = { input_tokens: 3000, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 3020 };
function su(state, type, extra = {}) {
  out({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state, step_type: type, ...extra } });
}
function addCum() {
  for (const k of Object.keys(cum)) cum[k] += stepUsage[k];
}
function result(status, response, error) {
  out({ event: "result", result: { conversation_id: conversationId, status, response, ...(error ? { error } : {}), num_turns: 1, usage: { ...cum } } });
}
function answer(text) {
  const mid = Math.ceil(text.length / 2);
  su("ACTIVE", "agent_response", { text_delta: text.slice(0, mid) });
  addCum();
  su("DONE", "agent_response", { text_delta: text.slice(mid), usage: { ...stepUsage } });
  result("SUCCESS", text);
}

async function turn(text) {
  su("DONE", "user_input");
  if (text.includes("CRASH")) process.exit(3);
  if (text.includes("STALL")) return;
  if (text.includes("QUOTA")) return result("ERROR", "", "RESOURCE_EXHAUSTED: You have exhausted your quota");
  if (text.includes("FAIL")) return result("ERROR", "", "boom");
  if (text.includes("TOOLS")) return answer(`tools: ${tools.map((t) => t.name).join(",")}`);
  const m = /CALL (\S+)(?: (\{.*\}))?/.exec(text);
  if (m) {
    addCum();
    su("DONE", "agent_response", { usage: { ...stepUsage } });
    const toolName = `mcp_${mcp?.serverName}_${m[1]}`;
    su("ACTIVE", "tool", { tool_name: toolName, tool_info: { name: toolName } });
    const r = await rpc("tools/call", {
      _meta: { "antigravity.google/conversation_id": conversationId, progressToken: `${randomUUID()}:2` },
      name: m[1],
      arguments: m[2] ? JSON.parse(m[2]) : {},
    });
    const output = r.result?.content?.map((c) => c.text).join("") ?? "";
    su(r.result?.isError ? "ERROR" : "DONE", "tool", { tool_name: toolName, tool_info: { name: toolName, output } });
    return answer(`${r.result?.isError ? "tool error" : "tool said"}: ${output}`);
  }
  return answer(`echo: ${text.slice(-200)}`);
}

async function main() {
  await startMcp();
  if (process.env.FAKE_AGY_REPLAY) {
    const lines = readFileSync(process.env.FAKE_AGY_REPLAY, "utf8").split("\n").filter(Boolean);
    const [initLine, ...rest] = lines;
    const init = JSON.parse(initLine);
    out({ ...init, conversation_id: conversationId });
    const rl = createInterface({ input: process.stdin });
    rl.once("line", () => {
      for (const l of rest) {
        const ev = JSON.parse(l);
        out(ev);
        if (ev.event === "result") break;
      }
    });
    return;
  }
  setTimeout(() => out({ event: "init", conversation_id: conversationId, init: { model, cwd: process.cwd(), agent: arg("--agent"), tools: ["view_file"], permission_mode: "request-review" } }), 20);
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event !== "user") return;
    const c = msg.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join("") : "";
    chain = chain.then(() => turn(text));
  });
  rl.on("close", () => chain.then(() => process.exit(0)));
}
main();
process.on("SIGTERM", () => {
  mcp?.kill();
  process.exit(0);
});
