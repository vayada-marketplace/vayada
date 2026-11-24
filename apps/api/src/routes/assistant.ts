import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import type { HttpErrorEnvelope } from "@vayada/backend-http";
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";

import type { AssistantRuntime } from "../ai/assistant/assistantRuntime.js";
import type { AssistantEvent } from "../ai/assistant/assistantTurn.js";
import type { AssistantApp, ConversationSummary } from "../ai/assistant/conversationStore.js";

/**
 * VAY-2518: the in-app assistant's API, for the panel in PMS and Booking Admin (VAY-2519).
 *
 * - POST /api/ai/assistant/turns: asks a question and streams the turn as server-sent events (the
 *   turn's ids, answer text, tool progress, the end). A comment every 15 s keeps the connection
 *   open through the load balancer. If the stream breaks, the turn goes on: the panel reloads the
 *   conversation from GET .../conversations/:id.
 * - GET /api/ai/assistant/conversations: the person's own chats for a property, newest first.
 * - GET /api/ai/assistant/conversations/:id: one chat with its turns and messages.
 * - POST /api/ai/assistant/conversations/:id/stop: the Stop button (with the turn's id, so a late
 *   click never stops the next question).
 *
 * Only the signed-in person, for a property they may use, sees or continues their own chats. An
 * AI never calls these (never list: /api/ai/ is AI management), and a delegated context is refused.
 * The drain at shutdown is a root preClose hook (app.ts), so it starts first.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The store's own timestamp form (to_json of a timestamptz).
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const APPS: readonly AssistantApp[] = ["pms", "booking_admin"];
export const MAX_QUESTION_CHARS = 4_000;
export const KEEP_ALIVE_MS = 15_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type ScopeInput = { propertyId?: unknown; app?: unknown };
type TurnBody = ScopeInput & { question?: unknown; conversationId?: unknown };

function sendError(
  reply: FastifyReply,
  statusCode: 403 | 404 | 422,
  code: string,
  message: string,
): FastifyReply {
  const category =
    statusCode === 403 ? "authorization" : statusCode === 404 ? "not_found" : "validation";
  const body: HttpErrorEnvelope = { statusCode, code, category, message };
  return reply.status(statusCode).send(body);
}

/** The signed-in person in a hotel account, or the error already sent. */
function personOf(request: FastifyRequest, reply: FastifyReply): RequestContext | undefined {
  const context = requireAuthContext(request);
  if (context.audit.source === "agent") {
    sendError(reply, 403, "forbidden", "The assistant is not available to AI actions.");
    return undefined;
  }
  if (context.selectedOrganization.kind !== "hotel_group") {
    sendError(reply, 403, "forbidden", "The assistant belongs to a hotel account.");
    return undefined;
  }
  return context;
}

function scopeOf(input: ScopeInput | undefined, reply: FastifyReply) {
  const propertyId = input?.propertyId;
  const app = input?.app;
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) {
    sendError(reply, 422, "invalid_request", "propertyId must be a UUID.");
    return undefined;
  }
  if (typeof app !== "string" || !APPS.includes(app as AssistantApp)) {
    sendError(reply, 422, "invalid_request", `app must be one of: ${APPS.join(", ")}.`);
    return undefined;
  }
  return { propertyId, app: app as AssistantApp };
}

const forbidden = (reply: FastifyReply) =>
  sendError(reply, 403, "forbidden", "You can't use the assistant for this property.");

function encodeCursor(chat: ConversationSummary): string {
  return Buffer.from(JSON.stringify([chat.lastActivityAt, chat.id])).toString("base64url");
}

function decodeCursor(cursor: string): { lastActivityAt: string; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      TIMESTAMP.test(value[0]) &&
      !Number.isNaN(Date.parse(value[0])) &&
      typeof value[1] === "string" &&
      UUID.test(value[1])
    )
      return { lastActivityAt: value[0], id: value[1] };
  } catch {
    // fall through
  }
  return null;
}

