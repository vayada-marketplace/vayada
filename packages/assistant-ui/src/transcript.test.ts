import { describe, expect, it } from "vitest";
import type { ConversationView } from "./assistantApi";
import { questionText, runningTurn, transcriptOf } from "./transcript";

const AT = "2026-12-09T09:41:00.000Z";

function view(
  turns: Partial<ConversationView["turns"][number]>[],
  messages: { turnId: string; message: ConversationView["messages"][number]["message"] }[],
): ConversationView {
  return {
    id: "c1",
    readOnlyReason: null,
    createdAt: AT,
    lastActivityAt: AT,
    turns: turns.map((turn, index) => ({
      id: `t${index + 1}`,
      seq: index + 1,
      status: "done",
      endReason: null,
      startedAt: AT,
      endedAt: AT,
      ...turn,
    })),
    messages: messages.map((row, index) => ({ seq: index + 1, createdAt: AT, ...row })),
  };
}

const contextNote = {
  type: "text",
  text: "Today is 2026-12-09. Property: Hotel Alpenrose.",
  providerOptions: { vayada: { context: true } },
};

describe("questionText", () => {
  it("shows the person's words without vayada's note", () => {
    expect(questionText([contextNote, { type: "text", text: "What arrives today?" }])).toBe(
      "What arrives today?",
    );
    expect(questionText("Plain question")).toBe("Plain question");
  });
});

