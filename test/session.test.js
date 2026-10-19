/** Park / resume / supersede state machine, driven with an in-process fake agy. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Session, TurnError, classifyFailure } from "../src/session.js";
import { FakeProc, MemStore, fakeConn, stubWorkspace } from "./helpers.js";

const tick = () => new Promise((r) => setImmediate(r));
const U = (i, o) => ({ input_tokens: i, output_tokens: o, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: i + o });

function makeSession(opts = {}) {
  const store = opts.store || new MemStore();
  const workspace = opts.workspace || stubWorkspace();
  const s = new Session({ key: opts.key || "s1", store, processFactory: (o) => new FakeProc(o), workspace, ephemeral: opts.ephemeral });
  return { s, store, workspace };
}

function req(messages, extra = {}) {
  return { messages, mcpTools: [], toolsHash: "t0", systemPrompt: "sys", systemHash: "h0", model: "synthetic-model-low", effort: "", cwd: "/p", ...extra };
}

const user1 = [{ role: "user", content: "weather in Paris?" }];

/** Collect items from the iterator until it ends. */
async function drain(it) {
  const items = [];
  for await (const x of it) items.push(x);
  return items;
}

/** Start a turn that parks on get_weather; returns {s, it, proc, conn, call}. */
async function parkedSession(opts) {
  const ctx = makeSession(opts);
  const it = await ctx.s.begin(req(user1));
  const proc = FakeProc.last;
  const conn = fakeConn(proc.gen);
  const collecting = drain(it);
  await tick();
  proc.step({ state: "DONE", step_type: "agent_response", usage: U(3000, 30) });
  ctx.s.onToolCall(conn, { rid: 7, mcpId: 4, name: "get_weather", arguments: { city: "Paris" } });
  proc.step({ state: "ACTIVE", step_type: "tool", tool_info: { name: "mcp_harness_get_weather" } });
  const items = await collecting;
  return { ...ctx, it, proc, conn, items, call: items.find((i) => i.type === "tool_call") };
}

beforeEach(() => {
  FakeProc.all = [];
  FakeProc.nextInitId = undefined;
  delete process.env.OPENCODE_AGY_PARK_MS;
  delete process.env.OPENCODE_AGY_STALL_MS;
});

test("plain turn streams text then finishes with usage", async () => {
  const { s, store } = makeSession();
  const it = await s.begin(req(user1));
  const proc = FakeProc.last;
  assert.equal(proc.sent[0], "weather in Paris?");
  assert.equal(proc.opts.conversationId, "");
  const p = drain(it);
  await tick();
  proc.text("Hel");
  proc.text("lo", U(3000, 5));
  proc.result(U(3000, 5));
  const items = await p;
  assert.deepEqual(items.map((i) => i.type), ["text", "text", "finish"]);
  assert.equal(items.at(-1).reason, "stop");
  assert.deepEqual(items.at(-1).usage, { input_tokens: 3000, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0 });
  assert.equal(s.state, "idle");
  assert.equal(store.get("s1").conversation_id, proc.initConversationId);
});

test("tool call parks the response; tool result resumes the same process", async () => {
  const { s, proc, conn, items, call } = await parkedSession();
  assert.deepEqual(items.map((i) => i.type), ["tool_call", "finish"]);
  assert.equal(call.name, "get_weather");
  assert.equal(call.arguments, '{"city":"Paris"}');
  assert.match(call.id, /^call_[0-9a-f]{32}$/);
  assert.equal(items[1].reason, "tool_calls");
  assert.equal(items[1].usage.input_tokens, 3000);
  assert.equal(s.state, "parked");
  assert.equal(conn.sent.length, 0, "agy is still waiting");

  const msgs2 = [...user1, { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: "get_weather", arguments: call.arguments } }] }, { role: "tool", tool_call_id: call.id, content: "17C drizzle" }];
  const it2 = await s.begin(req(msgs2));
  assert.equal(FakeProc.all.length, 1, "no respawn");
  assert.deepEqual(conn.sent, [{ type: "call_result", rid: 7, result: { content: [{ type: "text", text: "17C drizzle" }], isError: false } }]);
  assert.equal(s.state, "running");
  const p = drain(it2);
  await tick();
  proc.text("It is 17C", U(3100, 10));
  proc.result(U(6100, 40));
  const items2 = await p;
  assert.equal(items2.map((i) => i.text || "").join(""), "It is 17C");
  assert.equal(items2.at(-1).reason, "stop");
  // the turn total (6100/40) minus what the parked response already reported (3000/30)
  assert.equal(items2.at(-1).usage.input_tokens, 3100);
  assert.equal(items2.at(-1).usage.output_tokens, 10);
  assert.equal(proc.sent.length, 1, "continuation did not send a new user message");
});

