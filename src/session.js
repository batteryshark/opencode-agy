/**
 * One harness conversation <-> one resident agy process (respawned with
 * --conversation when needed).
 *
 * States:
 *   idle     no turn in flight (process may or may not be alive)
 *   running  a turn is in flight and a consumer is reading agy's stdout
 *   parked   agy is blocked inside an MCP tools/call waiting for the harness
 *
 * Parking mirrors opencode-claude's bridge pool: when the shim reports a
 * tools/call, the current HTTP response ends with finish_reason "tool_calls"
 * while agy keeps waiting. The next request's role:"tool" message resolves
 * the call and the same agy stdout is read into the new response.
 */
import { randomUUID } from "node:crypto";
import { AgyProcess, describeExit } from "./agy-process.js";
import { config } from "./config.js";
import { mapAgyEvent } from "./events.js";
import { log } from "./log.js";
import {
  buildTranscript,
  collectToolResults,
  lastUserFingerprint,
  priorMessages,
  tailToUserText,
  unsentTail,
  toolCallNames,
  withHistory,
} from "./prompt.js";
import { AsyncQueue, TIMEOUT } from "./queue.js";
import { truncateToolOutput } from "./compact.js";
import { harnessToolName, toolResultToMcp, agyToolName, sha } from "./tools.js";
import { UsageTracker } from "./usage.js";
import { prepareWorkspace, writeMcpConfig } from "./workspace.js";

/** Grace period after a tools/call to pick up the stdout events that precede it. */
const CALL_GRACE_MS = 500;

/** Error with an HTTP status, raised for failed turns. */
export class TurnError extends Error {
  constructor(message, { status = 502, type = "server_error", code = "agy_turn_failed", usage = null } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.usage = usage;
  }
}

const AUTH_RE = /not (?:logged|signed) in|unauthenticated|unauthori[sz]ed|\blogin required|please (?:run )?.*login|credential|oauth|\b401\b/i;
const QUOTA_RE = /quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|usage limit/i;

export function classifyFailure(text) {
  if (/invalid model selection|not recognized as a known model/i.test(text)) {
    return { status: 400, type: "invalid_request_error", code: "model_not_found" };
  }
  if (QUOTA_RE.test(text)) return { status: 429, type: "rate_limit_error", code: "agy_quota" };
  if (AUTH_RE.test(text)) return { status: 401, type: "authentication_error", code: "agy_auth" };
  return { status: 502, type: "server_error", code: "agy_turn_failed" };
}

function turnError(text, usage) {
  return new TurnError(text, { ...classifyFailure(text), usage });
}

export class Session {
  /**
   * @param {{key: string, store?: any, hub?: any, pool?: any, ephemeral?: boolean,
   *          processFactory?: (opts: any) => any, workspace?: {prepare: Function, writeMcp: Function}}} opts
   */
  constructor(opts) {
    this.key = opts.key;
    this.store = opts.store || null;
    this.hub = opts.hub || null;
    this.pool = opts.pool || null;
    this.ephemeral = !!opts.ephemeral;
    this.processFactory = opts.processFactory || ((o) => new AgyProcess(o));
    this.workspace = opts.workspace || { prepare: prepareWorkspace, writeMcp: writeMcpConfig };

    this.state = "idle";
    this.proc = null;
    this.queue = null;
    this.usage = new UsageTracker();
    this.gen = 0;
    this.pending = null;
    this.consumerActive = false;
    this.draining = false;
    this.turnFingerprint = "";
    this.spec = null; // {model, effort, toolsHash, systemHash, cwd} of the live process
    this.mcpTools = [];
    this.batchTool = "";
    this.harnessNames = [];
    this.dir = "";
    this.lastUsed = Date.now();
    this._lock = Promise.resolve();
    this._listWaiters = [];

    const saved = this.ephemeral ? null : this.store?.get(this.key);
    this.conversationId = saved?.conversation_id || "";
    /** Fingerprint of the harness history's first user message (detects compaction / rewrites). */
    this.anchor = saved?.anchor || "";
    this.lastPromptTokens = 0;
  }

