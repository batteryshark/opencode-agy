/**
 * Session registry with a cap on live agy processes. When the cap is hit,
 * the least recently used idle session's process is stopped (its conversation
 * resumes later with --conversation). Parked sessions are evicted only when no
 * idle one exists; running turns are never evicted.
 */
import { config } from "./config.js";
import { log } from "./log.js";
import { Session, TurnError } from "./session.js";

export class Pool {
  constructor({ store, hub = null, sessionFactory } = {}) {
    this.store = store;
    this.hub = hub;
    this.sessions = new Map();
    this.sessionFactory = sessionFactory || ((opts) => new Session(opts));
  }

  get(key, { ephemeral = false } = {}) {
    let s = this.sessions.get(key);
    if (!s) {
      s = this.sessionFactory({ key, store: this.store, hub: this.hub, pool: this, ephemeral });
      this.sessions.set(key, s);
    }
    return s;
  }

  find(key) {
    return this.sessions.get(key);
  }

  liveCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.alive) n++;
    return n;
  }

  /** Make room for `except` to spawn a process. */
  async ensureCapacity(except) {
    const max = config.maxProcesses;
    while (this.liveCount() >= max) {
      const candidates = [...this.sessions.values()].filter((s) => s !== except && s.alive && !s.consumerActive);
      const idle = candidates.filter((s) => s.state === "idle").sort((a, b) => a.lastUsed - b.lastUsed);
      const parked = candidates.filter((s) => s.state === "parked").sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = idle[0] || parked[0];
      if (!victim) {
        throw new TurnError(`All ${max} agy processes are busy with running turns; retry shortly.`, {
          status: 503,
          code: "agy_busy",
        });
      }
      log.info("evicting LRU agy process", { key: victim.key, state: victim.state });
      await victim.stopProcess("evicted (process cap)");
    }
  }

  async shutdown() {
    await Promise.all([...this.sessions.values()].map((s) => s.stopProcess("shutdown").catch(() => {})));
  }

  stats() {
    return [...this.sessions.values()].map((s) => ({
      key: s.key,
      state: s.state,
      alive: s.alive,
      pid: s.proc?.pid || null,
      model: s.spec?.model || null,
      conversation_id: s.conversationId || null,
      ephemeral: s.ephemeral,
      idle_ms: Date.now() - s.lastUsed,
    }));
  }
}
