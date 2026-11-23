// Claude's streamed answers as Bedrock sends them (VAY-2518): Anthropic's stream events, each in
// an AWS event-stream frame. Tests hand these to the real Bedrock provider through a fake fetch,
// so everything between our code and the network runs as in production.
type StreamEvent = Record<string, unknown>;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32, as the event-stream frames carry it (the provider checks both). */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function header(name: string, value: string): Buffer {
  const key = Buffer.from(name);
  const text = Buffer.from(value);
  const out = Buffer.alloc(1 + key.length + 1 + 2 + text.length);
  out.writeUInt8(key.length, 0);
  key.copy(out, 1);
  out.writeUInt8(7, 1 + key.length); // 7: string
  out.writeUInt16BE(text.length, 2 + key.length);
  text.copy(out, 4 + key.length);
  return out;
}

/** One AWS event-stream message carrying one Anthropic stream event. */
function frame(event: StreamEvent): Buffer {
  const headers = Buffer.concat([
    header(":event-type", "chunk"),
    header(":content-type", "application/json"),
    header(":message-type", "event"),
  ]);
  const payload = Buffer.from(
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }),
  );
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + headers.length + payload.length + 4, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const message = Buffer.concat([prelude, preludeCrc, headers, payload]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(message), 0);
  return Buffer.concat([message, messageCrc]);
}

/**
 * A Bedrock invoke-with-response-stream answer: the events, two frames per network chunk. With
 * `openUntil`, the stream stays open after them until that signal aborts it (a stopped request).
 */
export function bedrockStream(
  events: readonly StreamEvent[],
  options: { openUntil?: AbortSignal | null } = {},
): Response {
  const frames = events.map(frame);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let n = 0; n < frames.length; n += 2)
        controller.enqueue(new Uint8Array(Buffer.concat(frames.slice(n, n + 2))));
      const until = options.openUntil;
      if (!until) controller.close();
      else until.addEventListener("abort", () => controller.error(until.reason), { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

export type ReplyUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type ReplyBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** The stream events of one Claude message made of these blocks. */
export function claudeReply(
  blocks: readonly ReplyBlock[],
  usage: ReplyUsage,
  stopReason = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
): StreamEvent[] {
  const events: StreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          output_tokens: 1,
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      // Two pieces, so a test sees the answer arrive as it streams.
      const half = Math.ceil(block.text.length / 2);
      for (const piece of [block.text.slice(0, half), block.text.slice(half)])
        if (piece)
          events.push({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: piece },
          });
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: "message_stop" });
  return events;
}
