#!/usr/bin/env node
/**
 * agy PreToolUse hook (defense in depth). The bridge agent has `tools: []`,
 * so built-ins should never be offered; if one is attempted anyway, deny it.
 * Only the harness MCP tools (mcp_harness_*) are allowed.
 */
import { MCP_SERVER_NAME } from "./config.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let name = "";
  try {
    const payload = JSON.parse(raw);
    name = String(payload?.toolCall?.name ?? payload?.tool_name ?? "");
  } catch {
    // unparseable -> deny
  }
  const ok = name.startsWith(`mcp_${MCP_SERVER_NAME}_`);
  process.stdout.write(
    JSON.stringify(
      ok
        ? { decision: "allow" }
        : {
            decision: "deny",
            reason: `Built-in tools are disabled in this bridge. Use only the mcp_${MCP_SERVER_NAME}_* tools.`,
          },
    ) + "\n",
  );
});
