/** Token trimming: system prompt compaction, tool minification, batch parsing, output truncation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capText,
  collapseWhitespace,
  compactSystemPrompt,
  compactToolDescription,
  dedupeParagraphs,
  filterTools,
  firstSentence,
  minifyMcpTools,
  truncateToolOutput,
} from "../src/compact.js";
import { extractCwd } from "../src/prompt.js";
import { combineBatchResults, parseBatch } from "../src/session.js";
import { exposedTools } from "../src/tools.js";
import { bridgeAgentMarkdown } from "../src/workspace.js";

const OC_PROMPT = `You are an AI agent running in OpenCode.

# Harness
- Prefer parallelizing independent tool calls.



# Your Model
- Name: synthetic-model-low
- Provider ID: agy
# Code Mode

## Available tools

- opencode (1 tools) // Tools for managing OpenCode itself.
  - tools.opencode.models({
  /** Text to search for in model names and IDs. */
  query?: string,
  /** Maximum number of models to return. @integer */
  limit?: number,
}): Promise<{
  providers: Array<{
      id: string,
      models: Array<{ id: string }>,
    }>,
  next: number | null,
}> // Search the models available to use.

Use the skill tool to load a skill when a task matches its description.

<available_skills>
  <skill>
    <id>pdf</id>
    <name>pdf</name>
    <description>Use this skill whenever the user wants to do anything with PDF files. This includes reading, merging and splitting.</description>
  </skill>
  <skill>
    <id>xlsx</id>
    <name>xlsx</name>
    <description>Use this skill any time a spreadsheet file is the primary input or output. Trigger especially when...</description>
  </skill>
</available_skills>

Use the skill tool to load a skill when a task matches its description.

Here is some useful information about the environment you are running in:
<env>
  Working directory: /Users/me/project
  Workspace root folder: /Users/me/project
  Is directory a git repo: yes
  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created.