test("a retry while parked re-emits the same tool call without touching agy", async () => {
  const { s, proc, call } = await parkedSession();
  const items = await drain(await s.begin(req(user1)));
  assert.deepEqual(items.map((i) => i.type), ["tool_call", "finish"]);
  assert.equal(items[0].id, call.id);
  assert.equal(proc.sent.length, 1);
  assert.equal(s.state, "parked");
});

test("a new user turn supersedes a parked call: kill, resume with --conversation", async () => {
  const { s, proc } = await parkedSession();
  const msgs = [...user1, { role: "user", content: "never mind, say OK" }];
  const it = await s.begin(req(msgs));
  assert.equal(proc.killed, true);
  const p2 = FakeProc.last;
  assert.notEqual(p2, proc);
  assert.equal(p2.opts.conversationId, proc.initConversationId);
  assert.equal(p2.sent[0], "never mind, say OK", "only the part of the tail agy has not seen");
  const p = drain(it);
  await tick();
  p2.text("OK", U(1, 1));
  p2.result(U(1, 1));
  assert.equal((await p).at(-1).reason, "stop");
});

test("parked-call ceiling returns isError to agy and drains the turn in the background", async () => {
  process.env.OPENCODE_AGY_PARK_MS = "1000";
  const { s, proc, conn } = await parkedSession();
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].result.isError, true);
  assert.match(conn.sent[0].result.content[0].text, /did not return a result/);
  assert.equal(s.state, "running");
  proc.text("sorry, the tool timed out", U(10, 5));
  proc.result(U(3010, 35));
  await tick();
  await tick();
  assert.equal(s.state, "idle");
  assert.equal(s.alive, true, "process kept for the next turn");
});

test("stall watchdog kills the process and fails the turn with 504", async () => {
  process.env.OPENCODE_AGY_STALL_MS = "1000";
  const { s } = makeSession();
  const it = await s.begin(req(user1));
  const proc = FakeProc.last;
  await assert.rejects(drain(it), (err) => err instanceof TurnError && err.status === 504 && /no output for 1s/.test(err.message));
  assert.equal(proc.killed, true);
  assert.equal(s.state, "idle");
});

test("stall watchdog is paused while parked", async () => {
  process.env.OPENCODE_AGY_STALL_MS = "1000";
  const { s, proc } = await parkedSession();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(s.state, "parked");
  assert.equal(proc.killed, undefined);
});

test("process death mid-turn surfaces as a TurnError; while parked it resets to idle", async () => {
  const { s } = makeSession();
  const it = await s.begin(req(user1));
  const proc = FakeProc.last;
  const p = drain(it);
  await tick();
  proc.crash(2);
  await assert.rejects(p, /agy exited \(code 2\)/);
  assert.equal(s.state, "idle");

  const ctx = await parkedSession({ key: "s2" });
  ctx.proc.crash(1);
  assert.equal(ctx.s.state, "idle");
  assert.equal(ctx.s.pending, null);
  // the tool result now goes to a respawned process as text
  const msgs = [...user1, { role: "assistant", content: null, tool_calls: [{ id: ctx.call.id, type: "function", function: { name: "get_weather", arguments: "{}" } }] }, { role: "tool", tool_call_id: ctx.call.id, content: "17C" }];
  await ctx.s.begin(req(msgs));
  const p3 = FakeProc.last;
  assert.equal(p3.opts.conversationId, ctx.proc.initConversationId);
  assert.equal(p3.sent[0], '<tool_result name="get_weather">\n17C\n</tool_result>');
});

test("error result before any output fails the turn with a classified status", async () => {
  const { s } = makeSession();
  const it = await s.begin(req(user1));
  const proc = FakeProc.last;
  const p = drain(it);
  await tick();
  proc.result(U(0, 0), "ERROR", "RESOURCE_EXHAUSTED: quota");
  await assert.rejects(p, (e) => e.status === 429);
  assert.equal(classifyFailure("model x is not recognized as a known model").status, 400);
  assert.equal(classifyFailure("user is not logged in").status, 401);
  assert.equal(classifyFailure("weird").status, 502);
});

