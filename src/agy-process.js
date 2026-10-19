/**
 * One resident `agy --input-format stream-json --output-format stream-json`
 * process. It keeps a single conversation across turns; each stdin line is a
 * user turn. stdout events and process exit are delivered to `onItem`.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { agyChildEnv, config } from "./config.js";
import { AGENT_NAME } from "./workspace.js";

export const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Staged compatibility contract: terminal model tiers override explicit effort. */
export function effortFor(model, effort) {
  if (typeof model === "string" && /-(low|medium|high|xhigh|max)$/i.test(model)) return "";
  return EFFORTS.has(effort) ? effort : "";
}

export function agyArgs({ model, effort, conversationId }) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--agent", AGENT_NAME];
  if (model) args.push("--model", model);
  const effectiveEffort = effortFor(model, effort);
  if (effectiveEffort) args.push("--effort", effectiveEffort);
  if (conversationId) args.push("--conversation", conversationId);
  args.push("--disable-slash-commands");
  return args;
}

export class AgyProcess {
  /**
   * @param {{cwd: string, model?: string, effort?: string, conversationId?: string,
   *          onItem: (item: any) => void, spawnImpl?: typeof spawn}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.exited = false;
    this.exitInfo = null;
    this.stderrTail = "";
    this.init = null;
    this._initWaiters = [];
    this._exitWaiters = [];
  }

  get pid() {
    return this.child?.pid ?? 0;
  }

  start() {
    const spawnImpl = this.opts.spawnImpl || spawn;
    const args = agyArgs(this.opts);
    this.child = spawnImpl(config.agyPath, args, {
      cwd: this.opts.cwd,
      env: agyChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so kill() also takes the shim down
    });
    this.child.stdin.on("error", () => {});
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      if (ev?.event === "result" && ev.result?.status && ev.result.status !== "SUCCESS" && ev.result.error) {
        this.resultError = String(ev.result.error);
      }
      if (ev?.event === "init" && !this.init) {
        this.init = ev;
        for (const w of this._initWaiters) w.resolve(ev);
        this._initWaiters = [];
      }
      this.opts.onItem({ src: "agy", ev });
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.on("error", (err) => this._onExit(null, null, err));
    this.child.on("exit", (code, signal) => this._onExit(code, signal, null));
    return this;
  }

  _onExit(code, signal, err) {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = {
      code,
      signal,
      error: err ? String(err.message || err) : "",
      resultError: this.resultError || "",
      stderr: this.stderrTail,
    };
    const failure = new Error(describeExit(this.exitInfo));
    for (const w of this._initWaiters) w.reject(failure);
    this._initWaiters = [];
    for (const w of this._exitWaiters) w(this.exitInfo);
    this._exitWaiters = [];
    this.opts.onItem({ src: "exit", info: this.exitInfo });
  }

  /** Resolves with the init event; rejects on exit or timeout. */
  waitInit(timeoutMs = config.initTimeoutMs) {
    if (this.init) return Promise.resolve(this.init);
    if (this.exited) return Promise.reject(new Error(describeExit(this.exitInfo)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agy did not start within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      timer.unref?.();
      this._initWaiters.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  sendUser(text) {
    if (this.exited || !this.child) throw new Error("agy process is not running");
    this.child.stdin.write(JSON.stringify({ event: "user", message: { content: text } }) + "\n");
  }

  waitExit() {
    if (this.exited) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => this._exitWaiters.push(resolve));
  }

  /** Terminate the process group; SIGKILL after a grace period. */
  async kill(graceMs = 2000) {
    if (!this.child || this.exited) return this.exitInfo;
    const pid = this.child.pid;
    const sig = (s) => {
      try {
        process.kill(-pid, s);
      } catch {
        try {
          this.child.kill(s);
        } catch {
          // gone
        }
      }
    };
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    sig("SIGTERM");
    const timer = setTimeout(() => sig("SIGKILL"), graceMs);
    timer.unref?.();
    const info = await this.waitExit();
    clearTimeout(timer);
    return info;
  }
}

export function describeExit(info) {
  if (!info) return "agy exited";
  const parts = [`agy exited (${info.signal ? `signal ${info.signal}` : `code ${info.code}`})`];
  if (info.error) parts.push(info.error);
  if (info.resultError) {
    parts.push(info.resultError.trim().split("\n")[0]);
  } else {
    const tail = (info.stderr || "").trim().split("\n").slice(-6).join("\n").trim();
    if (tail) parts.push(tail);
  }
  return parts.join(": ");
}
