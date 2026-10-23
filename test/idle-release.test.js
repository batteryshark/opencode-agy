import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { request } from "node:http";
import { Session } from "../src/session.js";
import { config } from "../src/config.js";
import { Pool } from "../src/pool.js";
import { FakeProc, MemStore, stubWorkspace, fakeConn, startTestApp } from "./helpers.js";

const req = { messages: [{ role: "user", content: "one" }], mcpTools: [], toolsHash: "t", systemPrompt: "s", systemHash: "s", model: "fake" };
const future = () => Date.now() + 120_000;
afterEach(() => { delete process.env.OPENCODE_AGY_IDLE_RELEASE_MS; });
function make() {
  const store = new MemStore();
  const s = new Session({ key: "idle-test", store, workspace: stubWorkspace(), processFactory: (o) => {
    const p = new FakeProc(o);
    p.releaseIdle = async () => { p.terms = (p.terms || 0) + 1; p.crash(0); return true; };
    return p;
  } });
  return { s, store };
}
async function completed(s) {
  const it = await s.begin(req);
  s.proc.result();
  for await (const _ of it) { /* fully consumed */ }
}

test("idle alone retains; successful final yield still leased; consumed completion releases and resumes without replay", async () => {
  const { s, store } = make();
  assert.equal(await s.checkIdleRelease(future()), false);
  const it = await s.begin(req);
  const p = s.proc;
  p.result();
  assert.equal((await it.next()).value.type, "finish");
  assert.equal(await s.checkIdleRelease(future()), false, "suspended final yield is not consumed");
  await it.return();
  assert.ok(s.completedTurn);
  assert.equal(await s.checkIdleRelease(), false, "grace has not elapsed");
  const record = structuredClone(store.get(s.key));
  const fp = s.turnFingerprint;
  assert.equal(await s.checkIdleRelease(future()), true);
  assert.equal(s.proc, null);
  assert.equal(p.terms, 1);
  assert.deepEqual(store.get(s.key), record);
  assert.equal(s.turnFingerprint, fp);
  const next = await s.begin({ ...req, messages: [...req.messages, { role: "assistant", content: "done" }, { role: "user", content: "two" }] });
  assert.equal(s.proc.opts.conversationId, record.conversation_id);
  assert.deepEqual(s.proc.sent, ["two"]);
  s.proc.result();
  for await (const _ of next) { /* complete */ }
});

test("all retained-state guards fail closed on a positive completed generation", async () => {
  const cases = [
    ["running", (s) => { s.state = "running"; }],
    ["parked", (s) => { s.state = "parked"; }],
    ["unknown", (s) => { s.state = "unknown"; }],
    ["consumer", (s) => { s.consumerActive = true; }],
    ["lease", (s) => { s.workLeases++; }],
    ["pending batch", (s) => { s.pending = { subs: [{ id: "a" }, { id: "b" }] }; }],
    ["tool in transit", (s) => { s.toolCalls.add({}); }],
    ["active tool step", (s) => { s.activeToolSteps.add(1); }],
    ["drain", (s) => { s.draining = true; }],
    ["list wait", (s) => { s._listWaiters.push(() => {}); }],
    ["queued event", (s) => { s.queue.push({}); }],
    ["unknown generation", (s) => { s.gen++; }],
    ["unknown owner", (s) => { s.completedTurn.proc = {}; }],
    ["uncertain turn", (s) => { s.turnUncertain = true; }],
  ];
  for (const [name, mutate] of cases) {
    const { s } = make(); await completed(s); mutate(s);
    assert.equal(await s.checkIdleRelease(future()), false, name);
    assert.equal(s.proc.terms, undefined, name);
  }
});

test("new request invalidates completion synchronously before lock; failed and partial turns retain", async () => {
  const { s } = make(); await completed(s);
  let unlock;
  s._lock = new Promise((r) => { unlock = r; });
  const queued = s.begin({ ...req, messages: [{ role: "user", content: "two" }] });
  assert.equal(s.workLeases, 1);
  assert.equal(await s.checkIdleRelease(future()), false);
  unlock();
  const it = await queued;
  s.proc.result(null, "ERROR", "failure");
  await assert.rejects(it.next(), /failure/);
  assert.equal(await s.checkIdleRelease(future()), false);
  const partial = await s.begin(req);
  s.proc.text("partial");
  await partial.next(); await partial.return();
  assert.equal(s.completedTurn, null);
});

test("release claim rejects racing work; TERM failure retains exact child without retries until real exit", async () => {
  const { s } = make(); await completed(s);
  const p = s.proc;
  let finish;
  p.releaseIdle = () => { p.terms = (p.terms || 0) + 1; return new Promise((r) => { finish = r; }); };
  const releasing = s.checkIdleRelease(future());
  await assert.rejects(s.begin(req), (e) => e.status === 503);
  finish(false);
  assert.equal(await releasing, false);
  assert.equal(s.proc, p); assert.equal(s.alive, true);
  assert.equal(s.state, "releasing");
  const pool = new Pool(); pool.sessions.set(s.key, s);
  const previousMax = process.env.OPENCODE_AGY_MAX_PROCS;
  process.env.OPENCODE_AGY_MAX_PROCS = "1";
  try { await assert.rejects(pool.ensureCapacity({}), (e) => e.code === "agy_busy"); }
  finally {
    if (previousMax === undefined) delete process.env.OPENCODE_AGY_MAX_PROCS;
    else process.env.OPENCODE_AGY_MAX_PROCS = previousMax;
  }
  assert.equal(await s.checkIdleRelease(future()), false);
  await assert.rejects(s.begin(req), (e) => e.code === "agy_idle_releasing");
  assert.equal(p.terms, 1); assert.equal(p.killed, undefined); assert.equal(p.sent.length, 1);
  p.crash(0); assert.equal(s.idleRelease, null); assert.equal(s.proc, null);
});

