/** Shared test doubles: in-process fake agy processes and an HTTP app around them. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseNdjson } from "../src/events.js";
import { Pool } from "../src/pool.js";
import { createApp } from "../src/server.js";
import { Session } from "../src/session.js";

export const stubWorkspace = () => {
  const ws = { prepared: [], agentChanged: false };
  ws.prepare = (o) => {
    ws.prepared.push(o);
    const changed = ws.agentChanged;
    ws.agentChanged = false;
    return { dir: "/tmp/agy-test-ws", agentChanged: changed };
  };
  ws.writeMcp = () => {};
  return ws;
};

export class MemStore {
  constructor() {
    this.data = {};
  }
  get(k) {
    return this.data[k];
  }
  update(k, f) {
    this.data[k] = { ...(this.data[k] || {}), ...f };
    return this.data[k];
  }
  delete(k) {
    delete this.data[k];
  }
}

let nextPid = 5000;

/** Scriptable in-process stand-in for AgyProcess. */
export class FakeProc {
  static all = [];
  constructor(opts) {
    this.opts = opts;
    this.pid = nextPid++;
    this.exited = false;
    this.sent = [];
    this.initConversationId = FakeProc.nextInitId?.(opts) ?? (opts.conversationId || `conv-${this.pid}`);
    FakeProc.all.push(this);
  }
  static get last() {
    return FakeProc.all[FakeProc.all.length - 1];
  }
  start() {
    this.emit({ event: "init", conversation_id: this.initConversationId, init: {} });
    return this;
  }
  waitInit() {
    return Promise.resolve({ event: "init", conversation_id: this.initConversationId });
  }
  sendUser(text) {
    if (this.exited) throw new Error("not running");
    this.sent.push(text);
    this.onUser?.(text, this);
  }
  emit(ev) {
    if (!this.exited) this.opts.onItem({ src: "agy", ev });
  }
  step(fields) {
    this.emit({ event: "step_update", step_update: { conversation_id: this.initConversationId, ...fields } });
  }
  text(t, usage) {
    this.step({ state: usage ? "DONE" : "ACTIVE", step_type: "agent_response", text_delta: t, ...(usage ? { usage } : {}) });
  }
  result(usage, status = "SUCCESS", error) {
    this.emit({ event: "result", result: { conversation_id: this.initConversationId, status, response: "", usage, ...(error ? { error } : {}) } });
  }
  crash(code = 1) {
    if (this.exited) return;
    this.exited = true;
    this.opts.onItem({ src: "exit", info: { code, signal: null, stderr: "boom" } });
  }
  async kill() {
    this.killed = true;
    this.crash(null);
  }
}

/** FakeProc that replays a captured agy run (fixture) for each user turn. */
export function replayFactory(fixturePath) {
  const events = parseNdjson(readFileSync(fixturePath, "utf8"));
  const turns = [];
  let cur = [];
  for (const ev of events) {
    if (ev.event === "init") continue;
    cur.push(ev);
    if (ev.event === "result") {
      turns.push(cur);
      cur = [];
    }
  }
  return (opts) => {
    const p = new FakeProc(opts);
    let i = 0;
    p.onUser = () => {
      const evs = turns[i++] || [];
      setImmediate(() => evs.forEach((e) => p.emit(e)));
    };
    return p;
  };
}

/** A fake shim connection for Session.onToolCall. */
export function fakeConn(gen) {
  return { gen, sent: [], send(m) { this.sent.push(m); } };
}

/** HTTP server around createApp with injected process factory. */
export async function startTestApp(processFactory) {
  const store = new MemStore();
  const workspace = stubWorkspace();
  const pool = new Pool({
    store,
    sessionFactory: (o) => new Session({ ...o, processFactory, workspace }),
  });
  const app = createApp({ pool, store });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    checkIdleProcesses: app.checkIdleProcesses,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** Parse an SSE body into data payloads. */
export function parseSSE(text) {
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data: "))
    .map((b) => b.slice(6))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d));
}

export function sseContent(chunks) {
  return chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
}
