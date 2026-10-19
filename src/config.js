/**
 * Runtime configuration. Everything is read from the environment at call time
 * so tests (and operators) can tune limits without a rebuild.
 */
import { homedir } from "node:os";
import { join } from "node:path";

function num(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function list(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const DEFAULT_PORT = 4517;
export const SSE_HEARTBEAT_MS = 5_000;
/** Name of the MCP server inside agy. The model sees tools as mcp_<server>_<tool>. */
export const MCP_SERVER_NAME = "harness";
/** Credential overrides removed from agy's env so it only uses its own login. */
export const STRIPPED_ENV_KEYS = Object.freeze([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
]);

export const config = {
  get agyPath() {
    return process.env.OPENCODE_AGY_BIN || join(homedir(), ".local", "bin", "agy");
  },
  get port() {
    return num("OPENCODE_AGY_PORT", DEFAULT_PORT, 0);
  },
  get token() {
    return process.env.OPENCODE_AGY_TOKEN || "";
  },
  get cacheDir() {
    const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(base, "opencode-agy");
  },
  get sessionsDir() {
    return join(this.cacheDir, "sessions");
  },
  get dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "opencode-agy");
  },
  get storePath() {
    return join(this.dataDir, "sessions.json");
  },
  /** Max silence on agy stdout during an active turn (paused while parked). */
  get stallMs() {
    return num("OPENCODE_AGY_STALL_MS", 600_000, 1_000);
  },
  /** How long a parked tool call may wait for the harness before agy gets an error. */
  get parkMs() {
    return num("OPENCODE_AGY_PARK_MS", 30 * 60_000, 1_000);
  },
  /** How long to wait for agy's init event after spawning. */
  get initTimeoutMs() {
    return num("OPENCODE_AGY_INIT_TIMEOUT_MS", 60_000, 1_000);
  },
  get maxProcesses() {
    return num("OPENCODE_AGY_MAX_PROCS", 6, 1);
  },
  /** Cap for prior-conversation transcripts injected into a fresh conversation. */
  get historyMaxChars() {
    return num("OPENCODE_AGY_HISTORY_MAX_CHARS", 200_000, 0);
  },
  /** -1 = no MCP timeout inside agy (verified past 180s in the spike). */
  get mcpTimeoutSeconds() {
    return num("OPENCODE_AGY_MCP_TIMEOUT_S", -1, -1);
  },
  /** Install the deny-all-builtins PreToolUse hook (defense in depth). */
  get gateHook() {
    return process.env.OPENCODE_AGY_GATE_HOOK !== "0";
  },
  /** Fixed project directory override (otherwise taken from the request). */
  get cwdOverride() {
    return process.env.OPENCODE_AGY_CWD || "";
  },
  /**
   * How to apply a changed tool set to a live process: "notify" sends
   * notifications/tools/list_changed and waits for agy to re-list (falling
   * back to a restart if it doesn't); "restart" always restarts with
   * --conversation.
   */
  get toolsChangeMode() {
    return process.env.OPENCODE_AGY_TOOLS_CHANGE === "restart" ? "restart" : "notify";
  },
  // ---- prompt and tool size controls ---------------------------------------
  /** Add `excludeDefaultComponents: true` to bridge.md to omit vendor default prompt sections. */
  get excludeDefaults() {
    return process.env.OPENCODE_AGY_EXCLUDE_DEFAULTS !== "0";
  },
  /** 0 = pass the harness system prompt through, 1 = safe compaction, 2 = aggressive. */
  get compactPrompt() {
    const v = process.env.OPENCODE_AGY_COMPACT_PROMPT;
    if (v === "0" || v === "off" || v === "false") return 0;
    if (v === "2" || v === "aggressive") return 2;
    return 1;
  },
  /** Minify tool schemas/descriptions in tools/list. */
  get minifyTools() {
    return process.env.OPENCODE_AGY_MINIFY_TOOLS !== "0";
  },
  /** Max chars kept of each tool description when minifying. */
  get toolDescMax() {
    return num("OPENCODE_AGY_TOOL_DESC_MAX", 400, 40);
  },
  /** Only expose these harness tools (comma-separated names; empty = all). */
  get toolsAllow() {
    return list(process.env.OPENCODE_AGY_TOOLS_ALLOW);
  },
  /** Never expose these harness tools (comma-separated names). */
  get toolsDeny() {
    return list(process.env.OPENCODE_AGY_TOOLS_DENY);
  },
  /**
   * Offer the `batch` meta-tool (several harness calls in one model step).
   * Off by default: agy already runs a model step's parallel function calls
   * without re-prompting, so batch mostly adds ~350 tokens of schema per step.
   */
  get batch() {
    const v = process.env.OPENCODE_AGY_BATCH;
    return v === "1" || v === "true";
  },
  /** Max calls accepted in one batch. */
  get batchMax() {
    return num("OPENCODE_AGY_BATCH_MAX", 8, 1);
  },
  /** Truncate each tool result handed to agy to this many chars (0 = never). */
  get toolOutputMax() {
    return num("OPENCODE_AGY_TOOL_OUTPUT_MAX", 40_000, 0);
  },
  /**
   * Start a fresh agy conversation (with a transferred, capped transcript) at
   * the next user turn once a step's prompt exceeded this many tokens. 0 = off.
   */
  get rolloverTokens() {
    return num("OPENCODE_AGY_ROLLOVER_TOKENS", 0, 0);
  },
  get modelsCacheMs() {
    return num("OPENCODE_AGY_MODELS_CACHE_MS", 10 * 60_000, 0);
  },
};

/** Environment for the agy child: inherit, minus credential overrides. */
export function agyChildEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}
