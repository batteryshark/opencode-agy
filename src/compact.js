/**
 * Token trimming for what the bridge hands agy: the harness system prompt
 * (bridge.md body) and the harness tool schemas (MCP tools/list).
 *
 * Everything here is deterministic: the same input always produces the same
 * output, so compaction never changes the system hash (and never restarts
 * agy) unless the harness prompt itself changed.
 */

/** First sentence of `text` (up to `max` chars, cut on a word boundary). */
export function firstSentence(text, max = 160) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.+?[.!?])(?=\s|$)/.exec(t);
  let s = m ? m[1] : t;
  if (s.length > max) {
    s = s.slice(0, max);
    const sp = s.lastIndexOf(" ");
    s = (sp > max * 0.6 ? s.slice(0, sp) : s).replace(/[\s,;:]+$/, "") + "…";
  }
  return s;
}

/** Cut `text` to at most `max` chars on a sentence (else word) boundary. */
export function capText(text, max) {
  const t = String(text || "").trim();
  if (!max || t.length <= max) return t;
  const head = t.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("\n"));
  if (stop > max * 0.5) return head.slice(0, stop + 1).trim();
  const sp = head.lastIndexOf(" ");
  return (sp > max * 0.5 ? head.slice(0, sp) : head).trim() + "…";
}

// ---- system prompt ---------------------------------------------------------

/** `<available_skills>` (OpenCode / Claude-style skill catalogs) -> one line per skill. */
function compactSkillCatalog(text, descMax) {
  return text.replace(/<available_skills>([\s\S]*?)<\/available_skills>/g, (_all, inner) => {
    const lines = [];
    const re = /<skill>([\s\S]*?)<\/skill>/g;
    let m;
    while ((m = re.exec(inner))) {
      const block = m[1];
      const pick = (tag) => {
        const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
        return r ? r[1].trim() : "";
      };
      const id = pick("id") || pick("name");
      if (!id) continue;
      const desc = descMax > 0 ? firstSentence(pick("description"), descMax) : "";
      lines.push(desc ? `- ${id}: ${desc}` : `- ${id}`);
    }
    return lines.length ? `<available_skills>\n${lines.join("\n")}\n</available_skills>` : "";
  });
}

/**
 * Collapse TypeScript-style signature catalogs (OpenCode Code Mode): drop
 * single-line JSDoc comments and replace `Promise<{ ... }>` result shapes
 * with `Promise<object>`. Parameter lists are kept.
 */
