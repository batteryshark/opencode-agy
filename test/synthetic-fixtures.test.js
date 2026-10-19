import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapAgyEvent, parseNdjson } from "../src/events.js";

for (const [run, rows, turns] of [[2,12,1],[3,8,1],[5,12,2],[11,8,1]]) {
  test(`synthetic run${run}: exact identity, response, shapes and cumulative usage`, () => {
    const events = parseNdjson(readFileSync(new URL(`./fixtures/run${run}.jsonl`, import.meta.url), "utf8"));
    const cid = `00000000-0000-4000-8000-${String(run).padStart(12,"0")}`;
    assert.equal(events.length, rows);
    assert.equal(events[0].conversation_id, cid);
    assert.equal(events[0].init.cwd, "/synthetic/workspace");
    const results = events.filter((e) => e.event === "result");
    assert.equal(results.length, turns);
    let text = "";
    let turn = 0;
    let input = 0;
    let output = 0;
    for (const event of events) {
      if (event.step_update) {
        assert.equal(event.step_update.conversation_id, cid);
        assert.equal(typeof event.step_update.step_index, "number");
      }
      for (const item of mapAgyEvent(event)) {
        if (item.kind === "text") text += item.text;
        if (item.kind === "step_usage") {
          input += item.usage.input_tokens;
          output += item.usage.output_tokens;
        }
        if (item.kind === "result") {
          turn++;
          assert.equal(item.conversationId, cid);
          assert.equal(item.status, "SUCCESS");
          assert.equal(item.numTurns, turn);
          assert.equal(item.response, `Synthetic run ${run}, turn ${turn}: complete.`);
          assert.equal(text, item.response);
          assert.equal(item.usage.input_tokens, input);
          assert.equal(item.usage.output_tokens, output);
          assert.equal(item.usage.total_tokens, input + output);
          text = "";
        }
      }
    }
    if (run === 11) {
      const tool = events.find((e) => e.step_update?.state === "ERROR").step_update;
      assert.equal(tool.tool_info.error.type, "timeout");
      assert.equal(tool.tool_info.error.message, "Synthetic tool timed out after 3m0s");
      assert.equal(mapAgyEvent({event:"step_update",step_update:tool})[0].state,"ERROR");
    }
  });
}
