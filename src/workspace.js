/**
 * Per-session agy workspace: ~/.cache/opencode-agy/sessions/workspace-v2-sha256-<digest>/
 *
 *   .git/                       stops agy's upward search for .agents/
 *   .agents/agents/bridge.md    tools: [] main agent; body = harness system prompt
 *   .agents/mcp_config.json     the stdio shim, timeoutSeconds -1
 *   .agents/hooks.json          PreToolUse gate denying everything but our tools
 *
 * Workspace files are local; agy still uses its own global settings and login.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config, MCP_SERVER_NAME } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHIM_PATH = join(HERE, "shim.js");
export const GATE_PATH = join(HERE, "gate.js");
export const AGENT_NAME = "bridge";

/** Hash the complete exact string, including distinct unpaired UTF-16 surrogates. */
export function workspaceDirName(key) {
  if (typeof key !== "string") throw new TypeError("Workspace key must be a string");
  // Well-formed JSON escapes lone surrogates instead of UTF-8 replacement.
  // 84 characters: disjoint from every legacy sanitized name (at most 80).
  return "workspace-v2-sha256-" + createHash("sha256").update(JSON.stringify(key), "utf8").digest("hex");
}

function workspacePath(key, baseDir) {
  if (typeof baseDir !== "string" || !baseDir || baseDir.includes("\0")) {
    throw new TypeError("Sessions root must be a nonempty path string");
  }
  const root = resolve(baseDir);
  const dir = resolve(root, workspaceDirName(key));
  const child = relative(root, dir);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(".." + sep) || child.includes(sep)) {
    throw new Error("Workspace must be a strict direct child of sessions root");
  }
  return dir;
}

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

// Inspect every existing component, including root ancestors and dangling links.
// The sessions tree must be private to the operator, not concurrently mutated
// by untrusted local writers (portable Node has no openat directory handles).
function checkPath(path, file = false) {
  const parent = dirname(path);
  if (parent !== path) checkPath(parent);
  const st = statIfPresent(path);
  if (st && (st.isSymbolicLink() || (file ? !st.isFile() || st.nlink !== 1 : !st.isDirectory()))) {
    throw new Error("Unsafe workspace path component");
  }
  return st;
}

function ensureDirectory(path) {
  if (checkPath(path)) return;
  const parent = dirname(path);
  if (parent !== path) ensureDirectory(parent);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  checkPath(path);
}

function checkWorkspace(dir) {
  checkPath(dir);
  checkPath(join(dir, ".git"));
  for (const name of ["agents/bridge.md", "hooks.json", "mcp_config.json"]) {
    checkPath(join(dir, ".agents", name), true);
  }
}

export function bridgeAgentMarkdown({ systemPrompt, cwd, workspace, batch = false, excludeDefaults = config.excludeDefaults }) {
  const rules = [
    "# Bridge rules (opencode-agy)",
    `- Your only tools are the \`mcp_${MCP_SERVER_NAME}_*\` tools. They are executed by the user's harness, not by you. ` +
      `The instructions above refer to them without that prefix: a tool called \`read\` there is \`mcp_${MCP_SERVER_NAME}_read\` here.`,
    "- Use only those tools. Do not claim to have run commands or edited files unless a tool call did it.",
    cwd
      ? `- The user's real project directory is \`${cwd}\`. Resolve relative paths against it and pass absolute paths under it to tools.`
      : "- Use the project directory named in the instructions above for all file paths.",
    `- Your own process working directory (\`${workspace}\`) is a private scratch area of the bridge. Never read, write or mention it.`,
    batch
      ? "- Only one tool call runs per step, and every step resends the whole conversation. When you need several independent calls " +
        "(for example reading or searching several files), make them all in one call to the batch tool: " +
        '`{"calls":[{"name":"read","arguments":{...}},{"name":"grep","arguments":{...}}]}`. Its results come back together, in order. ' +
        "Make separate calls only when one call needs another's result."
      : "- When you need several independent tool calls, issue them together in the same step instead of one call per step.",
  ]
    .filter(Boolean)
    .join("\n");
  const body = [systemPrompt?.trim(), rules].filter(Boolean).join("\n\n");
  return [
    "---",
    `name: ${AGENT_NAME}`,
    "description: OpenAI-compatible bridge agent (opencode-agy); uses only harness-provided MCP tools.",
    "tools: []",
    "mainAgent: true",
    "subagent: false",
    "inheritMcp: true",
    ...(excludeDefaults ? ["excludeDefaultComponents: true"] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export function mcpConfigJson({ socketPath, sessionKey, gen = 0 }) {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: process.execPath,
            args: [SHIM_PATH],
            env: { OPENCODE_AGY_SOCKET: socketPath, OPENCODE_AGY_SESSION: sessionKey, OPENCODE_AGY_GEN: String(gen) },
            timeoutSeconds: config.mcpTimeoutSeconds,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function hooksJson() {
  return (
    JSON.stringify(
      {
        "opencode-agy-gate": {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(GATE_PATH)}`, timeout: 10 }],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Write `content` only if it differs; returns true when the file changed. */
function writeIfChanged(path, content) {
  checkPath(path, true);
  ensureDirectory(dirname(path));
  checkPath(path, true);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("Unsafe workspace file");
    if (readFileSync(fd, "utf8") === content) return false;
    ftruncateSync(fd, 0);
    // readFileSync advanced the descriptor offset; write at the start explicitly.
    const bytes = Buffer.from(content, "utf8");
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error("Workspace write made no progress");
      offset += written;
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Create/refresh the workspace. Returns {dir, agentChanged}. agentChanged
 * means bridge.md was (re)written, which a live process will not pick up.
 * The MCP config is written separately at spawn time (writeMcpConfig) because
 * it carries the process generation the shim reports back.
 */
export function prepareWorkspace({ key, systemPrompt, cwd, batch = config.batch, baseDir = config.sessionsDir }) {
  const dir = workspacePath(key, baseDir);
  checkWorkspace(dir);
  ensureDirectory(dir);
  if (!checkPath(join(dir, ".git"))) {
    const r = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    if (r.status !== 0) ensureDirectory(join(dir, ".git")); // marker fallback
  }
  checkWorkspace(dir);
  const agentsDir = join(dir, ".agents");
  const agentChanged = writeIfChanged(
    join(agentsDir, "agents", `${AGENT_NAME}.md`),
    bridgeAgentMarkdown({ systemPrompt, cwd, workspace: dir, batch }),
  );
  if (config.gateHook) writeIfChanged(join(agentsDir, "hooks.json"), hooksJson());
  else writeIfChanged(join(agentsDir, "hooks.json"), "{}\n");
  return { dir, agentChanged };
}

/** Write .agents/mcp_config.json for the next agy spawn. */
export function writeMcpConfig({ dir, socketPath, key, gen, baseDir = config.sessionsDir }) {
  const expected = workspacePath(key, baseDir);
  if (dir !== expected) throw new Error("MCP workspace does not match key and sessions root");
  checkWorkspace(expected);
  writeIfChanged(join(dir, ".agents", "mcp_config.json"), mcpConfigJson({ socketPath, sessionKey: key, gen }));
}
