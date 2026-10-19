/**
 * Full-stack test: HTTP server + hub + real shim + real workspace files, with
 * test/fake-agy.js standing in for the agy binary (no network, no quota).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSSE, sseContent } from "./helpers.js";
import { workspaceDirName } from "../src/workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "agy-int-"));
const LOG = join(TMP, "spawns.jsonl");
Object.assign(process.env, {
  OPENCODE_AGY_BIN: join(HERE, "fake-agy.js"),
  XDG_CACHE_HOME: join(TMP, "cache"),
  XDG_DATA_HOME: join(TMP, "data"),
  OPENCODE_AGY_LOG_LEVEL: "silent",
  OPENCODE_AGY_MAX_PROCS: "2",
  OPENCODE_AGY_TOKEN: "test-token-not-secret",
  FAKE_AGY_LOG: LOG,
  GEMINI_API_KEY: "should-be-stripped",
  GOOGLE_API_KEY: "should-be-stripped",
});
const { startServer } = await import("../src/server.js");

let app;
let base;
before(async () => {
  app = await startServer({ port: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  await app.close();
});

const auth = { authorization: "Bearer test-token-not-secret" };
const weatherTool = {
  type: "function",
  function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
};

async function chat(session, messages, { stream = true, tools = [weatherTool], model = "fake-model", headers = {}, signal } = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth, ...(session ? { "x-opencode-session-id": session } : {}), ...headers },
    body: JSON.stringify({
      model,
      stream,
      tools,
      messages: [{ role: "system", content: "You are opencode.\nWorking directory: /Users/me/project" }, ...messages],
    }),
    signal,
  });
  const text = await res.text();
  return { res, text, chunks: stream && res.status === 200 ? parseSSE(text) : [], json: !stream || res.status !== 200 ? JSON.parse(text) : null };
}

const spawns = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const health = async () => (await fetch(`${base}/health`, { headers: auth })).json();

test("auth: bearer token required on /v1", async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 401);
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
});

test("park on a real shim tools/call, resume with the tool result, same agy process", async () => {
  const u = [{ role: "user", content: 'CALL get_weather {"city":"Paris"}' }];
  const r1 = await chat("int-park", u);
  assert.equal(r1.res.status, 200);
  const tc = r1.chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(tc[0].function.arguments), { city: "Paris" });
  assert.equal(r1.chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.equal(r1.chunks.at(-1).usage.prompt_tokens, 3000);
  const pid1 = (await health()).sessions.find((s) => s.key === "int-park").pid;

  const r2 = await chat("int-park", [
    ...u,
    { role: "assistant", content: null, tool_calls: [{ id: tc[0].id, type: "function", function: tc[0].function }] },
    { role: "tool", tool_call_id: tc[0].id, content: "17C and drizzle" },
  ]);
  assert.equal(sseContent(r2.chunks), "tool said: 17C and drizzle");
  assert.equal(r2.chunks.at(-1).choices[0].finish_reason, "stop");
  const s = (await health()).sessions.find((x) => x.key === "int-park");
  assert.equal(s.pid, pid1);
  assert.equal(s.state, "idle");

  // workspace files
  const ws = join(process.env.XDG_CACHE_HOME, "opencode-agy", "sessions", workspaceDirName("int-park"));
  const md = readFileSync(join(ws, ".agents", "agents", "bridge.md"), "utf8");
  assert.match(md, /^---\nname: bridge\n[\s\S]*tools: \[\]\nmainAgent: true\nsubagent: false\ninheritMcp: true\nexcludeDefaultComponents: true\n---\n/);
  assert.match(md, /You are opencode\./);
  assert.match(md, /real project directory is `\/Users\/me\/project`/);
  const mcp = JSON.parse(readFileSync(join(ws, ".agents", "mcp_config.json"), "utf8"));
  assert.equal(mcp.mcpServers.harness.timeoutSeconds, -1);
  assert.ok(existsSync(join(ws, ".git")));
  assert.ok(JSON.parse(readFileSync(join(ws, ".agents", "hooks.json"), "utf8"))["opencode-agy-gate"]);
  // credential env stripped
  const sp = spawns().find((x) => x.cwd.endsWith(workspaceDirName("int-park")));
  assert.deepEqual(sp.env, { GEMINI_API_KEY: null, GOOGLE_API_KEY: null, GOOGLE_GENAI_API_KEY: null });
  assert.ok(sp.argv.includes("--disable-slash-commands"));
  assert.deepEqual(sp.argv.slice(sp.argv.indexOf("--agent"), sp.argv.indexOf("--agent") + 2), ["--agent", "bridge"]);
});

test("tool set change is applied via notifications/tools/list_changed without a restart", async () => {
  const before = spawns().length;
  await chat("int-tools", [{ role: "user", content: "TOOLS" }]);
  const extra = { type: "function", function: { name: "get_time", parameters: { type: "object", properties: {} } } };
  const r = await chat("int-tools", [{ role: "user", content: "TOOLS" }, { role: "assistant", content: "x" }, { role: "user", content: "TOOLS again" }], { tools: [weatherTool, extra] });
  assert.equal(sseContent(r.chunks), "tools: get_weather,get_time");
  assert.equal(spawns().length, before + 1, "only the first request spawned");
});

test("batch meta-tool: one agy call becomes parallel tool_calls, results come back combined", async () => {
  process.env.OPENCODE_AGY_BATCH = "1";
  const timeTool = { type: "function", function: { name: "get_time", description: "time", parameters: { type: "object", properties: { tz: { type: "string" } } } } };
  const u = [{ role: "user", content: 'CALL batch {"calls":[{"name":"get_weather","arguments":{"city":"Paris"}},{"name":"get_time","arguments":{"tz":"UTC"}}]}' }];
  const r1 = await chat("int-batch", u, { tools: [weatherTool, timeTool] });
  const tc = r1.chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
  assert.deepEqual(tc.map((t) => [t.index, t.function.name, JSON.parse(t.function.arguments)]), [
    [0, "get_weather", { city: "Paris" }],
    [1, "get_time", { tz: "UTC" }],
  ]);
  assert.equal(r1.chunks.at(-1).choices[0].finish_reason, "tool_calls");
  // a retry without results re-emits both calls
  const again = await chat("int-batch", u, { tools: [weatherTool, timeTool] });
  assert.deepEqual(again.chunks.flatMap((c) => c.choices[0].delta.tool_calls || []).map((t) => t.id), tc.map((t) => t.id));
  const big = "x".repeat(50_000);
  const r2 = await chat(
    "int-batch",
    [
      ...u,
      { role: "assistant", content: null, tool_calls: tc.map((t) => ({ id: t.id, type: "function", function: t.function })) },
      { role: "tool", tool_call_id: tc[0].id, content: "rainy" },
      { role: "tool", tool_call_id: tc[1].id, content: big },
    ],
    { tools: [weatherTool, timeTool] },
  );
  const text = sseContent(r2.chunks);
  assert.match(text, /^tool said: <result index="1" tool="get_weather">\nrainy\n<\/result>\n<result index="2" tool="get_time">\nx+/);
  assert.match(text, /characters of tool output omitted by opencode-agy/);
  assert.ok(text.length < 45_000, "the 50k result was truncated to OPENCODE_AGY_TOOL_OUTPUT_MAX");
  delete process.env.OPENCODE_AGY_BATCH;
});

test("batch with an unknown tool is rejected back to agy without reaching the harness", async () => {
  process.env.OPENCODE_AGY_BATCH = "1";
  const r = await chat("int-batch-bad", [{ role: "user", content: 'CALL batch {"calls":[{"name":"rm_rf","arguments":{}}]}' }], {
    tools: [weatherTool, { type: "function", function: { name: "get_time", parameters: { type: "object", properties: {} } } }],
  });
  assert.equal(r.chunks.flatMap((c) => c.choices[0].delta.tool_calls || []).length, 0);
  assert.match(sseContent(r.chunks), /^tool error: batch call 1: unknown tool "rm_rf"/);
  delete process.env.OPENCODE_AGY_BATCH;
});

test("non-streaming completion", async () => {
  const r = await chat("int-ns", [{ role: "user", content: "hello" }], { stream: false });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.object, "chat.completion");
  assert.equal(r.json.choices[0].message.content, "echo: hello");
  assert.equal(r.json.usage.prompt_tokens, 3000);
  assert.equal(r.json.usage.completion_tokens_details.reasoning_tokens, 5);
});

test("turns that die before output are real HTTP errors, not fake 200s", async () => {
  const crash = await chat("int-crash", [{ role: "user", content: "CRASH" }]);
  assert.equal(crash.res.status, 502);
  assert.match(crash.json.error.message, /agy exited \(code 3\)/);
  const quota = await chat("int-quota", [{ role: "user", content: "QUOTA" }]);
  assert.equal(quota.res.status, 429);
  assert.equal(quota.json.error.type, "rate_limit_error");
  const bad = await chat("int-bad", [{ role: "user", content: "hi" }], { model: "bad-model" });
  assert.equal(bad.res.status, 400);
  assert.match(bad.json.error.message, /invalid model selection/);
});

test("client abort kills the session's agy process", async () => {
  const ac = new AbortController();
  const p = chat("int-abort", [{ role: "user", content: "STALL" }], { signal: ac.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await health()).sessions.find((s) => s.key === "int-abort").alive, true);
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 300));
  const s = (await health()).sessions.find((x) => x.key === "int-abort");
  assert.equal(s.alive, false);
});

test("process cap evicts the least recently used idle process", async () => {
  // cap is 2; int-tools and int-ns may still be alive -> new sessions evict idle ones
  await chat("int-lru-a", [{ role: "user", content: "a" }]);
  await chat("int-lru-b", [{ role: "user", content: "b" }]);
  await chat("int-lru-c", [{ role: "user", content: "c" }]);
  const h = await health();
  assert.ok(h.live_processes <= 2);
  const alive = h.sessions.filter((s) => s.alive).map((s) => s.key).sort();
  assert.deepEqual(alive, ["int-lru-b", "int-lru-c"]);
  // the evicted session resumes its conversation on demand
  const convA = h.sessions.find((s) => s.key === "int-lru-a").conversation_id;
  await chat("int-lru-a", [{ role: "user", content: "a" }, { role: "assistant", content: "echo: a" }, { role: "user", content: "a2" }]);
  const sp = spawns().filter((x) => x.cwd.endsWith(workspaceDirName("int-lru-a"))).at(-1);
  assert.equal(sp.argv[sp.argv.indexOf("--conversation") + 1], convA);
});

test("title requests run as ephemeral sessions with no tools", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth, "x-opencode-session-id": "int-park" },
    body: JSON.stringify({ model: "fake-model", stream: false, messages: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "TOOLS" }] }),
  });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, "tools: ");
  const h = await health();
  const t = h.sessions.find((s) => s.key === "title_int-park");
  assert.equal(t.ephemeral, true);
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal((await health()).sessions.find((s) => s.key === "title_int-park").alive, false);
});

test("models endpoint proxies `agy models` output", async () => {
  const r = await fetch(`${base}/v1/models`, { headers: auth });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, "list");
  assert.deepEqual(j.data.map((m) => m.id), ["fake-model", "bad-model"]);
});
