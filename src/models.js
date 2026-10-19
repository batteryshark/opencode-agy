/** `agy models` -> [{id, name}], cached. Never touches credentials. */
import { execFile } from "node:child_process";
import { agyChildEnv, config } from "./config.js";

let cache = null; // {at, models}

export function parseModels(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    const m = /^([a-z0-9][a-z0-9._-]*)\t+(.+?)\s*$/i.exec(line);
    if (m) out.push({ id: m[1], name: m[2] });
  }
  return out;
}

export function runAgyModels({ timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.agyPath, ["models"], { env: agyChildEnv(), timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ");
        reject(new Error(`agy models failed: ${err.code === "ENOENT" ? `${config.agyPath} not found` : err.message}${detail ? ` (${detail})` : ""}`));
        return;
      }
      resolve(parseModels(stdout));
    });
  });
}

export async function listModels({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < config.modelsCacheMs) return cache.models;
  const models = await runAgyModels();
  cache = { at: Date.now(), models };
  return models;
}

export function clearModelsCache() {
  cache = null;
}