describe("transcriptOf", () => {
  it("shows the question, one progress line per tool call with its result, then the answer", () => {
    const items = transcriptOf(
      view(
        [{}],
        [
          {
            turnId: "t1",
            message: { role: "user", content: [contextNote, { type: "text", text: "Rooms?" }] },
          },
          {
            turnId: "t1",
            message: {
              role: "assistant",
              content: [
                { type: "reasoning", text: "secret thinking" },
                { type: "tool-call", toolCallId: "a", toolName: "rooms_list", input: { x: 1 } },
                { type: "tool-call", toolCallId: "b", toolName: "calendar_days", input: {} },
                { type: "tool-call", toolCallId: "c", toolName: "properties_list", input: {} },
              ],
            },
          },
          {
            turnId: "t1",
            message: {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "a",
                  toolName: "rooms_list",
                  output: { type: "json", value: { rooms: [] } },
                },
                {
                  type: "tool-result",
                  toolCallId: "b",
                  toolName: "calendar_days",
                  output: { type: "error-json", value: { code: "forbidden" } },
                },
                {
                  type: "tool-result",
                  toolCallId: "c",
                  toolName: "properties_list",
                  output: { type: "error-json", value: { code: "not_run" } },
                },
              ],
            },
          },
          {
            turnId: "t1",
            message: { role: "assistant", content: [{ type: "text", text: "You have 12 rooms." }] },
          },
        ],
      ),
    );
    expect(items).toEqual([
      { kind: "question", key: "q-1", text: "Rooms?" },
      { kind: "progress", key: "t-a", tool: "rooms_list", status: "ok" },
      { kind: "progress", key: "t-b", tool: "calendar_days", status: "failed" },
      { kind: "progress", key: "t-c", tool: "properties_list", status: "skipped" },
      { kind: "answer", key: "a-4", text: "You have 12 rooms.", at: AT },
    ]);
    // Thinking and tool inputs/answers never show as text.
    expect(JSON.stringify(items)).not.toMatch(/secret thinking|"rooms":/);
  });

  it("leaves a call without a result as still running", () => {
    const items = transcriptOf(
      view(
        [{ status: "running", endedAt: null }],
        [
          { turnId: "t1", message: { role: "user", content: "Rooms?" } },
          {
            turnId: "t1",
            message: {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "a", toolName: "rooms_list", input: {} }],
            },
          },
        ],
      ),
    );
    expect(items[1]).toMatchObject({ kind: "progress", status: "running" });
  });

  it("says how a turn ended when it didn't simply finish, after that turn's messages", () => {
    const items = transcriptOf(
      view(
        [
          { status: "interrupted", endReason: "shutdown" },
          { status: "done" },
          { status: "failed", endReason: "allowance_used_up" },
        ],
        [
          { turnId: "t1", message: { role: "user", content: "One" } },
          { turnId: "t1", message: { role: "assistant", content: "Half an ans" } },
          { turnId: "t2", message: { role: "user", content: "Two" } },
          { turnId: "t2", message: { role: "assistant", content: "Done." } },
          { turnId: "t3", message: { role: "user", content: "Three" } },
        ],
      ),
    );
    expect(items.map((item) => item.kind)).toEqual([
      "question",
      "answer",
      "ended",
      "question",
      "answer",
      "question",
      "ended",
    ]);
    expect(items[2]).toMatchObject({ turnId: "t1", status: "interrupted", reason: "shutdown" });
    expect(items[6]).toMatchObject({ turnId: "t3", status: "failed", reason: "allowance_used_up" });
  });

  it("shows a change the AI asked for as vayada's card, in place of its progress line", () => {
    const pendingActionId = "8f3c2a10-1b2c-4d5e-8f90-123456789abc";
    const items = transcriptOf(
      view(
        [{ status: "waiting_for_answer" }],
        [
          { turnId: "t1", message: { role: "user", content: "Block room 12 from the 12th" } },
          {
            turnId: "t1",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Room 12 is free, so I can block it." },
                { type: "tool-call", toolCallId: "a", toolName: "calendar_days", input: {} },
                { type: "tool-call", toolCallId: "b", toolName: "room_block_create", input: {} },
              ],
            },
          },
          {
            turnId: "t1",
            message: {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "a",
                  toolName: "calendar_days",
                  output: { type: "json", value: {} },
                },
                {
                  type: "tool-result",
                  toolCallId: "b",
                  toolName: "room_block_create",
                  output: { type: "json", value: { ok: true, pendingActionId, status: "pending" } },
                },
              ],
            },
          },
        ],
      ),
    );
    expect(items).toEqual([
      { kind: "question", key: "q-1", text: "Block room 12 from the 12th" },
      { kind: "progress", key: "t-a", tool: "calendar_days", status: "ok" },
      { kind: "answer", key: "a-2", text: "Room 12 is free, so I can block it.", at: AT },
      { kind: "change", key: `c-t1-${pendingActionId}`, pendingActionId },
    ]);
  });

  it("puts a turn's card after its text, also when the text was stored after the result", () => {
    const pendingActionId = "8f3c2a10-1b2c-4d5e-8f90-123456789abc";
    const items = transcriptOf(
      view(
        [{ status: "waiting_for_answer" }, { status: "done" }],
        [
          { turnId: "t1", message: { role: "user", content: "Block room 12" } },
          {
            turnId: "t1",
            message: {
              role: "assistant",
              content: [
                { type: "tool-call", toolCallId: "b", toolName: "room_block_create", input: {} },
              ],
            },
          },
          {
            turnId: "t1",
            message: {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "b",
                  toolName: "room_block_create",
                  output: { type: "json", value: { pendingActionId } },
                },
              ],
            },
          },
          { turnId: "t1", message: { role: "assistant", content: "Tap Yes if it's right." } },
          { turnId: "t2", message: { role: "user", content: "And room 14?" } },
        ],
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["question", "answer", "change", "question"]);
  });

  it("shows a change asked again in a later turn there too, once per turn", () => {
    const pendingActionId = "8f3c2a10-1b2c-4d5e-8f90-123456789abc";
    const asked = (turnId: string, seq: number) => [
      { turnId, message: { role: "user" as const, content: `Block room 12 (${seq})` } },
      {
        turnId,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call",
              toolCallId: `${turnId}-a`,
              toolName: "room_block_create",
              input: {},
            },
            {
              type: "tool-call",
              toolCallId: `${turnId}-b`,
              toolName: "room_block_create",
              input: {},
            },
          ],
        },
      },
      {
        turnId,
        message: {
          role: "tool" as const,
          content: [`${turnId}-a`, `${turnId}-b`].map((toolCallId) => ({
            type: "tool-result",
            toolCallId,
            toolName: "room_block_create",
            output: { type: "json", value: { pendingActionId } },
          })),
        },
      },
    ];
    const items = transcriptOf(
      view(
        [{ status: "waiting_for_answer" }, { status: "waiting_for_answer" }],
        [...asked("t1", 1), ...asked("t2", 2)],
      ),
    );
    expect(items.filter((item) => item.kind === "change").map((item) => item.key)).toEqual([
      `c-t1-${pendingActionId}`,
      `c-t2-${pendingActionId}`,
    ]);
  });

  it("makes no card of a result that only looks like one", () => {
    const items = transcriptOf(
      view(
        [{}],
        [
          { turnId: "t1", message: { role: "user", content: "Rooms?" } },
          {
            turnId: "t1",
            message: {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "a", toolName: "rooms_list", input: {} }],
            },
          },
          {
            turnId: "t1",
            message: {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "a",
                  toolName: "rooms_list",
                  output: { type: "json", value: { pendingActionId: "not-an-id" } },
                },
              ],
            },
          },
        ],
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["question", "progress"]);
  });

  it("finds the turn that is still running", () => {
    const chat = view([{ status: "done" }, { status: "running", endedAt: null }], []);
    expect(runningTurn(chat)?.id).toBe("t2");
    expect(runningTurn(view([{ status: "done" }], []))).toBeUndefined();
  });
});
