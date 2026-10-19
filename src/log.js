/** Minimal leveled logger to stderr. Never pass secrets or env values here. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold() {
  return LEVELS[process.env.OPENCODE_AGY_LOG_LEVEL || "info"] ?? LEVELS.info;
}

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [opencode-agy] ${msg}`;
  process.stderr.write(meta === undefined ? `${line}\n` : `${line} ${safeJson(meta)}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (m, meta) => emit("debug", m, meta),
  info: (m, meta) => emit("info", m, meta),
  warn: (m, meta) => emit("warn", m, meta),
  error: (m, meta) => emit("error", m, meta),
};
