/**
 * OpenAI function tools <-> MCP tools.
 *
 * agy only exposes MCP tools directly to the model (as mcp_<server>_<tool>)
 * when their tools/list entry carries _meta["antigravity/alwaysLoad"] = true;
 * otherwise they hide behind on-demand schema loading via a built-in tool the
 * bridge agent does not have.
 */
import { createHash } from "node:crypto";
import { filterTools, minifyMcpTools } from "./compact.js";
import { MCP_SERVER_NAME } from "./config.js";

export const ALWAYS_LOAD_META = Object.freeze({ "antigravity/alwaysLoad": true });

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Recursively drop JSON-Schema keys that are noise for a tool declaration. */
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!isObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    out[key] = cleanSchema(value);
  }
  return out;
}

/** OpenAI `parameters` -> MCP `inputSchema` (always a type:"object" schema). */
export function toInputSchema(parameters) {
  const schema = isObject(parameters) ? cleanSchema(parameters) : {};
  if (schema.type !== "object") {
    return { type: "object", properties: {}, ...schema, type: "object" };
  }
  if (!isObject(schema.properties)) schema.properties = {};
  return schema;
}

/**
 * Convert an OpenAI `tools` array into MCP tools/list entries. Non-function
 * tools and nameless entries are skipped; duplicate names keep the first.
 */
export function openAIToolsToMcp(tools) {
  if (!Array.isArray(tools)) return [];
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    if (tool.type !== undefined && tool.type !== "function") continue;
    const fn = isObject(tool.function) ? tool.function : null;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof fn.description === "string" && fn.description ? fn.description : name,
      inputSchema: toInputSchema(fn.parameters),
      _meta: { ...ALWAYS_LOAD_META },
    });
  }
  return out;
}

/** Stable JSON (sorted keys) so hashes don't depend on key order. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha(text, len = 16) {
  return createHash("sha256").update(text).digest("hex").slice(0, len);
}

export function toolsHash(mcpTools) {
  return sha(stableStringify(mcpTools));
}

/** The name agy shows the model for one of our tools. */
export function agyToolName(name) {
  return `mcp_${MCP_SERVER_NAME}_${name}`;
}

/** Inverse of agyToolName; null for tools that are not ours (built-ins). */
export function harnessToolName(agyName) {
  const prefix = `mcp_${MCP_SERVER_NAME}_`;
  return typeof agyName === "string" && agyName.startsWith(prefix)
    ? agyName.slice(prefix.length)
    : null;
}

/** MCP tools/call result content -> plain text for agy, from an OpenAI tool message. */
export function toolResultToMcp(text, isError = false) {
  return {
    content: [{ type: "text", text: typeof text === "string" && text ? text : "(no output)" }],
    isError: !!isError,
  };
}

// ---- what agy actually sees -------------------------------------------------

/** Name for the batch meta-tool that does not collide with a harness tool. */
export function batchToolName(mcpTools) {
  const names = new Set((mcpTools || []).map((t) => t.name));
  for (const n of ["batch", "batch_tools", "opencode_agy_batch"]) if (!names.has(n)) return n;
  return "";
}

/** MCP entry for the batch meta-tool over `mcpTools`. */
export function batchToolEntry(name, mcpTools, max = 8) {
  return {
    name,
    description:
      "Run several independent tool calls in one step (each step resends the whole conversation, so this saves tokens). " +
      "Each entry names one of the other tools and its arguments; results come back together, in order. " +
      "Use it whenever calls do not depend on each other's results.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: max,
          items: {
            type: "object",
            properties: {
              name: { type: "string", enum: mcpTools.map((t) => t.name) },
              arguments: { type: "object", description: "Arguments for that tool, as its own schema defines them." },
            },
            required: ["name", "arguments"],
          },
        },
      },
      required: ["calls"],
    },
    _meta: { ...ALWAYS_LOAD_META },
  };
}

/**
 * The tool set exposed to agy for one request: harness tools filtered by
 * allow/deny, optionally minified, plus the batch meta-tool. Returns
 * {tools, batchTool, harnessNames} where harnessNames are the callable
 * harness tools (batch excluded).
 */
export function exposedTools(openAITools, { allow = [], deny = [], minify = false, descMax = 400, batch = false, batchMax = 8 } = {}) {
  let tools = filterTools(openAIToolsToMcp(openAITools), { allow, deny });
  if (minify) tools = minifyMcpTools(tools, { descMax });
  const batchTool = batch && tools.length > 0 ? batchToolName(tools) : "";
  const harnessNames = tools.map((t) => t.name);
  if (batchTool) tools = [...tools, batchToolEntry(batchTool, tools, batchMax)];
  return { tools, batchTool, harnessNames };
}