  /** Harness tool_call ids the parked call is waiting for (several for a batch). */
  pendingIds() {
    const p = this.pending;
    if (!p) return [];
    return p.subs ? p.subs.map((c) => c.id) : [p.id];
  }

  get alive() {
    return !!this.proc && !this.proc.exited;
  }

  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Handle one chat-completions request. Resolves with an async iterator of
   * output items ({type:"text"}, {type:"tool_call"}, {type:"finish"}); throws
   * TurnError when the turn cannot start.
   *
   * @param {{messages: any[], mcpTools: any[], toolsHash: string, systemPrompt: string,
   *          systemHash: string, model: string, effort?: string, cwd?: string}} req
   */
  begin(req) {
    return this._withLock(async () => {
      this.lastUsed = Date.now();
      const results = collectToolResults(req.messages);
      const fp = lastUserFingerprint(req.messages);

      if (this.state === "parked" && this.pending) {
        const p = this.pending;
        if (this.pendingIds().some((id) => results.has(id))) {
          log.info("resuming parked call", { key: this.key, call: p.id, tool: p.name, batch: p.subs ? p.subs.length : undefined });
          this._resolveFromResults(results);
          this.state = "running";
          return this._consume();
        }
        if (fp === this.turnFingerprint) {
          log.info("re-emitting parked tool call", { key: this.key, call: p.id });
          return reemit(p);
        }
        log.info("new user turn supersedes parked call", { key: this.key, call: p.id });
        await this.stopProcess("superseded by a new user turn");
      } else if (this.state === "running") {
        log.info("request supersedes running turn", { key: this.key });
        await this.stopProcess("superseded by a newer request");
      }
      if (this.ephemeral) await this.stopProcess("ephemeral");
      return this._startTurn(req, fp);
    });
  }

  async _startTurn(req, fp) {
    const { messages } = req;

    // History rewrites (OpenCode compaction, a new first message) and the optional
    // rollover policy both start a fresh agy conversation with a transcript.
    const anchor = firstUserAnchor(messages);
    let reset = "";
    if (!this.ephemeral && this.conversationId) {
      if (this.anchor && anchor && anchor !== this.anchor) reset = "harness history was rewritten (compaction?)";
      else if (config.rolloverTokens && this.lastPromptTokens > config.rolloverTokens) reset = `context reached ${this.lastPromptTokens} tokens`;
    }
    if (reset) {
      log.info("starting a fresh agy conversation", { key: this.key, reason: reset });
      await this.stopProcess(`fresh conversation (${reset})`);
      this.conversationId = "";
      this.turnFingerprint = "";
    }
    this.anchor = anchor;
    this.lastPromptTokens = 0;
    const rollover = reset.startsWith("context");

    const ws = this.workspace.prepare({ key: this.key, systemPrompt: req.systemPrompt, cwd: req.cwd });
    this.dir = ws.dir;
    const want = {
      model: req.model,
      effort: req.effort || "",
      toolsHash: req.toolsHash,
      systemHash: req.systemHash,
      cwd: req.cwd || "",
    };

    if (this.alive) {
      const reasons = [];
      if (this.spec.model !== want.model) reasons.push("model");
      if (this.spec.effort !== want.effort) reasons.push("effort");
      if (ws.agentChanged || this.spec.systemHash !== want.systemHash) reasons.push("system prompt");
      if (this.spec.toolsHash !== want.toolsHash) {
        if (!reasons.length && config.toolsChangeMode === "notify" && (await this._notifyToolsChanged(req.mcpTools))) {
          this.spec = { ...this.spec, toolsHash: want.toolsHash };
          if (!this.ephemeral && this.store) this.store.update(this.key, { toolsHash: want.toolsHash });
        } else {
          reasons.push("tools");
        }
      }
      if (reasons.length) {
        log.info("restarting agy with --conversation", { key: this.key, reasons });
        await this.stopProcess(`restart (${reasons.join(", ")})`);
      }
    }
    this.mcpTools = req.mcpTools;
    this.batchTool = req.batchTool || "";
    this.harnessNames = req.harnessNames || req.mcpTools.map((t) => t.name);
    const historyCap = rollover ? Math.min(config.historyMaxChars, config.rolloverTokens * 2) : config.historyMaxChars;

    let transcript = "";
    let freshConversation = false;
    if (!this.alive) {
      const resumeId = this.ephemeral ? "" : this.conversationId;
      const init = await this._spawn(want, resumeId);
      const gotId = init.conversation_id || "";
      if (resumeId && gotId !== resumeId) {
        log.warn("agy could not resume conversation; transferring history", { key: this.key, wanted: resumeId, got: gotId });
        transcript = buildTranscript(priorMessages(messages), historyCap);
        freshConversation = true;
      } else if (!resumeId) {
        transcript = buildTranscript(priorMessages(messages), historyCap);
        freshConversation = true;
      }
      this.conversationId = gotId;
      if (!this.ephemeral && this.store) {
        this.store.update(this.key, {
          conversation_id: gotId,
          workspace: this.dir,
          model: want.model,
          effort: want.effort,
          toolsHash: want.toolsHash,
          systemHash: want.systemHash,
          cwd: want.cwd,
          anchor,
        });
      }
    } else {
      this.spec = want;
    }
    // A resumed/live conversation already holds the user turn we last delivered.
    const delivered = freshConversation ? "" : this.turnFingerprint;
    let text = tailToUserText(unsentTail(messages, delivered), toolCallNames(messages), config.toolOutputMax).trim() || "Continue.";
    if (transcript) text = withHistory(text, transcript);

    this.turnFingerprint = fp;
    this.usage.resetTurn();
    try {
      this.proc.sendUser(text);
    } catch (err) {
      throw turnError(String(err.message || err));
    }
    this.state = "running";
    return this._consume();
  }

