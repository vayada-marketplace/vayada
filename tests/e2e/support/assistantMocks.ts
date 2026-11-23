import type { Page } from "@playwright/test";
import { fulfillCorsPreflight } from "./cors";

/**
 * A fake of the in-app assistant's API (VAY-2518 routes, apps/api routes/assistant.ts) for the
 * panel's browser specs (VAY-2519). The shared shell mocks answer every assistant route with 404
 * (switched off, as in production); `routeAssistant` switches it on for one page.
 */

type ToolLine = { name: string; result?: "ok" | "failed" | "not_run" };
type TurnShape = {
  question: string;
  tools?: ToolLine[];
  answer?: string;
  status?: "running" | "done" | "waiting_for_answer" | "stopped" | "failed" | "interrupted";
  endReason?: string | null;
};
export type FakeChat = {
  id: string;
  readOnlyReason: "contract_changed" | "too_long" | null;
  createdAt: string;
  lastActivityAt: string;
  turns: {
    id: string;
    seq: number;
    status: string;
    endReason: string | null;
    startedAt: string;
    endedAt: string | null;
  }[];
  messages: {
    seq: number;
    turnId: string;
    message: { role: string; content: unknown };
    createdAt: string;
  }[];
};
export type TurnRequest = {
  propertyId: string;
  app: string;
  question: string;
  conversationId?: string;
};

export const CHAT_AT = "2026-12-09T08:41:00.000Z";

/** A stored chat as the API returns it: questions with vayada's note, tool calls and results, answers. */
export function chatView(
  id: string,
  turns: TurnShape[],
  readOnlyReason: FakeChat["readOnlyReason"] = null,
): FakeChat {
  const messages: FakeChat["messages"] = [];
  const push = (turnId: string, message: FakeChat["messages"][number]["message"]) =>
    messages.push({ seq: messages.length + 1, turnId, message, createdAt: CHAT_AT });
  const storedTurns = turns.map((turn, index) => {
    const turnId = `${id}-turn-${index + 1}`;
    push(turnId, {
      role: "user",
      content: [
        {
          type: "text",
          text: "Today is 2026-12-09.",
          providerOptions: { vayada: { context: true } },
        },
        { type: "text", text: turn.question },
      ],
    });
    const tools = turn.tools ?? [];
    if (tools.length > 0) {
      push(turnId, {
        role: "assistant",
        content: tools.map((tool, call) => ({
          type: "tool-call",
          toolCallId: `${turnId}-call-${call}`,
          toolName: tool.name,
          input: {},
        })),
      });
      const results = tools.filter((tool) => tool.result);
      if (results.length > 0)
        push(turnId, {
          role: "tool",
          content: tools.flatMap((tool, call) =>
            tool.result
              ? [
                  {
                    type: "tool-result",
                    toolCallId: `${turnId}-call-${call}`,
                    toolName: tool.name,
                    output:
                      tool.result === "ok"
                        ? { type: "json", value: { ok: true } }
                        : {
                            type: "error-json",
                            value: { code: tool.result === "failed" ? "forbidden" : "not_run" },
                          },
                  },
                ]
              : [],
          ),
        });
    }
    if (turn.answer)
      push(turnId, { role: "assistant", content: [{ type: "text", text: turn.answer }] });
    const status = turn.status ?? "done";
    return {
      id: turnId,
      seq: index + 1,
      status,
      endReason: turn.endReason ?? null,
      startedAt: CHAT_AT,
      endedAt: status === "running" ? null : CHAT_AT,
    };
  });
  return {
    id,
    readOnlyReason,
    createdAt: CHAT_AT,
    lastActivityAt: CHAT_AT,
    turns: storedTurns,
    messages,
  };
}

/** The events of one answer, as the API streams them. */
export function sseBody(events: object[]): string {
  return events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join(": keep-alive\n\n");
}

export async function routeAssistant(
  page: Page,
  options: {
    chats?: FakeChat[];
    /** What a question gets: the streamed events and the chat as stored afterwards. */
    answer?: (
      request: TurnRequest,
      call: number,
    ) => { events: object[]; stored?: FakeChat; wait?: Promise<void> };
    /** Holds a chat's read until the promise settles (to look at the panel meanwhile). */
    holdRead?: (conversationId: string) => Promise<void> | undefined;
    /** The chat as stored after Stop. */
    onStop?: (conversationId: string) => FakeChat | undefined;
  } = {},
) {
  const chats = new Map((options.chats ?? []).map((chat) => [chat.id, chat]));
  const seen = { turns: [] as TurnRequest[], stops: [] as unknown[], lists: [] as URL[] };
  await page.route(/\/api\/ai\/assistant\//, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return fulfillCorsPreflight(route);
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path.endsWith("/api/ai/assistant/conversations")) {
      seen.lists.push(url);
      const items = [...chats.values()].map((chat) => ({
        id: chat.id,
        readOnlyReason: chat.readOnlyReason,
        preview:
          (chat.messages[0]?.message.content as { text: string }[] | undefined)?.[1]?.text ?? "",
        createdAt: chat.createdAt,
        lastActivityAt: chat.lastActivityAt,
      }));
      return route.fulfill({ json: { items, nextCursor: null } });
    }
    const stop = path.match(/\/api\/ai\/assistant\/conversations\/([^/]+)\/stop$/);
    if (request.method() === "POST" && stop) {
      seen.stops.push(request.postDataJSON());
      const stored = options.onStop?.(stop[1]!);
      if (stored) chats.set(stored.id, stored);
      return route.fulfill({ json: { stopped: true } });
    }
    const read = path.match(/\/api\/ai\/assistant\/conversations\/([^/]+)$/);
    if (request.method() === "GET" && read) {
      await options.holdRead?.(read[1]!);
      const chat = chats.get(read[1]!);
      return chat
        ? route.fulfill({ json: chat })
        : route.fulfill({
            status: 404,
            json: { statusCode: 404, code: "not_found", message: "No such chat." },
          });
    }
    if (request.method() === "POST" && path.endsWith("/api/ai/assistant/turns")) {
      const body = request.postDataJSON() as TurnRequest;
      seen.turns.push(body);
      const reply = options.answer?.(body, seen.turns.length) ?? { events: [] };
      // The answer arrives only once the spec lets it (a slow model, as far as the panel knows).
      if (reply.wait) await reply.wait;
      if (reply.stored) chats.set(reply.stored.id, reply.stored);
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: sseBody(reply.events),
      });
    }
    return route.fulfill({
      status: 404,
      json: { statusCode: 404, code: "not_found", message: "Not found" },
    });
  });
  return seen;
}
