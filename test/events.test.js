import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mapAgyEvent, parseNdjson } from "../src/events.js";
import { parseSSE, replayFactory, sseContent } from "./helpers.js";
import { startMemoryApp } from "./memory-app.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (f) => parseNdjson(readFileSync(join(FIX, f), "utf8"));

test("maps synthetic agy events (run2: two MCP tool steps, streamed answer)", () => {
  const mapped = load("run2.jsonl").flatMap(mapAgyEvent);
  const kinds = mapped.map((m) => m.kind);
  assert.equal(kinds[0], "init");
  assert.equal(mapped[0].conversationId, "00000000-0000-4000-8000-000000000002");
  assert.equal(kinds.at(-1), "result");
  const text = mapped.filter((m) => m.kind === "text").map((m) => m.text).join("");
  assert.equal(text, mapped.at(-1).response, "text deltas reassemble the final response");
  const toolSteps = mapped.filter((m) => m.kind === "tool_step");
  assert.deepEqual(
    toolSteps.map((t) => [t.name, t.state]),
    [
      ["mcp_magic_get_magic_word", "ACTIVE"],
      ["mcp_magic_get_magic_word", "DONE"],
      ["mcp_magic_slow_magic_word", "ACTIVE"],
      ["mcp_magic_slow_magic_word", "DONE"],
    ],
  );
  const steps = mapped.filter((m) => m.kind === "step_usage");
  assert.equal(steps.length, 3);
  const sum = steps.reduce((a, s) => a + s.usage.input_tokens, 0);
  assert.equal(sum, mapped.at(-1).usage.input_tokens, "per-step usage sums to the cumulative result");
});

test("maps a tool error step (run11: 180s MCP timeout)", () => {
  const mapped = load("run11.jsonl").flatMap(mapAgyEvent);
  const err = mapped.find((m) => m.kind === "tool_step" && m.state === "ERROR");
  assert.match(err.error, /timed out after 3m0s/);
  assert.equal(mapped.at(-1).status, "SUCCESS");
});

test("maps error results and error_message steps", () => {
  assert.deepEqual(mapAgyEvent({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "invalid model" } })[0], {
    kind: "result",
    conversationId: "",
    status: "ERROR",
    response: "",
    error: "invalid model",
    usage: null,
    numTurns: 0,
  });
  const [e] = mapAgyEvent({ event: "step_update", step_update: { state: "ERROR", step_type: "error_message", text_delta: "quota exceeded" } });
  assert.deepEqual(e, { kind: "step_error", text: "quota exceeded" });
  assert.deepEqual(mapAgyEvent({ event: "something_new" }), []);
  assert.deepEqual(mapAgyEvent(null), []);
});

for (const fixture of ["run2.jsonl", "run3.jsonl", "run5.jsonl", "run11.jsonl"]) {
  test(`SSE translation reproduces agy's response for ${fixture}`, async () => {
    const events = load(fixture);
    const results = events.filter((e) => e.event === "result");
    const app = await startMemoryApp(replayFactory(join(FIX, fixture)));
    try {
      let prevCum = { input_tokens: 0, output_tokens: 0 };
      for (let turn = 0; turn < results.length; turn++) {
        const res = await app.request(`${app.base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-session-id": `fx-${fixture}` },
          body: JSON.stringify({
            model: "synthetic-model-low",
            stream: true,
            messages: [
              { role: "user", content: "first" },
              ...(turn ? [{ role: "assistant", content: "x" }, { role: "user", content: `turn ${turn}` }] : []),
            ],
          }),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/event-stream/);
        const chunks = parseSSE(await res.text());
        assert.equal(chunks[0].choices[0].delta.role, "assistant");
        assert.equal(sseContent(chunks), results[turn].result.response);
        const last = chunks.at(-1);
        assert.equal(last.choices[0].finish_reason, "stop");
        const cum = results[turn].result.usage;
        // first turn of a fresh process: step sums; later turns: cumulative delta
        assert.equal(last.usage.completion_tokens, cum.output_tokens - prevCum.output_tokens);
        assert.equal(last.usage.prompt_tokens, cum.input_tokens - prevCum.input_tokens);
        prevCum = cum;
      }
    } finally {
      await app.close();
    }
  });
}
