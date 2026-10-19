#!/usr/bin/env node
/**
 * opencode-agy serve [--port N]   start the OpenAI-compatible endpoint
 * opencode-agy models             list models (from `agy models`)
 * opencode-agy doctor             check agy is installed and logged in
 * opencode-agy sync-config        sync OpenCode's agy models from the bridge
 */
import { accessSync, constants } from "node:fs";
import { config, DEFAULT_PORT, STRIPPED_ENV_KEYS } from "../src/config.js";
import { runAgyModels } from "../src/models.js";
import { startServer } from "../src/server.js";
import { syncConfig } from "../src/sync-config.js";

const USAGE = `usage:
  opencode-agy serve [--port N]   start the endpoint on 127.0.0.1 (default ${DEFAULT_PORT}, env OPENCODE_AGY_PORT)
  opencode-agy models             list models available to agy
  opencode-agy doctor             check that agy is installed and logged in
  opencode-agy sync-config [--dry-run] [--config PATH] [--url BASE_URL]
                                 sync only agy models; counts-only preview, backup on apply`;

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

async function serve(args) {
  const portArg = argValue(args, "--port");
  if (portArg !== undefined) {
    const n = Number(portArg);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      console.error(`invalid --port ${portArg}`);
      process.exit(2);
    }
    process.env.OPENCODE_AGY_PORT = String(n);
  }
  const app = await startServer({ port: config.port });
  console.log(`opencode-agy listening on http://127.0.0.1:${app.port}/v1`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function models() {
  const list = await runAgyModels();
  for (const m of list) console.log(`${m.id}\t${m.name}`);
}

async function sync(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") continue;
    if (["--config", "--url"].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`missing value for ${args[i]}`);
      i++;
    } else if (!/^--(?:config|url)=.+$/.test(args[i])) throw new Error("unknown sync-config argument");
  }
  const result = await syncConfig({
    path: argValue(args, "--config"), baseURL: argValue(args, "--url"),
    token: config.token, dryRun: args.includes("--dry-run"),
  });
  if (result.diff) process.stdout.write(result.diff);
  else console.log("agy models are already in sync");
  if (result.backup) console.log(`backup: ${result.backup}`);
  else if (result.changed) console.log("dry run: config unchanged; no backup created");
}

async function doctor() {
  let ok = true;
  const line = (good, msg) => {
    console.log(`${good ? "ok  " : "FAIL"} ${msg}`);
    if (!good) ok = false;
  };
  const [major] = process.versions.node.split(".").map(Number);
  line(major >= 22, `node ${process.versions.node} (need >= 22)`);
  try {
    accessSync(config.agyPath, constants.X_OK);
    line(true, `agy found at ${config.agyPath}`);
  } catch {
    line(false, `agy not executable at ${config.agyPath} (set OPENCODE_AGY_BIN)`);
    process.exit(1);
  }
  const present = STRIPPED_ENV_KEYS.filter((k) => process.env[k]);
  if (present.length) console.log(`note ${present.join(", ")} set in this shell; they are removed from agy's environment`);
  try {
    const list = await runAgyModels();
    line(list.length > 0, `agy is logged in: ${list.length} model(s) available`);
  } catch (err) {
    line(false, `${err.message}. Run \`agy\` once interactively to log in.`);
  }
  process.exit(ok ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "serve") await serve(rest);
  else if (cmd === "models") await models();
  else if (cmd === "doctor") await doctor();
  else if (cmd === "sync-config") await sync(rest);
  else {
    console.log(USAGE);
    process.exit(cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 2 : 0);
  }
} catch (err) {
  console.error(String(err?.message || err));
  process.exit(1);
}
