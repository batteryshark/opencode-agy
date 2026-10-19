#!/usr/bin/env node
/**
 * stdio MCP server that agy launches from the session workspace's
 * .agents/mcp_config.json. It owns no tools itself: tools/list and
 * tools/call are relayed over a unix socket to the opencode-agy proxy, which
 * parks each call until the harness (OpenCode) sends the tool result back.
 *
 * env: OPENCODE_AGY_SOCKET (proxy socket path), OPENCODE_AGY_SESSION (session key)
 */
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const SOCKET = process.env.OPENCODE_AGY_SOCKET || "";
const SESSION = process.env.OPENCODE_AGY_SESSION || "";
const GEN = Number(process.env.OPENCODE_AGY_GEN || 0);

let rid = 0;
const waiting = new Map(); // rid -> resolve
let sock = null;
let sockBuf = "";
let connected = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function toProxy(msg) {
  if (!sock || !connected) return false;
  sock.write(JSON.stringify(msg) + "\n");
  return true;
}

function request(msg) {
  return new Promise((resolve) => {
    const id = ++rid;
    waiting.set(id, resolve);
    if (!toProxy({ ...msg, rid: id })) {
      waiting.delete(id);
      resolve(null);
    }
  });
}

function connect() {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve(false);
    const s = createConnection(SOCKET);
    s.setEncoding("utf8");
    s.once("connect", () => {
      sock = s;
      connected = true;
      s.write(JSON.stringify({ type: "hello", session: SESSION, gen: GEN, pid: process.pid, ppid: process.ppid }) + "\n");
      resolve(true);
    });
    s.on("data", (d) => {
      sockBuf += d;
      let nl;
      while ((nl = sockBuf.indexOf("\n")) >= 0) {
        const line = sockBuf.slice(0, nl);
        sockBuf = sockBuf.slice(nl + 1);
        if (line.trim()) onProxyMessage(line);
      }
    });
    s.on("error", () => resolve(false));
    s.on("close", () => {
      connected = false;
      // Proxy is gone: fail anything still waiting, then exit (agy will see EOF).
      for (const [, r] of waiting) r(null);
      waiting.clear();
      setTimeout(() => process.exit(0), 50);
    });
  });
}

function onProxyMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "tools_changed") {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    return;
  }
  if (typeof msg.rid === "number" && waiting.has(msg.rid)) {
    const r = waiting.get(msg.rid);
    waiting.delete(msg.rid);
    r(msg);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "opencode-agy-harness", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    const reply = await request({ type: "list" });
    send({ jsonrpc: "2.0", id, result: { tools: Array.isArray(reply?.tools) ? reply.tools : [] } });
    return;
  }
  if (method === "tools/call") {
    const meta = params?._meta || {};
    const p = request({
      type: "call",
      mcpId: id,
      name: params?.name,
      arguments: params?.arguments ?? {},
      conversationId: meta["antigravity.google/conversation_id"] || "",
      progressToken: meta.progressToken ?? null,
    });
    const reply = await p;
    const result =
      reply?.result && Array.isArray(reply.result.content)
        ? reply.result
        : { content: [{ type: "text", text: "opencode-agy proxy unavailable; the tool did not run." }], isError: true };
    send({ jsonrpc: "2.0", id, result });
    return;
  }
  if (method === "notifications/cancelled") {
    const requestId = params?.requestId;
    toProxy({ type: "cancelled", mcpId: requestId, reason: params?.reason || "" });
    return;
  }
  if (method === "ping" && id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (id !== undefined && id !== null) {
    // includes server/discover, which agy probes first and tolerates -32601 for
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
  // other notifications ignored
}

const ready = connect();
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  await ready;
  handle(msg).catch((err) => {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message || err) } });
  });
});
rl.on("close", () => process.exit(0));
