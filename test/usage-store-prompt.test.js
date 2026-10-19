import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTranscript,
  collectToolResults,
  conversationKeyFromMessages,
  detectMetaKind,
  extractCwd,
  lastUserFingerprint,
  priorMessages,
  systemPromptOf,
  tailMessages,
  tailToUserText,
  toolCallNames,
  unsentTail,
  withHistory,
} from "../src/prompt.js";
import { SessionStore } from "../src/session-store.js";
import { UsageTracker, addUsage, subUsage, toOpenAIUsage } from "../src/usage.js";

const U = (i, o, t = 0, c = 0) => ({ input_tokens: i, output_tokens: o, thinking_tokens: t, cache_read_tokens: c });

// ---- usage -------------------------------------------------------------------

test("usage add/sub clamp", () => {
  assert.deepEqual(addUsage(U(1, 2), U(3, 4, 1)), U(4, 6, 1));
  assert.deepEqual(subUsage(U(1, 2), U(3, 1)), U(0, 1));
});

test("parked responses report step usage; final reports the rest of the cumulative delta", () => {
  const u = new UsageTracker();
  // turn 1 (fresh process, no baseline): step, park, step, result
  u.addStep(U(3000, 30));
  assert.deepEqual(u.takeParked(), U(3000, 30));
  u.addStep(U(3100, 40));
  assert.deepEqual(u.takeFinal({ ...U(6100, 70), total_tokens: 6170 }), U(3100, 40));
  // turn 2: cumulative delta is authoritative (includes a step we never saw)
  u.addStep(U(3200, 10));
  assert.deepEqual(u.takeFinal(U(6100 + 6500, 70 + 25)), U(6500, 25));
});

test("fresh process whose cumulative counter starts at the resumed total uses step sums", () => {
  const u = new UsageTracker();
  u.addStep(U(3000, 10));
  // cumulative includes earlier conversation turns; no baseline -> trust steps
  assert.deepEqual(u.takeFinal(U(50_000, 900)), U(3000, 10));
  u.addStep(U(3100, 5));
  assert.deepEqual(u.takeFinal(U(53_100, 905)), U(3100, 5));
});

test("OpenAI usage mapping counts cache reads as prompt tokens and thinking as reasoning", () => {
  assert.deepEqual(toOpenAIUsage(U(7413, 3565, 3240, 21687)), {
    prompt_tokens: 29100,
    completion_tokens: 3565,
    total_tokens: 32665,
    prompt_tokens_details: { cached_tokens: 21687 },
    completion_tokens_details: { reasoning_tokens: 3240 },
  });
});

// ---- session store -------------------------------------------------------------

test("session store merges entries and writes atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-store-"));
  const path = join(dir, "nested", "sessions.json");
  const s = new SessionStore(path);
  assert.equal(s.get("k"), undefined);
  s.update("k", { conversation_id: "c1", model: "m" });
  s.update("k", { toolsHash: "t" });
  s.update("other", { conversation_id: "c2" });
  const e = s.get("k");
  assert.equal(e.conversation_id, "c1");
  assert.equal(e.toolsHash, "t");
  assert.equal(e.key, "k");
  assert.ok(e.updatedAt > 0);
  s.delete("other");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["k"]);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["sessions.json"], "no temp files left behind");
});

test("session store tolerates corrupt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-store-"));
  const path = join(dir, "sessions.json");
  const s = new SessionStore(path);
  s.writeAll({ a: 1 });
  writeFileSync(path, "{not json");
  assert.deepEqual(s.readAll(), {});
});

// ---- prompt helpers ------------------------------------------------------------

const convo = [
  { role: "system", content: "You are opencode.\nWorking directory: /Users/me/proj\nPlatform: darwin" },
  { role: "developer", content: [{ type: "text", text: "Be terse." }] },
  { role: "user", content: "read a.txt" },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
  { role: "tool", tool_call_id: "call_1", content: "hello" },
];

test("system prompt, cwd and tail extraction", () => {
  assert.equal(systemPromptOf(convo), "You are opencode.\nWorking directory: /Users/me/proj\nPlatform: darwin\n\nBe terse.");
  assert.equal(extractCwd(systemPromptOf(convo)), "/Users/me/proj");
  assert.deepEqual(tailMessages(convo).map((m) => m.role), ["tool"]);
  assert.equal(priorMessages(convo).length, 4);
  assert.equal(collectToolResults(convo).get("call_1"), "hello");
  assert.equal(toolCallNames(convo).get("call_1"), "read");
  assert.equal(tailToUserText(tailMessages(convo), toolCallNames(convo)), '<tool_result name="read">\nhello\n</tool_result>');
});

test("tail of a plain new user turn is its text; attachments become notes", () => {
  const msgs = [...convo, { role: "assistant", content: "done" }, { role: "user", content: [{ type: "text", text: "next" }, { type: "image_url", image_url: { url: "data:x" } }] }];
  const text = tailToUserText(tailMessages(msgs));
  assert.match(text, /^next\n\[image_url attachment omitted/);
});

test("unsentTail skips user messages agy already received", () => {
  const msgs = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
  assert.deepEqual(unsentTail(msgs, "").map((m) => m.content), ["a", "b"]);
  const fpA = lastUserFingerprint(msgs.slice(0, 1));
  assert.deepEqual(unsentTail(msgs, fpA).map((m) => m.content), ["b"]);
  assert.deepEqual(unsentTail(msgs, "nope").map((m) => m.content), ["a", "b"]);
});

test("fingerprint changes with a new user message, not with tool results", () => {
  const a = lastUserFingerprint(convo);
  assert.equal(a, lastUserFingerprint([...convo, { role: "tool", tool_call_id: "x", content: "y" }]));
  assert.notEqual(a, lastUserFingerprint([...convo, { role: "user", content: "read a.txt" }]));
});

test("transcript keeps newest messages within budget", () => {
  const t = buildTranscript(convo, 10_000);
  assert.match(t, /^User:\nread a\.txt/);
  assert.match(t, /\[called tool read\(/);
  assert.match(t, /Tool result \(call_1\):\nhello/);
  const small = buildTranscript(convo, 40);
  assert.match(small, /earlier message\(s\) omitted/);
  assert.equal(buildTranscript(convo, 0), "");
  assert.match(withHistory("now", t), /<conversation_history>[\s\S]*Latest message:\nnow$/);
});

test("meta request detection and fallback key", () => {
  assert.equal(detectMetaKind([{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "x" }]), "title");
  assert.equal(detectMetaKind([{ role: "user", content: "Create a detailed summary for continuing this coding session" }]), "summary");
  assert.equal(detectMetaKind(convo), null);
  assert.equal(conversationKeyFromMessages(convo), conversationKeyFromMessages([...convo, { role: "user", content: "more" }]));
  assert.match(conversationKeyFromMessages(convo), /^conv_[0-9a-f]{12}$/);
});
