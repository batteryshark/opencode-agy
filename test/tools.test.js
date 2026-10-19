import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agyToolName,
  harnessToolName,
  openAIToolsToMcp,
  stableStringify,
  toInputSchema,
  toolResultToMcp,
  toolsHash,
} from "../src/tools.js";

const weather = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { city: { type: "string" }, opts: { type: "object", properties: { units: { type: "string" } } } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

test("converts OpenAI function tools to MCP tools with alwaysLoad meta", () => {
  const [t] = openAIToolsToMcp([weather]);
  assert.equal(t.name, "get_weather");
  assert.equal(t.description, "Get the weather");
  assert.deepEqual(t._meta, { "antigravity/alwaysLoad": true });
  assert.equal(t.inputSchema.type, "object");
  assert.equal(t.inputSchema.$schema, undefined, "$schema stripped");
  assert.deepEqual(t.inputSchema.required, ["city"]);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.equal(t.inputSchema.properties.opts.properties.units.type, "string");
});

test("missing/odd parameters become an empty object schema", () => {
  assert.deepEqual(toInputSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(toInputSchema({ type: "object" }), { type: "object", properties: {} });
  assert.equal(toInputSchema({ type: "string" }).type, "object");
});

test("skips non-function, nameless and duplicate tools; defaults description", () => {
  const tools = openAIToolsToMcp([
    { type: "web_search" },
    { type: "function", function: { name: "" } },
    { type: "function", function: { name: "read" } },
    { type: "function", function: { name: "read", description: "dup" } },
    null,
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].description, "read");
  assert.deepEqual(openAIToolsToMcp(undefined), []);
});

test("tools hash is order-of-keys independent but content sensitive", () => {
  const a = openAIToolsToMcp([weather]);
  const b = JSON.parse(JSON.stringify(a));
  b[0] = Object.fromEntries(Object.entries(b[0]).reverse());
  assert.equal(toolsHash(a), toolsHash(b));
  b[0].description = "changed";
  assert.notEqual(toolsHash(a), toolsHash(b));
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("agy tool name mapping", () => {
  assert.equal(agyToolName("read"), "mcp_harness_read");
  assert.equal(harnessToolName("mcp_harness_read"), "read");
  assert.equal(harnessToolName("view_file"), null);
});

test("tool result -> MCP content", () => {
  assert.deepEqual(toolResultToMcp("hi"), { content: [{ type: "text", text: "hi" }], isError: false });
  assert.deepEqual(toolResultToMcp("", true), { content: [{ type: "text", text: "(no output)" }], isError: true });
});