function compactSignatures(text) {
  let out = text.replace(/^[ \t]*\/\*\*.*?\*\/[ \t]*\n/gm, "");
  const marker = "Promise<{";
  let idx = out.indexOf(marker);
  while (idx >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = idx + "Promise<".length; i < out.length; i++) {
      const c = out[i];
      if (c === "{" || c === "<" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ">" || c === ")" || c === "]") {
        depth--;
        if (depth < 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    out = out.slice(0, idx) + "Promise<object>" + out.slice(end + 1);
    idx = out.indexOf(marker, idx + 1);
  }
  return out;
}

/** Known low-value lines in harness prompts (matched per line, case-insensitive). */
const DROP_LINE_PATTERNS = [
  /^\s*Prefer \S+ over generic system temporary directories/i,
  /^\s*When you create a worktree outside the current working directory/i,
  /^\s*Workspace root folder:/i,
];

/** Drop a `# Heading` section (up to the next heading of the same or higher level). */
function dropSection(text, headingRe) {
  const lines = text.split("\n");
  const out = [];
  let skipLevel = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (skipLevel) {
      if (h && h[1].length <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (h && headingRe.test(h[2])) {
      skipLevel = h[1].length;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Whitespace normalization that keeps Markdown structure and relative indentation. */
export function collapseWhitespace(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const m = /^([ \t]*)(.*)$/.exec(line.replace(/[ \t]+$/, ""));
      const indent = m[1].replace(/\t/g, "  ");
      // halve indentation (2 -> 1 space per level) and squeeze interior runs
      return " ".repeat(Math.floor(indent.length / 2)) + m[2].replace(/([^ ]) {2,}/g, "$1 ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove repeated paragraphs (exact duplicates after trimming), keeping the first. */
export function dedupeParagraphs(text, minLen = 40) {
  const seen = new Set();
  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    const key = para.trim();
    if (key.length >= minLen) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(para);
  }
  return out.join("\n\n");
}

/**
 * Compact a harness system prompt.
 *   level 1 ("safe"): whitespace, duplicate paragraphs, known boilerplate
 *     lines, skill catalogs reduced to `- id: first sentence`, signature
 *     catalogs without JSDoc comments and result shapes, and a "Your Model"
 *     section (agy already tells the model what it is).
 *   level 2 ("aggressive"): level 1, and skill catalogs keep ids only.
 * The project directory line ("Working directory: ...") is always kept.
 */
export function compactSystemPrompt(text, level = 1) {
  if (!text || !level) return text || "";
  let t = String(text);
  t = compactSkillCatalog(t, level >= 2 ? 0 : 140);
  t = compactSignatures(t);
  t = dropSection(t, /^Your Model$/i);
  t = t
    .split("\n")
    .filter((line) => !DROP_LINE_PATTERNS.some((re) => re.test(line)))
    .join("\n");
  t = collapseWhitespace(t);
  t = dedupeParagraphs(t);
  return t;
}

// ---- tool schemas ------------------------------------------------------------

/** JSON-Schema keys that carry no information the model needs to call a tool. */
const SCHEMA_NOISE = new Set(["$schema", "additionalProperties", "$id", "$comment", "examples", "default", "title"]);

/** Shorten a tool description: list items to their first sentence, then cap. */
export function compactToolDescription(desc, max = 400) {
  const t = String(desc || "").replace(/\r\n?/g, "\n").trim();
  if (!t) return t;
  const lines = [];
  for (const raw of t.split("\n")) {
    const line = raw.trim().replace(/\s{2,}/g, " ");
    if (!line) continue;
    const item = /^(-|\*|\d+\.)\s+(.*)$/.exec(line);
    lines.push(item ? `${item[1]} ${firstSentence(item[2], 200)}` : line);
  }
  // Keep "- name: ..." items (e.g. subagent catalogs) even past the cap: they name valid values.
  const prose = [];
  const items = [];
  for (const l of lines) (/^-\s+[\w.-]+:/.test(l) ? items : prose).push(l);
  const proseText = capText(prose.join("\n"), max);
  return [proseText, ...items].filter(Boolean).join("\n");
}

function minifySchema(schema, propDescMax) {
  if (Array.isArray(schema)) return schema.map((s) => minifySchema(s, propDescMax));
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_NOISE.has(k)) continue;
    if (k === "description" && typeof v === "string") {
      const d = propDescMax > 0 ? firstSentence(v, propDescMax) : "";
      if (d) out[k] = d;
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, minifySchema(pv, propDescMax)]));
      continue;
    }
    out[k] = minifySchema(v, propDescMax);
  }
  return out;
}

/**
 * Minify MCP tool entries: compact descriptions, drop schema noise, shorten
 * property descriptions to their first sentence. Names, types, enums and
 * `required` are untouched, so every call the harness accepts stays valid.
 */
export function minifyMcpTools(tools, { descMax = 400, propDescMax = 100 } = {}) {
  return (tools || []).map((t) => ({
    ...t,
    description: compactToolDescription(t.description, descMax) || t.name,
    inputSchema: minifySchema(t.inputSchema, propDescMax),
  }));
}

/** Apply an allow/deny list of tool names (comma-separated strings or arrays). */
export function filterTools(tools, { allow = [], deny = [] } = {}) {
  const a = new Set(allow);
  const d = new Set(deny);
  return (tools || []).filter((t) => (!a.size || a.has(t.name)) && !d.has(t.name));
}

// ---- tool results ---------------------------------------------------------------

/** Keep the head and tail of an oversized tool result, with a marker in between. */
export function truncateToolOutput(text, max) {
  const t = typeof text === "string" ? text : String(text ?? "");
  if (!max || max <= 0 || t.length <= max) return t;
  const headLen = Math.floor(max * 0.7);
  const tailLen = max - headLen;
  const omitted = t.length - headLen - tailLen;
  return (
    t.slice(0, headLen) +
    `\n\n[... ${omitted} characters of tool output omitted by opencode-agy (OPENCODE_AGY_TOOL_OUTPUT_MAX=${max}); ` +
    "re-run the tool with a narrower range, offset or pattern if you need the missing part ...]\n\n" +
    t.slice(t.length - tailLen)
  );
}