</env>
When you create a worktree outside the current working directory and intend to use it, call session_move.`;

test("firstSentence and capText cut on sentence/word boundaries", () => {
  assert.equal(firstSentence("Read a file. Then more."), "Read a file.");
  assert.equal(firstSentence("no period here"), "no period here");
  assert.equal(firstSentence("word ".repeat(50), 30).endsWith("…"), true);
  assert.ok(firstSentence("word ".repeat(50), 30).length <= 31);
  assert.equal(capText("One. Two. Three.", 10), "One. Two.");
  assert.equal(capText("short", 100), "short");
});

test("compactSystemPrompt level 1 keeps instructions, trims catalogs and boilerplate", () => {
  const out = compactSystemPrompt(OC_PROMPT, 1);
  assert.ok(out.length < OC_PROMPT.length * 0.75, `${out.length} vs ${OC_PROMPT.length}`);
  assert.match(out, /Prefer parallelizing independent tool calls\./);
  // skills: one line each, first sentence
  assert.match(out, /<available_skills>\n- pdf: Use this skill whenever the user wants to do anything with PDF files\.\n- xlsx: /);
  assert.doesNotMatch(out, /This includes reading/);
  // code-mode signatures: no JSDoc, no result shapes, params kept
  assert.doesNotMatch(out, /\/\*\*/);
  assert.match(out, /query\?: string,/);
  assert.match(out, /\}\): Promise<object> \/\/ Search the models/);
  // dropped: model section, boilerplate lines, duplicate paragraph
  assert.doesNotMatch(out, /Your Model|Provider ID/);
  assert.doesNotMatch(out, /Workspace root folder|generic system temporary|create a worktree/);
  assert.equal(out.match(/Use the skill tool to load a skill/g).length, 1);
  assert.doesNotMatch(out, /\n{3,}/);
  // the project directory survives (and is still extractable)
  assert.equal(extractCwd(out), "/Users/me/project");
  // deterministic
  assert.equal(compactSystemPrompt(OC_PROMPT, 1), out);
});

test("compactSystemPrompt level 2 keeps skill ids only; level 0 is a no-op", () => {
  const out = compactSystemPrompt(OC_PROMPT, 2);
  assert.match(out, /<available_skills>\n- pdf\n- xlsx\n<\/available_skills>/);
  assert.equal(compactSystemPrompt(OC_PROMPT, 0), OC_PROMPT);
  assert.equal(compactSystemPrompt("", 1), "");
});

test("collapseWhitespace and dedupeParagraphs", () => {
  assert.equal(collapseWhitespace("a  b   \n\n\n\n    c\td"), "a b\n\n  c\td");
  const p = "A paragraph that is long enough to be deduplicated.";
  assert.equal(dedupeParagraphs(`${p}\n\nshort\n\nshort\n\n${p}`), `${p}\n\nshort\n\nshort`);
});

test("compactToolDescription keeps catalog items and caps prose", () => {
  const desc = `Spawns an agent. ${"More prose here. ".repeat(40)}\n\nAvailable subagents:\n- explore: Fast agent for codebases. Use it when you need to find files.\n- general: General-purpose agent. Long text.`;
  const out = compactToolDescription(desc, 120);
  assert.ok(out.length < desc.length / 3);
  assert.match(out, /^Spawns an agent\./);
  assert.match(out, /\n- explore: Fast agent for codebases\.\n- general: General-purpose agent\.$/);
});

test("minifyMcpTools drops schema noise, shortens descriptions, keeps names/types/required/enums", () => {
  const tools = [
    {
      name: "edit",
      description: "Edit a file.   Second sentence.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        $schema: "x",
        properties: {
          path: { type: "string", description: "File to edit. Must be absolute.", default: "x" },
          mode: { type: "string", enum: ["a", "b"], title: "Mode" },
          title: { type: "string" },
        },
        required: ["path"],
      },
      _meta: { "antigravity/alwaysLoad": true },
    },
  ];
  const [t] = minifyMcpTools(tools, { descMax: 400, propDescMax: 100 });
  assert.deepEqual(t.inputSchema, {
    type: "object",
    properties: { path: { type: "string", description: "File to edit." }, mode: { type: "string", enum: ["a", "b"] }, title: { type: "string" } },
    required: ["path"],
  });
  assert.equal(t.description, "Edit a file. Second sentence.");
  assert.deepEqual(t._meta, { "antigravity/alwaysLoad": true });
  assert.ok(JSON.stringify(t).length < JSON.stringify(tools[0]).length);
});

test("filterTools applies allow and deny lists", () => {
  const tools = ["read", "edit", "question", "websearch"].map((name) => ({ name }));
  assert.deepEqual(filterTools(tools, { deny: ["question", "websearch"] }).map((t) => t.name), ["read", "edit"]);
  assert.deepEqual(filterTools(tools, { allow: ["read"] }).map((t) => t.name), ["read"]);
  assert.equal(filterTools(tools, {}).length, 4);
});

test("exposedTools adds the batch meta-tool (enum of harness tools) and avoids name clashes", () => {
  const fn = (name) => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } });
  const a = exposedTools([fn("read"), fn("grep")], { batch: true, batchMax: 5 });
  assert.equal(a.batchTool, "batch");
  assert.deepEqual(a.harnessNames, ["read", "grep"]);
  const b = a.tools.at(-1);
  assert.equal(b.name, "batch");
  assert.deepEqual(b.inputSchema.properties.calls.items.properties.name.enum, ["read", "grep"]);
  assert.equal(b.inputSchema.properties.calls.maxItems, 5);
  assert.deepEqual(b._meta, { "antigravity/alwaysLoad": true });
  assert.equal(exposedTools([fn("batch"), fn("read")], { batch: true }).batchTool, "batch_tools");
  assert.equal(exposedTools([fn("read")], { batch: false }).batchTool, "");
  assert.equal(exposedTools([], { batch: true }).tools.length, 0);
  const d = exposedTools([fn("read"), fn("question")], { batch: true, deny: ["question"] });
  assert.deepEqual(d.harnessNames, ["read"]);
});

test("parseBatch validates calls and normalizes arguments", () => {
  const ok = parseBatch({ calls: [{ name: "read", arguments: { path: "a" } }, { name: "mcp_harness_grep", arguments: '{"pattern":"x"}' }] }, ["read", "grep"]);
  assert.deepEqual(ok.calls, [
    { name: "read", arguments: '{"path":"a"}' },
    { name: "grep", arguments: '{"pattern":"x"}' },
  ]);
  assert.deepEqual(parseBatch({ calls: '[{"name":"read","args":{"path":"b"}}]' }, ["read"]).calls, [{ name: "read", arguments: '{"path":"b"}' }]);
  assert.deepEqual(parseBatch({ calls: [{ name: "read", arguments: { path: "c", toolSummary: "Read c" } }] }, ["read"]).calls, [{ name: "read", arguments: '{"path":"c"}' }]);
  assert.match(parseBatch({}, ["read"]).error, /non-empty "calls"/);
  assert.match(parseBatch({ calls: [{ name: "batch", arguments: {} }] }, ["read"]).error, /unknown tool "batch"/);
  assert.match(parseBatch({ calls: [{ name: "read", arguments: [1] }] }, ["read"]).error, /JSON object/);
  assert.match(parseBatch({ calls: Array(3).fill({ name: "read", arguments: {} }) }, ["read"], 2).error, /at most 2/);
});

test("combineBatchResults keeps order, marks missing results, truncates each", () => {
  const subs = [
    { id: "a", name: "read" },
    { id: "b", name: "grep" },
    { id: "c", name: "read" },
  ];
  const out = combineBatchResults(subs, new Map([["a", "one"], ["c", "z".repeat(500)]]), 100);
  assert.match(out, /^<result index="1" tool="read">\none\n<\/result>\n<result index="2" tool="grep">\n\(the harness returned no result for this call\)\n<\/result>\n<result index="3" tool="read">\nz+/);
  assert.match(out, /400 characters of tool output omitted/);
});

test("truncateToolOutput keeps head and tail", () => {
  const t = "H".repeat(1000) + "T".repeat(1000);
  const out = truncateToolOutput(t, 100);
  assert.ok(out.startsWith("H".repeat(70)));
  assert.ok(out.endsWith("T".repeat(30)));
  assert.match(out, /1900 characters of tool output omitted/);
  assert.equal(truncateToolOutput("short", 100), "short");
  assert.equal(truncateToolOutput(t, 0), t);
});

test("bridge.md: excludeDefaultComponents and the batch rule are stable across tool sets", () => {
  const a = bridgeAgentMarkdown({ systemPrompt: "sys", cwd: "/p", workspace: "/w", batch: true, excludeDefaults: true });
  assert.match(a, /inheritMcp: true\nexcludeDefaultComponents: true\n---/);
  assert.match(a, /make them all in one call to the batch tool/);
  const b = bridgeAgentMarkdown({ systemPrompt: "sys", cwd: "/p", workspace: "/w", batch: false, excludeDefaults: false });
  assert.doesNotMatch(b, /excludeDefaultComponents|batch tool/);
  assert.match(b, /issue them together in the same step/);
  // system prompt first, bridge rules after: the stable prefix the backend can cache
  assert.ok(a.indexOf("sys") < a.indexOf("# Bridge rules"));
});
