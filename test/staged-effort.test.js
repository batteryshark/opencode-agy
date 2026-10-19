/** Independently authored staging-policy checks; no vendor, listener or parking. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AgyProcess, agyArgs, effortFor } from "../src/agy-process.js";
import { normalizeEffort, normalizeModel } from "../src/server.js";
import { FakeProc } from "./helpers.js";
import { startMemoryApp } from "./memory-app.js";

const levels = ["low", "medium", "high", "xhigh", "max"];
const fixedArgs = ["--input-format", "stream-json", "--output-format", "stream-json", "--agent", "bridge"];

test("only the five terminal case-insensitive model tiers suppress all explicit effort", () => {
  for (const tier of levels) {
    for (const suffix of [tier, tier.toUpperCase()]) {
      for (const effort of [...levels, "", "minimal", "thinking", null, 4]) {
        const model = `synthetic-${suffix}`;
        assert.equal(effortFor(model, effort), "");
        assert.deepEqual(agyArgs({ model, effort, conversationId: "synthetic-conversation" }),
          [...fixedArgs, "--model", model, "--conversation", "synthetic-conversation", "--disable-slash-commands"]);
      }
    }
  }
  // No fabricated suffixes, partial matching, family inference, or clamping.
  for (const model of ["synthetic", "synthetic-minimal", "synthetic-thinking", "synthetic-reasoning",
    "synthetic-high-preview", "synthetic-highish", "synthetic_high", "high"]) {
    assert.equal(effortFor(model, "max"), "max");
    assert.deepEqual(agyArgs({ model, effort: "max" }),
      [...fixedArgs, "--model", model, "--effort", "max", "--disable-slash-commands"]);
  }
  for (const effort of ["", "none", "minimal", "HIGH", " high ", "ultra", false, 3, {}, null, undefined]) {
    assert.equal(agyArgs({ model: "synthetic", effort }).includes("--effort"), false,
      "the args layer accepts normalized supported values only");
  }
});

const cases = [
  [{}, ""],
  ...levels.map((level) => [{ reasoning_effort: ` ${level.toUpperCase()} ` }, level]),
  [{ reasoning_effort: " MINIMAL " }, "low"],
  ...["none", "", "  ", "thinking", "ultra", 4, false, {}, []].map((value) =>
    [{ reasoning_effort: value, reasoning: { effort: "max" }, effort: "high" }, ""]),
  [{ reasoning_effort: "low", reasoning: { effort: "max" }, effort: "high" }, "low"],
  [{ reasoning_effort: null, reasoning: { effort: " MEDIUM " }, effort: "high" }, "medium"],
  [{ reasoning: { effort: null }, effort: " XHIGH " }, "xhigh"],
  [{ reasoning: { effort: "minimal" } }, "low"],
  [{ effort: "none" }, ""],
];

function fixtureFactory() {
  const processes = [];
  const factory = (opts) => {
    const proc = new FakeProc(opts);
    proc.onUser = () => setImmediate(() => {
      const usage = { input_tokens: 10, output_tokens: 1 };
      proc.text("Synthetic answer.", usage);
      proc.result(usage);
    });
    processes.push(proc);
    return proc;
  };
  return { processes, factory };
}

const messages = (turn) => [
  { role: "user", content: "Synthetic initial request." },
  ...(turn ? [{ role: "assistant", content: "Synthetic answer." }, { role: "user", content: `Synthetic next ${turn}.` }] : []),
];
async function request(app, key, body) {
  const response = await app.request(`${app.base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", "x-session-id": key },
    body: JSON.stringify({ model: "synthetic", messages: messages(0), ...body }),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.choices[0].message.content, "Synthetic answer.");
  assert.equal(value.choices[0].finish_reason, "stop");
  return value;
}

test("request normalization keeps exact nullish precedence, aliases and rejection behavior", async () => {
  const { factory, processes } = fixtureFactory();
  const app = await startMemoryApp(factory);
  try {
    for (const [i, [body, expected]] of cases.entries()) {
      assert.equal(normalizeEffort(body), expected);
      await request(app, `normalization-${i}`, body);
      assert.equal(processes.at(-1).opts.effort, expected);
      assert.equal(app.pool.get(`normalization-${i}`).spec.effort, expected);
    }
  } finally { await app.close(); }
});

test("request model normalization is unchanged and tier effort is normalized before session binding", async () => {
  assert.equal(normalizeModel(" provider/nested/synthetic-high "), "synthetic-high");
  assert.equal(normalizeModel(12), "");
  const { factory, processes } = fixtureFactory();
  const app = await startMemoryApp(factory);
  try {
    for (const [i, tier] of levels.entries()) {
      const model = `synthetic-${tier.toUpperCase()}`;
      await request(app, `tier-${i}`, { model: ` provider/${model} `, reasoning_effort: "max" });
      assert.equal(processes.at(-1).opts.model, model);
      assert.equal(processes.at(-1).opts.effort, "");
      assert.equal(app.store.get(`tier-${i}`).effort, "");
    }
  } finally { await app.close(); }
});

test("tiered model ignores variant changes without restarting a resident session", async () => {
  const { factory, processes } = fixtureFactory();
  const app = await startMemoryApp(factory);
  try {
    for (const [turn, effort] of ["low", "max", "minimal", "none", "invalid"].entries()) {
      await request(app, "continuity", { model: "provider/synthetic-HIGH", reasoning_effort: effort, messages: messages(turn) });
      assert.equal(processes.length, 1);
      assert.equal(processes[0].killed, undefined);
      assert.equal(processes[0].opts.effort, "");
      assert.equal(app.pool.get("continuity").spec.effort, "");
      assert.equal(app.pool.get("continuity").state, "idle");
    }
    assert.equal(processes[0].sent.length, 5);
  } finally { await app.close(); }
});

test("unsuffixed effective effort and model changes still restart/resume; equivalent effort does not", async () => {
  const { factory, processes } = fixtureFactory();
  const app = await startMemoryApp(factory);
  try {
    await request(app, "restart", { reasoning_effort: "minimal" });
    await request(app, "restart", { reasoning: { effort: " LOW " }, messages: messages(1) });
    assert.equal(processes.length, 1);
    assert.equal(processes[0].opts.effort, "low");
    await request(app, "restart", { effort: "high", messages: messages(2) });
    assert.equal(processes.length, 2);
    assert.equal(processes[0].killed, true);
    assert.equal(processes[1].opts.effort, "high");
    assert.equal(processes[1].opts.conversationId, processes[0].initConversationId);
    await request(app, "restart", { model: "synthetic-max", effort: "low", messages: messages(3) });
    assert.equal(processes.length, 3);
    assert.equal(processes[1].killed, true);
    assert.equal(processes[2].opts.model, "synthetic-max");
    assert.equal(processes[2].opts.effort, "");
    assert.equal(processes[2].opts.conversationId, processes[1].initConversationId);
  } finally { await app.close(); }
});

test("AgyProcess uses exact generated args through an injected stream-only spawn mock", async () => {
  for (const [model, effort, expected] of [["synthetic-high", "max", ""], ["synthetic", "medium", "medium"]]) {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0 });
    let invocation;
    const items = [];
    const proc = new AgyProcess({ cwd: "/synthetic/workspace", model, effort, conversationId: "synthetic-resume",
      onItem: (item) => items.push(item),
      spawnImpl: (bin, args, options) => { invocation = { bin, args, options }; return child; },
    }).start();
    assert.equal(invocation.bin, process.env.OPENCODE_AGY_BIN);
    assert.deepEqual(invocation.args, [...fixedArgs, "--model", model,
      ...(expected ? ["--effort", expected] : []), "--conversation", "synthetic-resume", "--disable-slash-commands"]);
    assert.equal(invocation.options.cwd, "/synthetic/workspace");
    child.stdout.write(JSON.stringify({ event: "init", conversation_id: "synthetic-resume" }) + "\n");
    assert.equal((await proc.waitInit()).conversation_id, "synthetic-resume");
    child.stdout.end(); child.stderr.end(); child.stdin.end(); child.emit("exit", 0, null);
    assert.equal((await proc.waitExit()).code, 0);
    assert.deepEqual(items.map((item) => item.src), ["agy", "exit"]);
  }
});
