/**
 * agy `--output-format stream-json` events -> internal events.
 *
 * Observed shapes (agy 1.3.3):
 *   {"event":"init","conversation_id":..,"init":{model,cwd,agent,tools,permission_mode}}
 *   {"event":"step_update","step_update":{step_index,state,step_type,text_delta?,usage?,tool_name?,tool_info?}}
 *   {"event":"result","result":{conversation_id,status,response,error?,num_turns,usage}}
 * init.tools is unreliable (lists built-ins the bridge agent does not have).
 */

/** Returns an array of internal events for one parsed agy line. */
export function mapAgyEvent(e) {
  if (!e || typeof e !== "object") return [];
  if (e.event === "init") {
    return [
      {
        kind: "init",
        conversationId: str(e.conversation_id) || str(e.init?.conversation_id),
        model: str(e.init?.model),
        cwd: str(e.init?.cwd),
      },
    ];
  }
  if (e.event === "result") {
    const r = e.result && typeof e.result === "object" ? e.result : {};
    return [
      {
        kind: "result",
        conversationId: str(r.conversation_id),
        status: str(r.status) || "UNKNOWN",
        response: str(r.response),
        error: str(r.error),
        usage: r.usage && typeof r.usage === "object" ? r.usage : null,
        numTurns: Number(r.num_turns) || 0,
      },
    ];
  }
  if (e.event === "step_update") {
    const s = e.step_update && typeof e.step_update === "object" ? e.step_update : {};
    const out = [];
    const type = str(s.step_type);
    const state = str(s.state);
    if (type === "agent_response") {
      if (typeof s.text_delta === "string" && s.text_delta) {
        out.push({ kind: "text", text: s.text_delta });
      }
    } else if (type === "tool") {
      const info = s.tool_info && typeof s.tool_info === "object" ? s.tool_info : {};
      out.push({
        kind: "tool_step",
        name: str(info.name) || str(s.tool_name),
        state,
        error: info.error ? str(info.error.message) || JSON.stringify(info.error) : "",
      });
    } else if (type === "error_message" || (state === "ERROR" && type !== "tool")) {
      const text =
        str(s.text_delta) || str(s.error?.message) || str(s.error) || `agy step failed (${type || "unknown"})`;
      out.push({ kind: "step_error", text });
    }
    if (s.usage && typeof s.usage === "object") {
      out.push({ kind: "step_usage", usage: s.usage });
    }
    return out;
  }
  return [];
}

function str(v) {
  return typeof v === "string" ? v : "";
}

/** Parse NDJSON text into agy events, skipping non-JSON lines. */
export function parseNdjson(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore
    }
  }
  return out;
}