test("model / system prompt changes restart with --conversation; tools change notifies when possible", async () => {
  const { s, workspace } = makeSession();
  const run = async (r) => {
    const it = await s.begin(r);
    const p = FakeProc.last;
    const d = drain(it);
    await tick();
    p.text("ok", U(1, 1));
    p.result(U(1, 1));
    await d;
    return p;
  };
  const p1 = await run(req(user1));
  const msgs = (n) => [...user1, { role: "assistant", content: "ok" }, { role: "user", content: `again ${n}` }];
  const p2 = await run(req(msgs(1)));
  assert.equal(p2, p1, "same spec: same process");
  const p3 = await run(req(msgs(2), { model: "synthetic-other-low" }));
  assert.notEqual(p3, p1);
  assert.equal(p3.opts.model, "synthetic-other-low");
  assert.equal(p3.opts.conversationId, p1.initConversationId);
  workspace.agentChanged = true;
  const p4 = await run(req(msgs(3), { model: "synthetic-other-low", systemHash: "h1" }));
  assert.notEqual(p4, p3);
  // no hub -> list_changed impossible -> restart
  const p5 = await run(req(msgs(4), { model: "synthetic-other-low", systemHash: "h1", toolsHash: "t1" }));
  assert.notEqual(p5, p4);
});

test("failed resume (agy started a new conversation) injects the prior transcript", async () => {
  const store = new MemStore();
  store.update("s1", { conversation_id: "old-conv" });
  FakeProc.nextInitId = () => "brand-new";
  const { s } = makeSession({ store });
  const msgs = [...user1, { role: "assistant", content: "It is 17C." }, { role: "user", content: "and tomorrow?" }];
  await s.begin(req(msgs));
  const p = FakeProc.last;
  assert.equal(p.opts.conversationId, "old-conv");
  assert.match(p.sent[0], /<conversation_history>[\s\S]*User:\nweather in Paris\?[\s\S]*Assistant:\nIt is 17C\.[\s\S]*Latest message:\nand tomorrow\?$/);
  assert.equal(store.get("s1").conversation_id, "brand-new");
});

test("stale shim calls (old process generation) are rejected", async () => {
  const { s } = makeSession();
  await s.begin(req(user1));
  const stale = fakeConn(-1);
  s.onToolCall(stale, { rid: 1, name: "x", arguments: {} });
  assert.equal(stale.sent[0].result.isError, true);
});

test("ephemeral (title) sessions never resume and stop after the turn", async () => {
  const store = new MemStore();
  const { s } = makeSession({ store, ephemeral: true, key: "title_x" });
  const it = await s.begin(req([{ role: "user", content: "make a title" }]));
  const p = FakeProc.last;
  const d = drain(it);
  await tick();
  p.text("A Title", U(1, 1));
  p.result(U(1, 1));
  await d;
  await tick();
  assert.equal(p.killed, true);
  assert.equal(store.get("title_x"), undefined);
});

// ---- token economics -----------------------------------------------------------

test("a rewritten harness history (OpenCode compaction) starts a fresh agy conversation with a transcript", async () => {
  const { s, store } = makeSession();
  const p1 = drain(await s.begin(req(user1)));
  const proc1 = FakeProc.last;
  await tick();
  proc1.text("sunny", U(3000, 5));
  proc1.result(U(3000, 5));
  await p1;
  assert.equal(store.get("s1").conversation_id, proc1.initConversationId);
  // same history continued: same process, no transcript
  const p2 = drain(await s.begin(req([...user1, { role: "assistant", content: "sunny" }, { role: "user", content: "and tomorrow?" }])));
  assert.equal(FakeProc.last, proc1);
  assert.equal(proc1.sent.at(-1), "and tomorrow?");
  proc1.result(U(3100, 5));
  await p2;
  // compacted history: a summary replaces the first user message
  const compacted = [
    { role: "user", content: "Summary of earlier work: asked about Paris weather (sunny)." },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "what about Rome?" },
  ];
  const p3 = drain(await s.begin(req(compacted)));
  const proc2 = FakeProc.last;
  assert.notEqual(proc2, proc1);
  assert.equal(proc1.killed, true);
  assert.equal(proc2.opts.conversationId, "", "no --conversation: fresh conversation");
  assert.match(proc2.sent[0], /<conversation_history>[\s\S]*Summary of earlier work[\s\S]*Latest message:\nwhat about Rome\?$/);
  proc2.result(U(900, 5));
  await p3;
  assert.equal(store.get("s1").conversation_id, proc2.initConversationId);
});

