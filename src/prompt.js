/**
 * OpenAI chat messages -> what agy needs: a system prompt for bridge.md and
 * the user text for the next stream-json input line.
 */
import { truncateToolOutput } from "./compact.js";
import { sha, stableStringify } from "./tools.js";

export function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      else if (part.type === "image_url" || part.type === "image" || part.type === "file" || part.type === "input_audio") {
        parts.push(`[${part.type} attachment omitted: the agy bridge forwards text only]`);
      }
    }
  }
  return parts.join("\n");
}

/** Concatenated system + developer messages. */
export function systemPromptOf(messages) {
  return messages
    .filter((m) => m && (m.role === "system" || m.role === "developer"))
    .map((m) => extractText(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function systemHash(systemText) {
  return sha(systemText || "");
}

/** Index of the last assistant message, or -1. */
function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i;
  return -1;
}

/** Messages after the last assistant message (new user input and/or tool results). */
export function tailMessages(messages) {
  return messages.slice(lastAssistantIndex(messages) + 1).filter((m) => m && m.role !== "system" && m.role !== "developer");
}

/** Messages before the tail: what a fresh conversation is missing. */
export function priorMessages(messages) {
  const idx = lastAssistantIndex(messages);
  return idx >= 0 ? messages.slice(0, idx + 1) : [];
}

/** role:"tool" results in the request, keyed by tool_call_id. */
export function collectToolResults(messages) {
  const results = new Map();
  for (const m of messages) {
    if (m?.role !== "tool" || typeof m.tool_call_id !== "string") continue;
    results.set(m.tool_call_id, extractText(m.content));
  }
  return results;
}

function userFingerprintAt(messages, i) {
  return sha(`${i}:${stableStringify(messages[i].content)}`);
}

/** Fingerprint of the newest user message (position + content). */
export function lastUserFingerprint(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return userFingerprintAt(messages, i);
  }
  return "";
}

/**
 * Messages after the last assistant message, minus anything up to and
 * including a user message agy already received (identified by fingerprint):
 * after a supersede the earlier user turn is already in agy's conversation.
 */
export function unsentTail(messages, deliveredFingerprint) {
  const start = messages.length - tailMessagesCount(messages);
  if (deliveredFingerprint) {
    for (let i = messages.length - 1; i >= start; i--) {
      if (messages[i]?.role === "user" && userFingerprintAt(messages, i) === deliveredFingerprint) {
        return messages.slice(i + 1).filter((m) => m && m.role !== "system" && m.role !== "developer");
      }
    }
  }
  return tailMessages(messages);
}

function tailMessagesCount(messages) {
  return messages.length - (lastAssistantIndex(messages) + 1);
}

/**
 * Text for the next agy user turn, from the tail. Tool results that do not
 * belong to a live parked call (proxy restart, respawned process) are
 * rendered as text so the model still sees them.
 */
export function tailToUserText(tail, toolNames = new Map(), toolOutputMax = 0) {
  const chunks = [];
  for (const m of tail) {
    if (m.role === "user") {
      const t = extractText(m.content).trim();
      if (t) chunks.push(t);
    } else if (m.role === "tool") {
      const name = toolNames.get(m.tool_call_id) || m.name || m.tool_call_id || "tool";
      chunks.push(`<tool_result name="${name}">\n${truncateToolOutput(extractText(m.content), toolOutputMax)}\n</tool_result>`);
    }
  }
  return chunks.join("\n\n");
}

/** tool_call_id -> function name, from assistant messages. */
export function toolCallNames(messages) {
  const names = new Map();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) if (c?.id && c.function?.name) names.set(c.id, c.function.name);
  }
  return names;
}

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n... [${text.length - max} chars omitted] ...\n${text.slice(-half)}`;
}

/** Serialize prior messages, keeping the newest within maxChars. */
export function buildTranscript(messages, maxChars) {
  if (!maxChars || maxChars <= 0) return "";
  const lines = [];
  for (const m of messages) {
    if (!m || m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") {
      const t = extractText(m.content).trim();
      if (t) lines.push(`User:\n${t}`);
    } else if (m.role === "assistant") {
      const parts = [];
      const t = extractText(m.content).trim();
      if (t) parts.push(t);
      for (const c of m.tool_calls ?? []) {
        if (c?.function?.name) parts.push(`[called tool ${c.function.name}(${truncateMiddle(String(c.function.arguments ?? ""), 400)})]`);
      }
      if (parts.length) lines.push(`Assistant:\n${parts.join("\n")}`);
    } else if (m.role === "tool") {
      const t = extractText(m.content).trim();
      if (t) lines.push(`Tool result (${m.name || m.tool_call_id || "tool"}):\n${truncateMiddle(t, 2000)}`);
    }
  }
  const kept = [];
  let total = 0;
  let omitted = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (total + lines[i].length > maxChars) {
      omitted = i + 1;
      break;
    }
    kept.unshift(lines[i]);
    total += lines[i].length;
  }
  if (!kept.length) return "";
  return (omitted ? `[${omitted} earlier message(s) omitted]\n\n` : "") + kept.join("\n\n");
}

export function withHistory(text, transcript) {
  if (!transcript) return text;
  return (
    "<conversation_history>\nThe earlier part of this conversation is included below because the " +
    "previous agy conversation could not be resumed. Treat it as established context, do not redo " +
    "completed work, and respond to the latest message that follows.\n\n" +
    transcript +
    "\n</conversation_history>\n\nLatest message:\n" +
    text
  );
}

/** Project directory from OpenCode's environment block ("Working directory: ..."). */
export function extractCwd(systemText) {
  const m = /^\s*(?:Working directory|Current working directory|cwd)\s*:\s*(\S.*?)\s*$/im.exec(systemText || "");
  return m ? m[1] : "";
}

// ---- OpenCode meta requests (title / summary) --------------------------------

export function detectMetaKind(messages) {
  const system = systemPromptOf(messages).toLowerCase();
  if (
    system.includes("title generator") ||
    system.includes("generate a short title") ||
    system.includes("generate a brief title") ||
    system.includes("output only a thread title")
  ) {
    return "title";
  }
  if (
    system.includes("anchored context summarization") ||
    system.includes("summarizing, compacting, or merging context") ||
    system.includes("tasked with summarizing conversations") ||
    system.includes("summarize what was done in this conversation")
  ) {
    return "summary";
  }
  const user = messages
    .filter((m) => m?.role === "user")
    .map((m) => extractText(m.content))
    .join("\n")
    .toLowerCase();
  if (
    user.includes("create a detailed summary for continuing this coding session") ||
    user.includes("this summary will be the only context available when the conversation continues") ||
    user.includes("<previous-summary>")
  ) {
    return "summary";
  }
  return null;
}

/** Fallback session key: hash of the first user message (mirrors opencode-claude). */
export function conversationKeyFromMessages(messages) {
  const first = messages.find((m) => m?.role === "user");
  const seed = typeof first?.content === "string" ? first.content.slice(0, 200) : JSON.stringify(first?.content ?? "").slice(0, 200);
  return `conv_${sha(seed, 12)}`;
}
