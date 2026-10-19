/**
 * Token accounting.
 *
 * agy reports per-step usage on agent_response DONE events and a cumulative
 * (per process) usage on every `result`. A parked response has no result yet,
 * so it reports the step usage it consumed; the response that sees `result`
 * reports whatever remains of that turn's cumulative delta, so the sum over
 * a turn's responses equals agy's own total.
 */
export const USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
]);

export function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 };
}

export function normalizeUsage(u) {
  const out = emptyUsage();
  if (!u || typeof u !== "object") return out;
  for (const f of USAGE_FIELDS) {
    const n = Number(u[f]);
    out[f] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

export function addUsage(a, b) {
  const out = emptyUsage();
  const na = normalizeUsage(a);
  const nb = normalizeUsage(b);
  for (const f of USAGE_FIELDS) out[f] = na[f] + nb[f];
  return out;
}

/** a - b, clamped at 0 per field. */
export function subUsage(a, b) {
  const out = emptyUsage();
  const na = normalizeUsage(a);
  const nb = normalizeUsage(b);
  for (const f of USAGE_FIELDS) out[f] = Math.max(0, na[f] - nb[f]);
  return out;
}

export function isZeroUsage(u) {
  const n = normalizeUsage(u);
  return USAGE_FIELDS.every((f) => n[f] === 0);
}

/** True when every field of `a` is >= the matching field of `b`. */
function dominates(a, b) {
  const na = normalizeUsage(a);
  const nb = normalizeUsage(b);
  return USAGE_FIELDS.every((f) => na[f] >= nb[f]);
}

/**
 * Per-process usage tracker. `baseline` is the last cumulative result usage
 * (null right after a spawn, when we don't know whether agy's counter starts
 * at zero or at the resumed conversation's total).
 */
export class UsageTracker {
  constructor() {
    this.baseline = null;
    this.resetTurn();
  }

  resetTurn() {
    this.turnSteps = emptyUsage(); // sum of step usage seen this turn
    this.turnReported = emptyUsage(); // sum already returned to clients this turn
  }

  /** Spawned a new process: cumulative counter origin unknown. */
  resetProcess() {
    this.baseline = null;
    this.resetTurn();
  }

  addStep(usage) {
    this.turnSteps = addUsage(this.turnSteps, usage);
  }

  /** Usage to attach to a response that ends parked (no result yet). */
  takeParked() {
    const delta = subUsage(this.turnSteps, this.turnReported);
    this.turnReported = addUsage(this.turnReported, delta);
    return delta;
  }

  /**
   * Usage to attach to the response that saw `result`. Uses the cumulative
   * delta when it is trustworthy, else the step sum. Starts a new turn.
   */
  takeFinal(resultUsage) {
    const cumulative = normalizeUsage(resultUsage);
    let turnTotal = this.turnSteps;
    if (this.baseline && dominates(cumulative, this.baseline)) {
      const delta = subUsage(cumulative, this.baseline);
      // Trust the cumulative delta unless it is implausibly smaller than the steps.
      if (dominates(delta, this.turnSteps) || isZeroUsage(this.turnSteps)) turnTotal = delta;
    } else if (!this.baseline && isZeroUsage(this.turnSteps)) {
      turnTotal = cumulative;
    }
    this.baseline = cumulative;
    const out = subUsage(turnTotal, this.turnReported);
    this.resetTurn();
    return out;
  }
}

/** agy usage -> OpenAI usage object. */
export function toOpenAIUsage(u) {
  const n = normalizeUsage(u);
  const prompt = n.input_tokens + n.cache_read_tokens;
  const completion = n.output_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: n.cache_read_tokens },
    completion_tokens_details: { reasoning_tokens: n.thinking_tokens },
  };
}