test("rollover policy: past OPENCODE_AGY_ROLLOVER_TOKENS the next user turn starts fresh", async () => {
  process.env.OPENCODE_AGY_ROLLOVER_TOKENS = "20000";
  try {
    const { s } = makeSession();
    const p1 = drain(await s.begin(req(user1)));
    const proc1 = FakeProc.last;
    await tick();
    proc1.text("ok", { input_tokens: 5000, cache_read_tokens: 18000, output_tokens: 5 });
    proc1.result(U(5000, 5));
    await p1;
    assert.equal(s.lastPromptTokens, 23000);
    const p2 = drain(await s.begin(req([...user1, { role: "assistant", content: "ok" }, { role: "user", content: "next" }])));
    const proc2 = FakeProc.last;
    assert.notEqual(proc2, proc1);
    assert.equal(proc2.opts.conversationId, "");
    assert.match(proc2.sent[0], /<conversation_history>[\s\S]*weather in Paris\?[\s\S]*Latest message:\nnext$/);
    proc2.result(U(1000, 5));
    await p2;
  } finally {
    delete process.env.OPENCODE_AGY_ROLLOVER_TOKENS;
  }
});

test("a batch call parks as several tool_calls and resolves with one combined result", async () => {
  const { s } = makeSession();
  const r = req(user1, { batchTool: "batch", harnessNames: ["get_weather", "get_time"] });
  const it = await s.begin(r);
  const proc = FakeProc.last;
  const conn = fakeConn(proc.gen);
  const collecting = drain(it);
  await tick();
  s.onToolCall(conn, {
    rid: 9,
    mcpId: 5,
    name: "batch",
    arguments: { calls: [{ name: "get_weather", arguments: { city: "Paris" } }, { name: "get_time", arguments: {} }] },
  });
  proc.step({ state: "ACTIVE", step_type: "tool", tool_info: { name: "mcp_harness_batch" } });
  const items = await collecting;
  const calls = items.filter((i) => i.type === "tool_call");
  assert.deepEqual(calls.map((c) => [c.name, c.arguments]), [
    ["get_weather", '{"city":"Paris"}'],
    ["get_time", "{}"],
  ]);
  assert.deepEqual(s.pendingIds(), calls.map((c) => c.id));
  const msgs = [
    ...user1,
    { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
    { role: "tool", tool_call_id: calls[0].id, content: "sunny" },
    { role: "tool", tool_call_id: calls[1].id, content: "noon" },
  ];
  const p2 = drain(await s.begin({ ...r, messages: msgs }));
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].rid, 9);
  assert.equal(
    conn.sent[0].result.content[0].text,
    '<result index="1" tool="get_weather">\nsunny\n</result>\n<result index="2" tool="get_time">\nnoon\n</result>',
  );
  proc.result(U(3000, 5));
  await p2;
  assert.equal(FakeProc.all.length, 1, "same agy process throughout");
});

test("an invalid batch is answered to agy directly and never parks", async () => {
  const { s } = makeSession();
  await s.begin(req(user1, { batchTool: "batch", harnessNames: ["get_weather"] }));
  const proc = FakeProc.last;
  const conn = fakeConn(proc.gen);
  s.onToolCall(conn, { rid: 3, mcpId: 1, name: "batch", arguments: { calls: [] } });
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].result.isError, true);
  assert.equal(s.pending, null);
});

test("oversized tool results are truncated before they reach agy", async () => {
  process.env.OPENCODE_AGY_TOOL_OUTPUT_MAX = "1000";
  try {
    const { s, conn, call } = await parkedSession();
    const msgs = [
      ...user1,
      { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
      { role: "tool", tool_call_id: call.id, content: "y".repeat(5000) },
    ];
    await s.begin(req(msgs));
    const text = conn.sent[0].result.content[0].text;
    assert.ok(text.length < 1300);
    assert.match(text, /4000 characters of tool output omitted/);
  } finally {
    delete process.env.OPENCODE_AGY_TOOL_OUTPUT_MAX;
  }
});
