import { describe, expect, it } from "vitest";

import {
  ChatHistoryError,
  type ChatMessage,
  chatPreview,
  checkMessage,
  MAX_MESSAGE_BYTES,
  unansweredResult,
} from "./conversationStore.js";

const call = (toolCallId: string, input: unknown = { propertyId: "p1" }) => ({
  type: "tool-call",
  toolCallId,
  toolName: "rooms_list",
  input,
});
const result = (toolCallId: string) => ({
  type: "tool-result",
  toolCallId,
  toolName: "rooms_list",
  output: { type: "json", value: { rooms: [] } },
});

describe("chat messages the store accepts (VAY-2518)", () => {
  it("takes the AI SDK's user, assistant and tool messages as they are", () => {
    expect(checkMessage({ role: "user", content: "What arrives today?" }, ["user"])).toMatchObject({
      role: "user",
      toolCallIds: [],
    });
    const assistant: ChatMessage = {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "The user asks about arrivals.",
          providerOptions: { bedrock: { signature: "c2lnbmF0dXJl" } },
        },
        { type: "text", text: "Let me look." },
        call("toolu_01", { to: "2026-12-02", from: "2026-12-01" }),
        call("toolu_02"),
      ],
      providerOptions: undefined,
    };
    const checked = checkMessage(assistant, ["assistant", "tool"]);
    expect(checked.toolCallIds).toEqual(["toolu_01", "toolu_02"]);
    expect(checked.calls[0]).toEqual({ toolCallId: "toolu_01", toolName: "rooms_list" });
    // Kept as handed over: key order included, undefined properties dropped as JSON does.
    expect(checked.json).toBe(JSON.stringify(assistant));
    expect(checked.json).toContain('"input":{"to":"2026-12-02","from":"2026-12-01"}');
    expect(
      checkMessage({ role: "tool", content: [result("toolu_01"), result("toolu_02")] }, ["tool"])
        .toolCallIds,
    ).toEqual(["toolu_01", "toolu_02"]);
  });

  it("refuses a role that is not expected here", () => {
    expect(() => checkMessage({ role: "user", content: "hi" }, ["assistant", "tool"])).toThrow(
      "expected a message from: assistant, tool",
    );
  });

  it.each<[string, ChatMessage, string]>([
    ["a Date", { role: "assistant", content: [{ type: "text", text: new Date(0) }] }, "plain JSON"],
    [
      "bytes",
      { role: "assistant", content: [{ type: "file", data: new Uint8Array([1]) }] },
      "plain JSON",
    ],
    [
      "NaN",
      { role: "assistant", content: [{ type: "text", text: "x", n: Number.NaN }] },
      "plain JSON",
    ],
    ["a hole in an array", { role: "assistant", content: [undefined] }, "missing"],
    // Claude refuses empty messages and blank text when they are replayed.
    ["a blank question", { role: "user", content: " \n " }, "needs text"],
    ["a question without parts", { role: "user", content: [] }, "needs content"],
    ["an empty answer", { role: "assistant", content: [] }, "needs content"],
    [
      "a blank text part",
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      "a text part needs text",
    ],
    [
      "an answer with thinking only",
      { role: "assistant", content: [{ type: "reasoning", text: "Hmm." }] },
      "needs text or a tool call",
    ],
    ["a tool message without results", { role: "tool", content: [] }, "needs content"],
    [
      "a tool message with text",
      { role: "tool", content: [result("a"), { type: "text", text: "x" }] },
      "can't hold",
    ],
    ["a tool message as a string", { role: "tool", content: "done" }, "needs text"],
    [
      "a result inside an assistant message",
      { role: "assistant", content: [result("a")] },
      "can't hold",
    ],
    [
      "an SDK tool approval",
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "x", approved: true }],
      },
      "can't hold",
    ],
    ["one call id twice", { role: "assistant", content: [call("a"), call("a")] }, "twice"],
    ["a call id with spaces", { role: "assistant", content: [call("a b")] }, "plain id"],
    [
      "a call without a tool name",
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a" }] },
      "tool name",
    ],
    ["a part without a type", { role: "assistant", content: [{ text: "x" }] }, "type"],
    [
      "65 calls in one message",
      { role: "assistant", content: Array.from({ length: 65 }, (_, n) => call(`c${n}`)) },
      "at most 64",
    ],
  ])("refuses %s", (_case, message, error) => {
    const roles = ["user", "assistant", "tool"] as const;
    expect(() => checkMessage(message, roles)).toThrow(ChatHistoryError);
    expect(() => checkMessage(message, roles)).toThrow(error);
  });

  it("refuses a message larger than the column allows", () => {
    const text = "x".repeat(MAX_MESSAGE_BYTES);
    expect(() => checkMessage({ role: "user", content: text }, ["user"])).toThrow("at most");
  });

  it("answers a call the turn never answered with an error the model and the panel can read", () => {
    const pending = { toolCallId: "toolu_09", toolName: "rooms_list" };
    expect(unansweredResult(pending, { status: "interrupted", reason: "shutdown" })).toEqual({
      type: "tool-result",
      toolCallId: "toolu_09",
      toolName: "rooms_list",
      output: {
        type: "error-json",
        value: {
          error: "interrupted",
          detail:
            "The answer was cut off before this step's result was recorded. It may or may " +
            "not have run: check before doing it again.",
        },
      },
    });
    expect(unansweredResult(pending, { status: "stopped", reason: "step_limit" }).output).toEqual({
      type: "error-json",
      value: { error: "not_run", reason: "step_limit" },
    });
  });
});

describe("chatPreview", () => {
  it("shows the person's question without vayada's note (VAY-2519)", () => {
    const note = {
      type: "text",
      text: "Note from vayada (not written by the person): today is Wednesday, 9 December 2026. ".repeat(
        3,
      ),
      providerOptions: { vayada: { context: true } },
    };
    expect(
      chatPreview({
        role: "user",
        content: [note, { type: "text", text: "What arrives\n today?" }],
      }),
    ).toBe("What arrives today?");
    expect(chatPreview({ role: "user", content: "Plain question" })).toBe("Plain question");
    expect(chatPreview(null)).toBe("");
  });

  it("cuts a long question at 120 characters without splitting an emoji", () => {
    const long = `${"a".repeat(118)}😀😀😀`;
    const shown = chatPreview({ role: "user", content: [{ type: "text", text: long }] });
    expect(Array.from(shown)).toHaveLength(120);
    expect(shown.endsWith("😀…")).toBe(true);
  });
});
