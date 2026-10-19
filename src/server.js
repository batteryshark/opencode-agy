/**
 * OpenAI-compatible HTTP front end (loopback by default).
 *
 *   POST /v1/chat/completions   streaming SSE and non-streaming
 *   GET  /v1/models             from `agy models` (cached)
 *   GET  /health
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { effortFor } from "./agy-process.js";
import { config, SSE_HEARTBEAT_MS } from "./config.js";
import { Hub } from "./hub.js";
import { log } from "./log.js";
import { listModels } from "./models.js";
import { Pool } from "./pool.js";
import { conversationKeyFromMessages, detectMetaKind, extractCwd, systemHash, systemPromptOf, collectToolResults } from "./prompt.js";
import { TurnError } from "./session.js";
import { SessionStore } from "./session-store.js";
import { compactSystemPrompt } from "./compact.js";
import { exposedTools, toolsHash } from "./tools.js";
import { toOpenAIUsage } from "./usage.js";

/** Headers OpenCode (and others) use to identify a chat session, in priority order. */
export const SESSION_HEADERS = Object.freeze([
  "x-opencode-session-id",
  "x-opencode-session",
  "x-session-id",
  "x-session-affinity",
]);
const DIRECTORY_HEADER = "x-opencode-directory";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function sessionKeyFromHeaders(headers) {
  for (const name of SESSION_HEADERS) {
    const v = headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim().slice(0, 200);
  }
  return "";
}

export function normalizeModel(model) {
  if (typeof model !== "string") return "";
  const m = model.trim();
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}

export function normalizeEffort(body) {
  const raw = body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.effort;
  if (typeof raw !== "string") return "";
  const e = raw.trim().toLowerCase();
  if (e === "minimal") return "low";
  if (e === "none" || e === "") return "";
  return ["low", "medium", "high", "xhigh", "max"].includes(e) ? e : "";
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

function errorBody(message, type = "server_error", code = undefined) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

function authorized(req) {
  const token = config.token;
  if (!token) return true;
  const header = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createApp({ pool, hub = null, store = null } = {}) {
  store = store || pool?.store || new SessionStore();
  pool = pool || new Pool({ store, hub });

  async function handleChat(req, res, body) {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return sendJson(res, 400, errorBody("messages must be a non-empty array", "invalid_request_error"));
    }
    const model = normalizeModel(body.model);
    if (!model) return sendJson(res, 400, errorBody("model is required", "invalid_request_error"));
    const effort = effortFor(model, normalizeEffort(body));
    const stream = body.stream === true;
    const metaKind = detectMetaKind(messages);

    log.debug("request headers", { names: Object.keys(req.headers).filter((h) => h.startsWith("x-")).sort() });
    let key = sessionKeyFromHeaders(req.headers);
    // Header missing but tool results present: find the parked session by call id.
    if (!key) {
      const results = collectToolResults(messages);
      for (const s of pool.sessions.values()) {
        if (s.pending && s.pendingIds().some((id) => results.has(id))) {
          key = s.key;
          break;
        }
      }
    }
    if (!key) key = conversationKeyFromMessages(messages);
    if (metaKind) key = `${metaKind}_${key}`;

    const rawSystemPrompt = systemPromptOf(messages);
    const directoryHeader = typeof req.headers[DIRECTORY_HEADER] === "string" ? req.headers[DIRECTORY_HEADER] : "";
    const cwd = config.cwdOverride || directoryHeader || extractCwd(rawSystemPrompt);
    const systemPrompt = compactSystemPrompt(rawSystemPrompt, config.compactPrompt);
    const exposed = metaKind
      ? { tools: [], batchTool: "", harnessNames: [] }
      : exposedTools(body.tools, {
          allow: config.toolsAllow,
          deny: config.toolsDeny,
          minify: config.minifyTools,
          descMax: config.toolDescMax,
          batch: config.batch,
          batchMax: config.batchMax,
        });
    const mcpTools = exposed.tools;
    const session = pool.get(key, { ephemeral: !!metaKind });

    log.info("chat completion", {
      key,
      model,
      effort: effort || undefined,
      stream,
      messages: messages.length,
      tools: mcpTools.length,
      meta: metaKind || undefined,
      state: session.state,
    });

    let aborted = false;
    const onClose = () => {
      if (!res.writableEnded) {
        aborted = true;
        session.abortTurn("client disconnected");
      }
    };
    res.on("close", onClose);

    let iter;
    try {
      const gen = await session.begin({
        messages,
        mcpTools,
        batchTool: exposed.batchTool,
        harnessNames: exposed.harnessNames,
        toolsHash: toolsHash(mcpTools),
        systemPrompt,
        systemHash: systemHash(systemPrompt),
        model,
        effort,
        cwd,
      });
      iter = gen[Symbol.asyncIterator]();
    } catch (err) {
      return failure(res, err);
    }
    if (aborted) {
      iter.return?.().catch(() => {});
      return;
    }

    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    return stream
      ? streamResponse(res, iter, { completionId, created, model: body.model || model, session })
      : collectResponse(res, iter, { completionId, created, model: body.model || model, session });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        return sendJson(res, 200, {
          ok: true,
          provider: "agy",
          agy: config.agyPath,
          live_processes: pool.liveCount(),
          max_processes: config.maxProcesses,
          sessions: authorized(req) ? pool.stats() : undefined,
        });
      }
      if (!authorized(req)) {
        return sendJson(res, 401, errorBody("missing or invalid bearer token", "authentication_error"));
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        const models = await listModels();
        return sendJson(res, 200, {
          object: "list",
          data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "agy", name: m.name })),
        });
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return sendJson(res, err.status || 400, errorBody(`invalid JSON body: ${err.message}`, "invalid_request_error"));
        }
        return await handleChat(req, res, body);
      }
      return sendJson(res, 404, errorBody(`no route for ${req.method} ${path}`, "not_found"));
    } catch (err) {
      log.error("request failed", { path, error: String(err?.message || err) });
      if (!res.headersSent) return sendJson(res, 500, errorBody(String(err?.message || err)));
      res.end();
    }
  }

  return { handle, pool, store };
}