export async function registerAssistantRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { runtime: AssistantRuntime; keepAliveMs?: number },
): Promise<void> {
  const { runtime } = options;

  app.post<{ Body: TurnBody }>("/assistant/turns", async (request, reply) => {
    const session = personOf(request, reply);
    if (!session) return reply;
    const scope = scopeOf(request.body, reply);
    if (!scope) return reply;
    const { question, conversationId } = request.body ?? {};
    if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION_CHARS)
      return sendError(
        reply,
        422,
        "invalid_request",
        `question must be text of 1 to ${MAX_QUESTION_CHARS} characters.`,
      );
    if (
      conversationId !== undefined &&
      (typeof conversationId !== "string" || !UUID.test(conversationId))
    )
      return sendError(reply, 422, "invalid_request", "conversationId must be a UUID.");

    const run = await runtime.prepareTurn({
      session,
      ...scope,
      ...(conversationId ? { conversationId } : {}),
      question,
      // Unique across API tasks and restarts (it keys the AI usage ledger), unlike request.id.
      requestId: randomUUID(),
    });
    if (!run) return forbidden(reply);

    // Server-sent events through a PassThrough (not reply.hijack), so CORS and the other
    // response hooks still apply.
    const stream = new PassThrough();
    let open = true;
    const write = (text: string) => {
      if (open) stream.write(text);
    };
    const send = (event: AssistantEvent) =>
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const keepAlive = setInterval(
      () => write(": keep-alive\n\n"),
      options.keepAliveMs ?? KEEP_ALIVE_MS,
    );
    keepAlive.unref();
    // The browser left: the turn goes on and is stored; the panel reloads it.
    reply.raw.on("close", () => {
      open = false;
    });
    run(send)
      .catch((error: unknown) => {
        request.log.error(
          { err: { name: error instanceof Error ? error.name : typeof error } },
          "Assistant turn failed",
        );
        send({ type: "end", status: "failed", reason: "internal_error" });
      })
      .finally(() => {
        clearInterval(keepAlive);
        open = false;
        stream.end();
      });
    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .send(stream);
  });

  app.get<{ Querystring: ScopeInput & { cursor?: string; limit?: string } }>(
    "/assistant/conversations",
    async (request, reply) => {
      const session = personOf(request, reply);
      if (!session) return reply;
      const scope = scopeOf(request.query, reply);
      if (!scope) return reply;
      const limit = request.query.limit === undefined ? DEFAULT_LIMIT : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return sendError(reply, 422, "invalid_request", `limit must be 1 to ${MAX_LIMIT}.`);
      const before =
        request.query.cursor === undefined ? undefined : decodeCursor(request.query.cursor);
      if (before === null) return sendError(reply, 422, "invalid_request", "cursor is not valid.");

      const chats = await runtime.list(
        { session, ...scope },
        { limit: limit + 1, ...(before ? { before } : {}) },
      );
      if (chats === "forbidden") return forbidden(reply);
      const items = chats.slice(0, limit);
      return {
        items,
        nextCursor: chats.length > limit ? encodeCursor(items[items.length - 1]!) : null,
      };
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: ScopeInput }>(
    "/assistant/conversations/:conversationId",
    async (request, reply) => {
      const session = personOf(request, reply);
      if (!session) return reply;
      const scope = scopeOf(request.query, reply);
      if (!scope) return reply;
      const view = await runtime.read({ session, ...scope }, request.params.conversationId);
      if (view === "forbidden") return forbidden(reply);
      if (!view) return sendError(reply, 404, "not_found", "No such conversation.");
      return view;
    },
  );

  app.post<{ Params: { conversationId: string }; Body: ScopeInput & { turnId?: unknown } }>(
    "/assistant/conversations/:conversationId/stop",
    async (request, reply) => {
      const session = personOf(request, reply);
      if (!session) return reply;
      const scope = scopeOf(request.body, reply);
      if (!scope) return reply;
      const turnId = request.body?.turnId;
      if (turnId !== undefined && (typeof turnId !== "string" || !UUID.test(turnId)))
        return sendError(reply, 422, "invalid_request", "turnId must be a UUID.");
      const stopped = await runtime.stop(
        { session, ...scope },
        request.params.conversationId,
        turnId?.toLowerCase(),
      );
      if (stopped === "forbidden") return forbidden(reply);
      return { stopped };
    },
  );
}