  async _spawn(spec, resumeId) {
    if (this.pool) await this.pool.ensureCapacity(this);
    const gen = ++this.gen;
    if (this.hub) this.workspace.writeMcp({ dir: this.dir, socketPath: this.hub.socketPath, key: this.key, gen });
    const queue = new AsyncQueue();
    const proc = this.processFactory({
      cwd: this.dir,
      model: spec.model,
      effort: spec.effort,
      conversationId: resumeId,
      onItem: (item) => {
        queue.push(item);
        if (item.src === "exit") this._onExit(proc, item.info);
      },
    });
    proc.gen = gen;
    this.proc = proc;
    this.queue = queue;
    this.usage = new UsageTracker();
    this.spec = spec;
    proc.start();
    log.info("spawned agy", { key: this.key, pid: proc.pid, model: spec.model, effort: spec.effort || undefined, resume: resumeId || undefined });
    try {
      const init = await proc.waitInit();
      return init;
    } catch (err) {
      await proc.kill().catch(() => {});
      if (this.proc === proc) this.proc = null;
      throw turnError(String(err.message || err));
    }
  }

  _onExit(proc, info) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (!proc.stopReason) log.warn("agy exited", { key: this.key, ...summarizeExit(info) });
    if (this.state === "parked") {
      this._clearPending();
      this.state = "idle";
    } else if (this.state === "running" && !this.consumerActive) {
      this.state = "idle";
    }
  }

  /** Kill the live process (if any). A parked call dies with it. */
  async stopProcess(reason) {
    const proc = this.proc;
    this._clearPending();
    if (!proc) return;
    proc.stopReason = reason;
    this.proc = null;
    this.draining = false;
    if (!this.consumerActive) this.state = "idle";
    await proc.kill();
  }

  /**
   * Swap the tool set on the live process via notifications/tools/list_changed.
   * Succeeds only if agy re-fetches tools/list within a short window.
   */
  async _notifyToolsChanged(mcpTools) {
    if (!this.hub || !this.proc) return false;
    const gen = this.proc.gen;
    const prev = this.mcpTools;
    this.mcpTools = mcpTools;
    const listed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      timer.unref?.();
      this._listWaiters.push((conn) => {
        if (conn.gen !== gen) return false;
        clearTimeout(timer);
        resolve(true);
        return true;
      });
    });
    const sent = this.hub.notifyToolsChanged(this);
    const ok = sent > 0 && (await listed);
    this._listWaiters = [];
    if (!ok) this.mcpTools = prev;
    log.info(ok ? "tool set updated via list_changed" : "agy did not re-list tools; restarting", { key: this.key });
    return ok;
  }

  // ---- shim callbacks (via Hub) ---------------------------------------------

  onToolsListed(conn) {
    this._listWaiters = this._listWaiters.filter((w) => !w(conn));
  }

  onToolCall(conn, msg) {
    const reply = (text) => conn.send({ type: "call_result", rid: msg.rid, result: toolResultToMcp(text, true) });
    if (!this.proc || conn.gen !== this.proc.gen) {
      reply("This tool call came from a stale bridge process and was not executed.");
      return;
    }
    if (this.draining) {
      reply("No harness is attached to this conversation any more; the tool was not executed. End your turn.");
      return;
    }
    let subs = null;
    if (this.batchTool && msg.name === this.batchTool) {
      const parsed = parseBatch(msg.arguments, this.harnessNames, config.batchMax);
      if (parsed.error) {
        reply(parsed.error);
        return;
      }
      subs = parsed.calls.map((c) => ({ id: newCallId(), name: c.name, arguments: c.arguments }));
    }
    let args = "{}";
    try {
      args = JSON.stringify(msg.arguments ?? {});
    } catch {
      // keep {}
    }
    const call = {
      id: newCallId(),
      name: String(msg.name || ""),
      arguments: args,
      subs,
      conn,
      rid: msg.rid,
      mcpId: msg.mcpId,
      conversationId: msg.conversationId || "",
      createdAt: Date.now(),
      timer: null,
    };
    this.queue.push({ src: "call", call });
  }

  onToolCancelled(conn, msg) {
    const p = this.pending;
    if (p && p.conn === conn && p.mcpId === msg.mcpId) {
      log.warn("agy cancelled the parked tool call", { key: this.key, call: p.id, reason: msg.reason });
      this._clearPending();
      this.state = this.consumerActive ? "running" : "idle";
    }
  }

  onShimDisconnected(conn) {
    if (this.pending && this.pending.conn === conn) this._clearPending();
  }

  _clearPending() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  _resolvePending(text, isError, { truncate = true } = {}) {
    const p = this.pending;
    if (!p) return;
    this._clearPending();
    const out = truncate ? truncateToolOutput(text, config.toolOutputMax) : text;
    p.conn.send({ type: "call_result", rid: p.rid, result: toolResultToMcp(out, isError) });
  }

  /** Resolve the parked call (or batch) from the request's role:"tool" results. */
  _resolveFromResults(results) {
    const p = this.pending;
    if (!p) return;
    if (!p.subs) {
      this._resolvePending(results.get(p.id), false);
      return;
    }
    this._resolvePending(combineBatchResults(p.subs, results, config.toolOutputMax), false, { truncate: false });
  }

  _onParkTimeout(call) {
    if (this.pending !== call) return;
    const mins = Math.round(config.parkMs / 60000);
    log.warn("parked call exceeded ceiling; returning error to agy", { key: this.key, call: call.id });
    this._resolvePending(
      `The harness did not return a result for this tool call within ${mins >= 1 ? `${mins} minute(s)` : `${Math.round(config.parkMs / 1000)}s`}. The tool may not have run.`,
      true,
    );
    this.state = "running";
    this.draining = true;
    // Nobody is listening: let agy finish its turn in the background, discarding output.
    (async () => {
      try {
        for await (const _ of this._consume()) {
          // discard
        }
      } catch (err) {
        log.warn("background drain ended with error", { key: this.key, error: String(err.message || err).slice(0, 200) });
      } finally {
        this.draining = false;
      }
    })();
  }

  _notePrompt(u) {
    const n = (Number(u?.input_tokens) || 0) + (Number(u?.cache_read_tokens) || 0);
    if (n > (this.lastPromptTokens || 0)) this.lastPromptTokens = n;
  }

  // ---- turn consumer --------------------------------------------------------

  /** Client went away mid-turn: kill this session's agy process. */
  abortTurn(reason = "client aborted") {
    if (this.state === "running" && this.alive) {
      log.info("aborting turn", { key: this.key, reason });
      this.stopProcess(reason).catch(() => {});
    }
  }

  async *_consume() {
    const proc = this.proc;
    const queue = this.queue;
    const usage = this.usage;
    const gen = this.gen;
    const mine = () => this.gen === gen;
    if (!proc || !queue) throw turnError("agy process is not running");
    this.consumerActive = true;
    let finished = false;
    let lastError = "";
    let sawToolActive = false;
    // Release the consumer before the final yields: HTTP callers stop pulling after "finish".
    const release = () => {
      if (mine()) this.consumerActive = false;
    };
    try {
      while (true) {
        const item = await queue.next(config.stallMs);
        if (item === TIMEOUT) {
          const span = config.stallMs < 90_000 ? `${Math.round(config.stallMs / 1000)}s` : `${Math.round(config.stallMs / 60000)}m`;
          log.warn("stall watchdog fired", { key: this.key, span });
          if (mine()) {
            this.consumerActive = false;
            await this.stopProcess("stall");
          }
          throw new TurnError(`agy produced no output for ${span}; the turn was killed. Retry the message.`, { status: 504, code: "agy_stall" });
        }
        if (item.src === "exit") {
          if (mine()) this.state = "idle";
          if (proc.stopReason && proc.stopReason !== "stall") {
            // Superseded / aborted on purpose: end quietly.
            finished = true;
            release();
            yield { type: "finish", reason: "stop", usage: null, note: `turn ended: ${proc.stopReason}` };
            return;
          }
          throw turnError(lastError ? `${lastError} (${describeExit(item.info)})` : describeExit(item.info));
        }
        if (item.src === "call") {
          const call = item.call;
          // The tools/call can overtake the stdout events that precede it
          // (the step's usage and the tool step's ACTIVE update): give them a moment.
          if (!sawToolActive) {
            const deadline = Date.now() + CALL_GRACE_MS;
            while (Date.now() < deadline) {
              const nx = await queue.next(deadline - Date.now());
              if (nx === TIMEOUT) break;
              if (nx.src !== "agy") {
                queue.unshift(nx);
                break;
              }
              let done = false;
              for (const m of mapAgyEvent(nx.ev)) {
                if (m.kind === "text") yield { type: "text", text: m.text };
                else if (m.kind === "step_usage") {
                  usage.addStep(m.usage);
                  this._notePrompt(m.usage);
                }
                else if (m.kind === "tool_step" && m.state === "ACTIVE" && m.name === agyToolName(call.name)) done = true;
              }
              if (done) break;
            }
          }
          sawToolActive = false;
          if (!mine() || this.proc !== proc) {
            call.conn.send({ type: "call_result", rid: call.rid, result: toolResultToMcp("Turn was cancelled.", true) });
            finished = true;
            return;
          }
          if (this.draining) {
            call.conn.send({
              type: "call_result",
              rid: call.rid,
              result: toolResultToMcp("No harness is attached to this conversation any more; the tool was not executed. End your turn.", true),
            });
            continue;
          }
          call.timer = setTimeout(() => this._onParkTimeout(call), config.parkMs);
          call.timer.unref?.();
          this.pending = call;
          this.state = "parked";
          finished = true;
          release();
          log.info("parked tool call", { key: this.key, call: call.id, tool: call.name, batch: call.subs ? call.subs.map((c) => c.name) : undefined });
          yield* toolCallItems(call);
          yield { type: "finish", reason: "tool_calls", usage: usage.takeParked() };
          return;
        }
        for (const m of mapAgyEvent(item.ev)) {
          if (m.kind === "text") {
            yield { type: "text", text: m.text };
          } else if (m.kind === "step_usage") {
            usage.addStep(m.usage);
            this._notePrompt(m.usage);
          } else if (m.kind === "tool_step") {
            if (m.state === "ACTIVE" && harnessToolName(m.name)) sawToolActive = true;
            if (m.state === "ERROR" && m.error) log.debug("agy tool step error", { key: this.key, tool: m.name, error: m.error.slice(0, 200) });
          } else if (m.kind === "step_error") {
            lastError = m.text;
          } else if (m.kind === "init") {
            if (m.conversationId && mine() && !this.ephemeral) this.conversationId = m.conversationId;
          } else if (m.kind === "result") {
            if (mine()) this.state = "idle";
            const u = usage.takeFinal(m.usage);
            if (m.status !== "SUCCESS") {
              throw turnError(m.error || lastError || `agy turn ended with status ${m.status}`, u);
            }
            finished = true;
            release();
            if (this.ephemeral && mine() && this.proc === proc) this.stopProcess("ephemeral turn done").catch(() => {});
            yield { type: "finish", reason: "stop", usage: u };
            return;
          }
        }
      }
    } finally {
      release();
      if (!finished && mine() && this.state === "running" && this.proc === proc) {
        // Consumer abandoned mid-turn (client abort or error): nobody can resume it.
        this.stopProcess("turn abandoned").catch(() => {});
      }
    }
  }
}