function failure(res, err) {
  const status = err instanceof TurnError ? err.status : 500;
  const message = String(err?.message || err);
  log.warn("turn failed before output", { status, message: message.slice(0, 300) });
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, status, errorBody(message, err?.type || "server_error", err?.code));
}

/** Pull the first meaningful item so a turn that dies before output becomes a real HTTP error. */
async function probe(iter) {
  const buffered = [];
  while (true) {
    const next = await iter.next(); // throws on failure
    if (next.done) return { buffered, done: true };
    buffered.push(next.value);
    const t = next.value.type;
    if ((t === "text" && next.value.text) || t === "tool_call" || t === "finish") return { buffered, done: false };
  }
}

async function streamResponse(res, iter, { completionId, created, model, session }) {
  let first;
  try {
    first = await probe(iter);
  } catch (err) {
    return failure(res, err);
  }
  if (res.destroyed) return;
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  const chunk = (delta, finish = null, extra = {}) => ({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const send = (payload) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  send(chunk({ role: "assistant", content: "" }));
  let finishReason = "stop";
  let usage = null;
  let toolIndex = 0;
  let finished = false;
  const emit = (item) => {
    if (item.type === "text" && item.text) send(chunk({ content: item.text }));
    else if (item.type === "tool_call") {
      send(
        chunk({
          tool_calls: [{ index: toolIndex++, id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } }],
        }),
      );
    } else if (item.type === "finish") {
      finishReason = item.reason;
      usage = item.usage;
      finished = true;
    }
  };
  try {
    for (const item of first.buffered) emit(item);
    if (!first.done && !finished) {
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        emit(next.value);
        if (finished) break;
      }
    }
  } catch (err) {
    const message = String(err?.message || err);
    log.warn("turn failed mid-stream", { message: message.slice(0, 300) });
    send(chunk({ content: `\n\n[agy error] ${message}` }));
    if (err?.usage) usage = err.usage;
    finishReason = "stop";
  } finally {
    clearInterval(heartbeat);
    iter.return?.().catch(() => {});
  }
  send(chunk({}, finishReason, usage ? { usage: toOpenAIUsage(usage) } : {}));
  if (!res.writableEnded && !res.destroyed) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
  logDone(session, finishReason, usage);
}

function logDone(session, finish, usage) {
  log.info("response done", { key: session?.key, finish, ...(usage ? { usage } : {}) });
}

async function collectResponse(res, iter, { completionId, created, model, session }) {
  let content = "";
  const toolCalls = [];
  let finishReason = "stop";
  let usage = null;
  let sawContent = false;
  try {
    while (true) {
      const next = await iter.next();
      if (next.done) break;
      const item = next.value;
      if (item.type === "text") {
        content += item.text;
        if (item.text) sawContent = true;
      } else if (item.type === "tool_call") {
        toolCalls.push({ id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } });
        sawContent = true;
      } else if (item.type === "finish") {
        finishReason = item.reason;
        usage = item.usage;
        sawContent = true;
        break;
      }
    }
  } catch (err) {
    if (!sawContent || err?.status === 429) return failure(res, err);
    content += `\n\n[agy error] ${String(err?.message || err)}`;
    if (err?.usage) usage = err.usage;
  } finally {
    iter.return?.().catch(() => {});
  }
  logDone(session, finishReason, usage);
  sendJson(res, 200, {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: content || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage: toOpenAIUsage(usage) } : {}),
  });
}

/** Start hub + HTTP server. Returns {server, hub, pool, port, close}. */
export async function startServer({ port = config.port, host = "127.0.0.1" } = {}) {
  let poolRef = null;
  const hub = new Hub((key) => poolRef?.find(key));
  await hub.listen();
  const store = new SessionStore();
  const pool = new Pool({ store, hub });
  poolRef = pool;
  const app = createApp({ pool, hub, store });
  const server = createServer((req, res) => {
    app.handle(req, res);
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const sweep = setInterval(() => {
    for (const [key, s] of pool.sessions) {
      if (!s.alive && s.state === "idle" && Date.now() - s.lastUsed > 60 * 60_000) pool.sessions.delete(key);
    }
  }, 10 * 60_000);
  sweep.unref();
  log.info(`listening on http://${host}:${actualPort}/v1`, { agy: config.agyPath, maxProcesses: config.maxProcesses, auth: !!config.token });
  const close = async () => {
    clearInterval(sweep);
    await pool.shutdown();
    hub.close();
    await new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
  };
  return { server, hub, pool, port: actualPort, close };
}
