import type { Page } from "@playwright/test";
import { fulfillCorsPreflight } from "./cors";

/** A change the AI asked for, as `GET /api/ai/pending-actions/:id` returns it (VAY-2524). */
export type PendingActionView = {
  id: string;
  state: string;
  surface: string;
  client: string;
  propertyId: string;
  action: string;
  answerBy: string | null;
  answeredAt: string | null;
  finishedAt: string | null;
  card: {
    question: string;
    doneTitle: string;
    yesLabel: string;
    details: { label: string; value: string }[];
    effects: string[];
  } | null;
  cardSha256: string | null;
};

/** Board 03's room block, waiting for its answer until `answerBy`. */
export function roomBlockAction(
  id: string,
  answerBy: string,
  changes: Partial<PendingActionView> = {},
): PendingActionView {
  return {
    id,
    state: "needs_answer",
    surface: "in_app",
    client: "in_app_assistant",
    propertyId: "f6853000-0000-4000-8000-000000000001",
    action: "room_block_create@1",
    answerBy,
    answeredAt: null,
    finishedAt: null,
    card: {
      question: "Block room 12 for 3 nights?",
      doneTitle: "Blocked room 12 for 3 nights",
      yesLabel: "Yes, block room 12",
      details: [
        { label: "Room", value: "12 · Deluxe Double" },
        { label: "Nights", value: "Sat 12, Sun 13 and Mon 14 Dec" },
        { label: "Reason", value: "Maintenance: shower repair" },
      ],
      effects: [
        "Guests can't book room 12 on these nights.",
        "If channels are connected, they get the new availability.",
      ],
    },
    cardSha256: "a".repeat(64),
    ...changes,
  };
}

/**
 * A fake of the in-app assistant's API (VAY-2518 routes, apps/api routes/assistant.ts) for the
 * panel's browser specs (VAY-2519). The shared shell mocks answer every assistant route with 404
 * (switched off, as in production); `routeAssistant` switches it on for one page.
 */

type ToolLine = {
  name: string;
  result?: "ok" | "failed" | "not_run";
  /** A change the AI asked for (VAY-2524): the result names the pending action. */
  pendingActionId?: string;
};
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
                    output: tool.pendingActionId
                      ? {
                          type: "json",
                          value: {
                            ok: true,
                            pendingActionId: tool.pendingActionId,
                            status: "pending",
                          },
                        }
                      : tool.result === "ok"
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
    /** The changes the AI asked for (VAY-2524 pending actions), by id, as the API shows them. */
    pendingActions?: Record<string, PendingActionView>;
    /** The answer route: the change as it is after the answer, or a refusal with it. */
    onAnswer?: (
      id: string,
      body: { answer: "yes" | "no"; cardSha256?: string },
    ) => { view: PendingActionView; refusal?: { statusCode: number; code: string } };
  } = {},
) {
  const chats = new Map((options.chats ?? []).map((chat) => [chat.id, chat]));
  const seen = {
    turns: [] as TurnRequest[],
    stops: [] as unknown[],
    lists: [] as URL[],
    answers: [] as { id: string; body: unknown }[],
  };
  const actions = new Map(Object.entries(options.pendingActions ?? {}));
  await page.route(/\/api\/ai\/pending-actions\//, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return fulfillCorsPreflight(route);
    const match = new URL(request.url()).pathname.match(
      /\/api\/ai\/pending-actions\/([^/]+)(\/answer)?$/,
    );
    const id = match?.[1] ?? "";
    if (request.method() === "POST" && match?.[2]) {
      const body = request.postDataJSON() as { answer: "yes" | "no"; cardSha256?: string };
      seen.answers.push({ id, body });
      const answered = options.onAnswer?.(id, body);
      if (!answered) return route.fulfill({ status: 503, json: { code: "unavailable" } });
      actions.set(id, answered.view);
      return answered.refusal
        ? route.fulfill({
            status: answered.refusal.statusCode,
            json: {
              statusCode: answered.refusal.statusCode,
              code: answered.refusal.code,
              message: "Refused.",
              pendingAction: answered.view,
            },
          })
        : route.fulfill({ json: answered.view });
    }
    const view = actions.get(id);
    return view
      ? route.fulfill({ json: view })
      : route.fulfill({ status: 404, json: { statusCode: 404, code: "not_found" } });
  });
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
