/** Observe protocol boundaries without retaining content or modifying forwarded bytes. */
export function streamSignal(event, value, raw = "") {
  const type = String(value?.type || event || "");
  const text = (v) => typeof v === "string" && v.length > 0;
  const hasOutput = (type.endsWith(".delta") && text(value?.delta))
    || (type === "content_block_delta" && [value?.delta?.text, value?.delta?.thinking, value?.delta?.partial_json].some(text))
    || (type === "content_block_start" && [value?.content_block?.text, value?.content_block?.thinking].some(text))
    || (Array.isArray(value?.choices) && value.choices.some((choice) => {
      const delta = choice?.delta || {};
      return [delta.content, delta.reasoning_content, delta.reasoning, delta.function_call?.arguments].some(text)
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.some((tool) => [tool?.function?.name, tool?.function?.arguments].some(text)));
    }));
  if (type === "response.failed" || type === "error" || value?.error) {
    return { hasOutput, terminal: true, failed: true, error: String(value?.error?.code || value?.error?.type || value?.response?.error?.code || "upstream_stream_error").slice(0, 100) };
  }
  // A content/tool block ending is not the whole response ending. Chat usage
  // may arrive after finish_reason; wait for [DONE] instead of dropping it.
  return { hasOutput, terminal: raw.trim() === "[DONE]" || ["response.completed", "response.incomplete", "message_stop"].includes(type), failed: false, error: "" };
}

export class SseObserver {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.remainder = "";
    this.event = "";
    this.data = [];
    this.size = 0;
    this.discarding = false;
  }

  line(line) {
    if (line === "") {
      if (this.data.length || this.discarding) {
        const raw = this.data.join("\n");
        let value = null;
        try { value = JSON.parse(raw); } catch { /* [DONE] or non-JSON data */ }
        this.onEvent(this.event, value, raw);
      }
      this.event = ""; this.data = []; this.size = 0; this.discarding = false;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value;
    if (field === "data" && !this.discarding) {
      this.size += value.length;
      if (this.size > 16 * 1024 * 1024) { this.data = []; this.discarding = true; }
      else this.data.push(value);
    }
  }

  feed(text) {
    const combined = this.remainder + text;
    // A CR at the chunk boundary may be the first half of CRLF. Keep it
    // until the next chunk so LF does not create a false event separator.
    const pendingCR = combined.endsWith("\r") ? "\r" : "";
    const lines = (pendingCR ? combined.slice(0, -1) : combined).split(/\r\n|\r|\n/);
    this.remainder = (lines.pop() || "") + pendingCR;
    for (const line of lines) this.line(line);
    if (this.remainder.length > 16 * 1024 * 1024) { this.remainder = ""; this.data = []; this.discarding = true; }
  }

  end(text = "") {
    this.feed(text);
    if (this.remainder) this.line(this.remainder.replace(/\r$/, ""));
    this.remainder = "";
    this.line("");
  }
}
