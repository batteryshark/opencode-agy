/**
 * Persistent session bindings: key -> {conversation_id, workspace, model, ...}.
 * Written atomically (temp file + rename) so a crash never leaves torn JSON.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export class SessionStore {
  constructor(path = config.storePath) {
    this.path = path;
  }

  readAll() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  writeAll(store) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(key) {
    return this.readAll()[key];
  }

  /** Merge fields into an entry. */
  update(key, fields) {
    const store = this.readAll();
    store[key] = { ...(store[key] || {}), ...fields, key, updatedAt: Date.now() };
    this.writeAll(store);
    return store[key];
  }

  delete(key) {
    const store = this.readAll();
    if (!(key in store)) return;
    delete store[key];
    this.writeAll(store);
  }
}