function* toolCallItems(call) {
  if (call.subs) {
    for (const c of call.subs) yield { type: "tool_call", id: c.id, name: c.name, arguments: c.arguments };
  } else {
    yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
  }
}

async function* reemit(p) {
  yield* toolCallItems(p);
  yield { type: "finish", reason: "tool_calls", usage: null };
}

function newCallId() {
  return `call_${randomUUID().replace(/-/g, "")}`;
}

/** Fingerprint of the first user message's content (position-independent). */
export function firstUserAnchor(messages) {
  const first = (messages || []).find((m) => m?.role === "user");
  if (!first) return "";
  const c = first.content;
  return sha(typeof c === "string" ? c : JSON.stringify(c ?? ""));
}

/**
 * Validate a batch meta-tool call. Returns {calls:[{name, arguments(JSON string)}]}
 * or {error} (sent straight back to agy as an isError result; nothing reaches the harness).
 */
export function parseBatch(args, allowedNames, max = 8) {
  let calls = args?.calls;
  if (typeof calls === "string") {
    try {
      calls = JSON.parse(calls);
    } catch {
      calls = null;
    }
  }
  if (!Array.isArray(calls) || calls.length === 0) {
    return { error: 'batch needs a non-empty "calls" array of {"name": <tool>, "arguments": {...}}. Nothing was run.' };
  }
  if (calls.length > max) return { error: `batch accepts at most ${max} calls; got ${calls.length}. Nothing was run.` };
  const allowed = new Set(allowedNames);
  const out = [];
  for (const [i, c] of calls.entries()) {
    const name = typeof c?.name === "string" ? c.name.replace(/^mcp_[^_]+_/, "").trim() : "";
    if (!allowed.has(name)) {
      return { error: `batch call ${i + 1}: unknown tool "${c?.name ?? ""}". Valid tools: ${[...allowed].join(", ")}. Nothing was run.` };
    }
    let a = c.arguments ?? c.args ?? {};
    if (typeof a === "string") {
      try {
        a = JSON.parse(a);
      } catch {
        return { error: `batch call ${i + 1} (${name}): arguments must be a JSON object. Nothing was run.` };
      }
    }
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      return { error: `batch call ${i + 1} (${name}): arguments must be a JSON object. Nothing was run.` };
    }
    // agy adds a toolSummary argument to every tool it shows the model and strips it from
    // top-level calls; the model copies it into batch entries too, where agy cannot strip it.
    const { toolSummary: _summary, ...clean } = a;
    out.push({ name, arguments: JSON.stringify(clean) });
  }
  return { calls: out };
}

/** One text result for agy from the harness results of a batch, in call order. */
export function combineBatchResults(subs, results, maxEach = 0) {
  return subs
    .map((c, i) => {
      const r = results.get(c.id);
      const body = r === undefined ? "(the harness returned no result for this call)" : truncateToolOutput(r || "(no output)", maxEach);
      return `<result index="${i + 1}" tool="${c.name}">\n${body}\n</result>`;
    })
    .join("\n");
}

function summarizeExit(info) {
  return { code: info?.code, signal: info?.signal, stderr: (info?.stderr || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300) };
}