test("disabled config retains, default is 60 seconds", async () => {
  assert.equal(config.idleReleaseMs, 60_000);
  const { s } = make(); await completed(s);
  process.env.OPENCODE_AGY_IDLE_RELEASE_MS = "0";
  assert.equal(await s.checkIdleRelease(future()), false);
  assert.ok(s.alive);
});

test("queued MCP call prevents SUCCESS from proving quiescence", async () => {
  const { s } = make(); const it = await s.begin(req);
  s.proc.result();
  s.onToolCall(fakeConn(s.gen), { rid: 1, name: "tool", arguments: {} });
  for await (const _ of it) { /* consumes result, not the following call */ }
  assert.equal(s.completedTurn, null);
  assert.equal(await s.checkIdleRelease(future()), false);
});

test("late old-consumer return cannot certify a newer same-child turn", async () => {
  const { s } = make();
  const old = await s.begin(req); s.proc.result(); await old.next();
  const next = await s.begin({ ...req, messages: [...req.messages, { role: "user", content: "new" }] });
  await old.return();
  assert.equal(s.completedTurn, null);
  assert.equal(await s.checkIdleRelease(future()), false);
  s.proc.result();
  for await (const _ of next) { /* complete the newer request */ }
  assert.equal(await s.checkIdleRelease(future()), true);
});

test("unpulled superseded iterator cannot consume the newer child's stdout", async () => {
  const { s } = make();
  const old = await s.begin(req);
  const next = await s.begin({ ...req, messages: [{ role: "user", content: "new" }] });
  assert.equal((await old.next()).done, true);
  s.proc.text("new output"); s.proc.result();
  const items = [];
  for await (const item of next) items.push(item);
  assert.equal(items[0].text, "new output");
  assert.equal(await s.checkIdleRelease(future()), true);
});

test("unknown tool identity, active tool, cancellation, disconnect, step failure and partial batch retain", async () => {
  for (const mutate of [
    (s) => s.proc.step({ state: "ACTIVE", step_type: "tool" }),
    (s) => s.proc.step({ step_index: 2, state: "ACTIVE", step_type: "tool" }),
    (s) => s.onToolCancelled(fakeConn(s.gen), { mcpId: 1 }),
    (s) => s.onShimDisconnected(fakeConn(s.gen)),
    (s) => s.proc.step({ state: "ERROR", step_type: "error_message", text_delta: "failed step" }),
    (s) => {
      s.pending = { subs: [{ id: "a", name: "one" }, { id: "b", name: "two" }], conn: fakeConn(s.gen), rid: 1 };
      s._resolveFromResults(new Map([["a", "only one result"]]));
    },
  ]) {
    const { s } = make(); const it = await s.begin(req); mutate(s); s.proc.result();
    for await (const _ of it) { /* result SUCCESS is insufficient */ }
    assert.equal(s.completedTurn, null);
    assert.equal(await s.checkIdleRelease(future()), false);
  }
});

test("HTTP unknown body and active SSE request globally guard completed unrelated session", async () => {
  const app = await startTestApp((o) => {
    const p = new FakeProc(o);
    p.onUser = (text) => { if (text === "hello") p.result(); else if (text === "hold") p.text("held stream"); };
    p.releaseIdle = async () => { p.crash(0); return true; };
    return p;
  });
  let slow;
  try {
    const ready = app.pool.get("ready"); await completed(ready);
    slow = request(`${app.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" } });
    slow.on("error", () => {});
    slow.write('{"model":');
    await new Promise((r) => setTimeout(r, 30));
    await app.checkIdleProcesses(future());
    assert.equal(ready.alive, true);
    slow.end('"fake","stream":true,"messages":[{"role":"user","content":"hello"}]}');
    await new Promise((resolve) => slow.on("response", (res) => { res.resume(); res.on("end", resolve); }));
    const ac = new AbortController();
    const stream = await fetch(`${app.base}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", "x-session-id": "held" },
      body: JSON.stringify({ model: "fake", stream: true, messages: [{ role: "user", content: "hold" }] }), signal: ac.signal,
    });
    const reader = stream.body.getReader(); await reader.read();
    await app.checkIdleProcesses(future());
    assert.equal(ready.alive, true, "active SSE retains unrelated completed child");
    ac.abort(); await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setImmediate(r));
    await app.checkIdleProcesses(future());
    assert.equal(ready.alive, false);
  } finally { slow?.destroy(); await app.close(); }
});
