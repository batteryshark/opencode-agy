/** Explicit, single-provider model sync. No server lifecycle or model turns. */
import { copyFileSync, constants, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Public GPT-OSS config: max_position_embeddings = 131072.
// https://huggingface.co/openai/gpt-oss-120b/blob/b5c939de8f754692c1647ca79fbf85e8c1e70f8a/config.json
// 32768 is our conservative configured output cap, not a vendor maximum.
const LIMITS = [[/^gpt-oss-120b-medium$/, { context: 131072, output: 32768 }]];

export function defaultConfigPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function generateModels(data, existing, { legacy = false } = {}) {
  if (!Array.isArray(data) || data.length === 0) throw new Error("bridge returned no models; refusing to clear the config");
  const models = {};
  for (const model of data) {
    const id = model?.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || Object.hasOwn(models, id)) {
      throw new Error("invalid or duplicate bridge model id");
    }
    if (Object.hasOwn(existing, id)) {
      models[id] = existing[id];
      continue;
    }
    const limit = LIMITS.find(([pattern]) => pattern.test(id))?.[1];
    if (!limit) throw new Error("no public limit mapping; add an explicit model entry with verified limits before syncing");
    if (typeof model.name !== "string" || !model.name.trim()) throw new Error("missing bridge model name");
    const name = model.name.replace(/ \((Low|Medium|High)\)$/, " $1");
    models[id] = {
      name: `${name} (agy)`,
      ...(legacy ? { tool_call: true } : { capabilities: { tools: true, input: ["text"], output: ["text"] } }),
      limit: { ...limit },
    };
  }
  return Object.fromEntries([
    ...Object.keys(existing).filter((id) => Object.hasOwn(models, id)),
    ...Object.keys(models).filter((id) => !Object.hasOwn(existing, id)),
  ].map((id) => [id, models[id]]));
}

/** Locate one value in validated strict JSON without reformatting its surroundings. */
function valueSpan(text, target) {
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)];
  let i = 0;
  let found;
  const entries = new Map();
  function visit(path) {
    const start = tokens[i].index;
    const token = tokens[i++][0];
    if (token === "{") {
      const keys = new Set();
      while (tokens[i][0] !== "}") {
        const key = JSON.parse(tokens[i++][0]);
        if (keys.has(key)) throw new Error("duplicate config key; refusing ambiguous config");
        keys.add(key);
        i++;
        visit([...path, key]);
        if (tokens[i][0] === ",") i++;
      }
      i++;
    } else if (token === "[") {
      let index = 0;
      while (tokens[i][0] !== "]") {
        visit([...path, index++]);
        if (tokens[i][0] === ",") i++;
      }
      i++;
    }
    const end = tokens[i - 1].index + tokens[i - 1][0].length;
    if (JSON.stringify(path) === JSON.stringify(target)) found = [start, end];
    if (path.length === target.length + 1 && target.every((key, index) => path[index] === key)) {
      entries.set(path.at(-1), text.slice(start, end));
    }
  }
  visit([]);
  if (!found) throw new Error("agy models block not found");
  return { span: found, entries };
}

function parseConfig(text) {
  let config;
  try { config = JSON.parse(text); }
  catch { throw new Error("sync-config requires strict JSON (JSONC is not rewritten)"); }
  if (!isObject(config)) throw new Error("config must be an object");
  const layouts = ["providers", "provider"].filter((key) => {
    if (!Object.hasOwn(config, key)) return false;
    if (!isObject(config[key])) throw new Error(`${key} must be an object`);
    return Object.hasOwn(config[key], "agy");
  });
  if (layouts.length !== 1) throw new Error("configure exactly one providers.agy (V2) or provider.agy (legacy) block");
  const root = layouts[0];
  const legacy = root === "provider";
  const block = config[root].agy;
  const settingsKey = legacy ? "options" : "settings";
  if (!isObject(block) || !isObject(block.models) || !isObject(block[settingsKey]) || Object.hasOwn(block, legacy ? "settings" : "options")) {
    throw new Error(`configure ${root}.agy.models and ${root}.agy.${settingsKey} as objects; mixed AGY layouts are refused`);
  }
  for (const entry of Object.values(block.models)) if (!isObject(entry)) throw new Error("existing model entries must be objects");
  const baseURL = block[settingsKey].baseURL;
  if (baseURL !== undefined && (typeof baseURL !== "string" || !baseURL.trim())) throw new Error("baseURL must be a nonempty string");
  return { existing: block.models, legacy, baseURL, ...valueSpan(text, [root, "agy", "models"]) };
}

export function updateConfig(text, data) {
  const { existing, legacy, entries, span: [start, end] } = parseConfig(text);
  const models = generateModels(data, existing, { legacy });
  // Retained values are never serialized: JSON Numbers need not fit JS Numbers.
  const ids = Object.keys(models);
  if (ids.length === entries.size && ids.every((id) => entries.has(id))) return text;
  const line = text.slice(text.lastIndexOf("\n", start) + 1, start);
  const indent = /^\s*/.exec(line)[0];
  const unit = indent.includes("\t") ? "\t" : "  ";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const replacement = ids.length ? `{${newline}${ids.map((id) => {
    const value = entries.has(id) ? entries.get(id) : JSON.stringify(models[id], null, unit).replace(/\n/g, `${newline}${indent}${unit}`);
    return `${indent}${unit}${JSON.stringify(id)}: ${value}`;
  }).join(`,${newline}`)}${newline}${indent}}` : "{}";
  return text.slice(0, start) + replacement + text.slice(end);
}

/** Counts only: never expose config values, model IDs or paths in the preview. */
export function configDiff(before, after) {
  if (before === after) return "";
  const oldIDs = parseConfig(before).entries;
  const newIDs = parseConfig(after).entries;
  const retained = [...newIDs.keys()].filter((id) => oldIDs.has(id)).length;
  return `agy models: ${newIDs.size - retained} added, ${oldIDs.size - retained} removed, ${retained} retained (values omitted)\n`;
}

export async function syncConfig({ path = defaultConfigPath(), baseURL, token = "", dryRun = false } = {}) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("config must be a regular single-link file (symlinks are not rewritten)");
  const before = readFileSync(path, "utf8");
  const selected = parseConfig(before);
  let url;
  try { url = new URL(`${(baseURL || selected.baseURL || "http://127.0.0.1:4517/v1").replace(/\/$/, "")}/models`); }
  catch { throw new Error("invalid bridge URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("bridge URL must use HTTP or HTTPS");
  let response;
  try {
    response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error("bridge /models fetch failed (including redirect or timeout refusal)"); }
  if (!response.ok) throw new Error(`bridge /models returned HTTP ${response.status}`);
  let inventory;
  try { inventory = (await response.json()).data; }
  catch { throw new Error("invalid bridge /models JSON response"); }
  const after = updateConfig(before, inventory);
  const diff = configDiff(before, after);
  if (dryRun || !diff) return { diff, backup: null, changed: Boolean(diff) };
  const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID().slice(0, 8)}.bak`;
  const temp = `${path}.${randomUUID()}.tmp`;
  if (readFileSync(path, "utf8") !== before) throw new Error("config changed during sync; retry after reviewing it");
  copyFileSync(path, backup, constants.COPYFILE_EXCL);
  try {
    writeFileSync(temp, after, { flag: "wx", mode: stat.mode & 0o777 });
    if (readFileSync(path, "utf8") !== before) throw new Error("config changed during sync; refusing to overwrite it");
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  return { diff, backup, changed: true };
}
