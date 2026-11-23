// The person's Yes or No to an AI change (VAY-2524; plan 3.4.2):
//
//   GET  /api/ai/pending-actions/:id         the Yes/No card, written by vayada (changeCard.ts)
//   POST /api/ai/pending-actions/:id/answer  { answer: "yes", cardSha256 } or { answer: "no" }
//
// Only the person the AI asked answers, in a vayada app: a signed-in WorkOS session of the app's
// own client (the verifier refuses any other client), from an allowed Origin, never an AI. Access
// tokens travel in the Authorization header, which a page on another site can't send, so a
// cookie's CSRF token adds nothing here. A Yes counts only while the change waits for it, AI is on
// for the account, the conversation or connection that asked is still there, the person may make
// the change now, and the card reads as it did when they saw it; the one executor then runs it
// (executor.ts). The model never reaches these routes: they are on the never-list (neverList.ts).
import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import { hasActiveLinkedResource, hasPermission } from "@vayada/backend-authorization";
import type { HttpErrorEnvelope } from "@vayada/backend-http";
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";

import type { ChangeAction } from "../actions/defineChangeAction.js";
import { findChangeAction } from "../actions/registry.js";
import type {
  AiOperation,
  AiOperationCloseReason,
  AiOperationStore,
} from "../executor/operationStore.js";
import { createCardReader } from "./cardReader.js";
import {
  CardReadError,
  CardTargetMissingError,
  cardSha256,
  writeChangeCard,
  type CardReader,
  type ChangeCard,
} from "./changeCard.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
/** Route refusals that mean "this changed since": a person edited it meanwhile. */
const CHANGED = /(^|_)conflict$|_changed$/;

export type PendingActionState =
  /** Waiting for the person's Yes or No. */
  | "needs_answer"
  /** Yes given; vayada is making the change (or will try again shortly). */
  | "running"
  | "done"
  | "declined"
  | "expired"
  /** Something it names changed or is gone: nothing was changed. */
  | "changed"
  /** The person may not make this change (now). */
  | "not_allowed"
  /** AI was switched off for the account, or the connection that asked was removed. */
  | "stopped"
  /** vayada tried and the change did not happen. */
  | "failed"
  /** vayada tried several times and can't tell whether it happened. */
  | "unsure";

export type PendingActionView = {
  id: string;
  state: PendingActionState;
  surface: AiOperation["surface"];
  /** The AI app (MCP client id) or vayada's own assistant. */
  client: string;
  propertyId: string;
  action: string;
  /** While it waits: the answer is due by then. */
  answerBy: string | null;
  /** When the person said Yes (or No). */
  answeredAt: string | null;
  finishedAt: string | null;
  /** Null when vayada can't write it now (a record it names is gone or hidden). */
  card: ChangeCard | null;
  /** Sent back with the Yes: it binds the Yes to this card. Only while it waits. */
  cardSha256: string | null;
};

export type PendingActionRouteOptions = {
  /** The app whose read routes write the card, as the person (the root instance). */
  root: FastifyInstance;
  store: Pick<AiOperationStore, "find" | "closePending">;
  /** The one executor of AI changes (executor.ts): starts the change for one caller and runs it. */
  startAndRun(operationId: string): Promise<AiOperation | null>;
  /** AI is on for the account (its monthly budget is above 0). */
  aiEnabled(organizationId: string): Promise<boolean>;
  /** The in-app conversation or MCP connection that asked is still there. */
  channelActive(operation: AiOperation): Promise<boolean>;
  /** The vayada apps' origins (AUTH_ALLOWED_ORIGINS). */
  allowedOrigins: readonly string[];
  findAction?: (key: string) => ChangeAction | undefined;
  /** For tests: the card's reads. */
  reader?: (authorization: string) => CardReader;
  now?: () => Date;
};

type Refusal = { statusCode: 403 | 409 | 503; code: string; message: string };
type Settled = { operation: AiOperation; card: ChangeCard | null; refusal?: Refusal };
type Params = { id: string };

function sendError(
  reply: FastifyReply,
  refusal: Refusal | { statusCode: 404 | 422; code: string; message: string },
  pendingAction?: PendingActionView,
): FastifyReply {
  const body: HttpErrorEnvelope & { pendingAction?: PendingActionView } = {
    statusCode: refusal.statusCode,
    code: refusal.code,
    category:
      refusal.statusCode === 403
        ? "authorization"
        : refusal.statusCode === 404
          ? "not_found"
          : refusal.statusCode === 422
            ? "validation"
            : refusal.statusCode === 409
              ? "conflict"
              : "dependency",
    message: refusal.message,
    ...(pendingAction ? { pendingAction } : {}),
  };
  return reply.status(refusal.statusCode).send(body);
}

/**
 * Why this request may not see or answer: only the vayada apps' own signed-in sessions may. Staff
 * signed in as the person (WorkOS impersonation) may look at the card but never answer it.
 */
function firstPartyProblem(
  request: FastifyRequest,
  context: RequestContext,
  allowedOrigins: readonly string[],
  answering: boolean,
): string | null {
  if (context.audit.source === "agent" || context.delegation) {
    return "An AI can't see or answer its own changes.";
  }
  if (!context.actor.providerIdentity.sessionId) {
    return "Answer in vayada, signed in with your own login.";
  }
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return "Answer in a vayada app.";
  if (answering && context.actor.providerIdentity.impersonated) {
    return "You're signed in as someone else. Only they can answer.";
  }
  return null;
}

/** The person may make this change on this property now: its permissions and the property. */
export function mayMakeChange(
  context: RequestContext,
  action: Pick<ChangeAction, "permission" | "alsoNeeds">,
  propertyId: string,
): boolean {
  return (
    [action.permission, ...(action.alsoNeeds ?? [])].every((key) => hasPermission(context, key)) &&
    hasActiveLinkedResource(context, {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator"],
    })
  );
}

export function stateOf(operation: AiOperation, now: Date): PendingActionState {
  switch (operation.status) {
    case "pending":
      return operation.expiresAt && Date.parse(operation.expiresAt) <= now.getTime()
        ? "expired"
        : "needs_answer";
    case "running":
      return "running";
    case "done":
      return "done";
    case "closed":
      return operation.closeReason === "declined"
        ? "declined"
        : operation.closeReason === "expired"
          ? "expired"
          : operation.closeReason === "changed"
            ? "changed"
            : "stopped";
    case "failed": {
      const code = operation.errorCode ?? "";
      if (code === "gave_up") return "unsure";
      if (code === "not_allowed") return "not_allowed";
      return CHANGED.test(code) ? "changed" : "failed";
    }
  }
}

export function pendingActionView(
  operation: AiOperation,
  card: ChangeCard | null,
  now: Date,
  options: { notAllowed?: boolean } = {},
): PendingActionView {
  const waiting = stateOf(operation, now) === "needs_answer";
  const state = waiting && options.notAllowed ? "not_allowed" : stateOf(operation, now);
  return {
    id: operation.id,
    state,
    surface: operation.surface,
    client: operation.client,
    propertyId: operation.propertyId,
    action: operation.action,
    answerBy: waiting ? operation.expiresAt : null,
    answeredAt:
      operation.status === "closed"
        ? operation.closeReason === "declined"
          ? operation.finishedAt
          : null
        : operation.startedAt,
    finishedAt: operation.finishedAt,
    card,
    cardSha256: state === "needs_answer" && card ? cardSha256(operation, card) : null,
  };
}

export async function registerPendingActionRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & PendingActionRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const findAction = options.findAction ?? findChangeAction;
  const readerFor =
    options.reader ?? ((authorization: string) => createCardReader(options.root, authorization));

  const closedAs = (operation: AiOperation, reason: AiOperationCloseReason) =>
    operation.status === "closed" && operation.closeReason === reason;
  /** The refusal for a change that no longer waits: expired, or answered (maybe running). */
  const answeredRefusal = (operation: AiOperation): Refusal =>
    closedAs(operation, "expired")
      ? { statusCode: 409, code: "expired", message: "This question expired." }
      : { statusCode: 409, code: "already_answered", message: "This was answered already." };
  /** Anything unexpected: no detail leaves (store or executor errors name tables and states). */
  const unavailable = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    request.log.error({ err: error }, "AI change answer failed");
    return sendError(reply, {
      statusCode: 503,
      code: "unavailable",
      message: "vayada can't do this right now. Try again.",
    });
  };

  /** The person's own operation, or the reply that refused the request. */
  async function load(
    request: FastifyRequest<{ Params: Params }>,
    reply: FastifyReply,
    answering: boolean,
  ): Promise<{ context: RequestContext; operation: AiOperation } | undefined> {
    const context = requireAuthContext(request);
    const problem = firstPartyProblem(request, context, options.allowedOrigins, answering);
    if (problem) {
      sendError(reply, { statusCode: 403, code: "first_party_only", message: problem });
      return undefined;
    }
    const notFound = { statusCode: 404, code: "not_found", message: "No such change." } as const;
    const id = request.params.id;
    let operation: AiOperation | null = null;
    try {
      operation = UUID.test(id) ? await options.store.find(id) : null;
    } catch (error) {
      unavailable(request, reply, error);
      return undefined;
    }
    if (!operation) {
      sendError(reply, notFound);
      return undefined;
    }
    if (operation.userId !== context.actor.internalUserId) {
      sendError(reply, {
        statusCode: 403,
        code: "not_your_change",
        message: "Only the person the AI asked can answer. Nothing was changed.",
      });
      return undefined;
    }
    if (operation.organizationId !== context.selectedOrganization.organizationId) {
      sendError(reply, {
        statusCode: 403,
        code: "other_account",
        message: "This change belongs to another account. Switch to it to answer.",
      });
      return undefined;
    }
    return { context, operation };
  }

  /** Closes a waiting change; if it was answered meanwhile, the row as it is now. */
  async function close(operation: AiOperation, reason: AiOperationCloseReason) {
    return (
      (await options.store.closePending(operation.id, reason, now())) ??
      (await options.store.find(operation.id)) ??
      operation
    );
  }

  const authorizationOf = (request: FastifyRequest) => request.headers.authorization ?? "";

  async function cardOrNull(operation: AiOperation, authorization: string) {
    try {
      return await writeChangeCard(`${operation.action}@${operation.actionVersion}`, {
        propertyId: operation.propertyId,
        arguments: operation.arguments,
        reader: readerFor(authorization),
        now: now(),
        waiting: false,
      });
    } catch {
      return null;
    }
  }

  /**
   * A waiting change as it stands now: closed if it can't be answered any more (expired, AI off,
   * the connection gone, a record gone), with the refusal a Yes would get.
   */
  async function settle(
    context: RequestContext,
    operation: AiOperation,
    authorization: string,
  ): Promise<Settled> {
    if (stateOf(operation, now()) !== "needs_answer") {
      const current =
        operation.status === "pending" ? await close(operation, "expired") : operation;
      return {
        operation: current,
        card: await cardOrNull(current, authorization),
        refusal: answeredRefusal(current),
      };
    }
    // The refusal says what really happened: another tab may have answered it meanwhile.
    const closed = async (reason: AiOperationCloseReason, refusal: Refusal): Promise<Settled> => {
      const current = await close(operation, reason);
      return {
        operation: current,
        card: await cardOrNull(current, authorization),
        refusal: closedAs(current, reason) ? refusal : answeredRefusal(current),
      };
    };
    const action = findAction(`${operation.action}@${operation.actionVersion}`);
    if (!action) {
      return closed("changed", {
        statusCode: 409,
        code: "changed",
        message: "vayada no longer makes this change. Nothing was changed.",
      });
    }
    if (!(await options.aiEnabled(operation.organizationId))) {
      return closed("ai_switched_off", {
        statusCode: 409,
        code: "ai_switched_off",
        message: "AI is switched off for this account. Nothing was changed.",
      });
    }
    if (!(await options.channelActive(operation))) {
      return closed("revoked", {
        statusCode: 409,
        code: "revoked",
        message: "The AI that asked can't make changes any more. Nothing was changed.",
      });
    }
    const notAllowed: Refusal = {
      statusCode: 403,
      code: "not_allowed",
      message: "Your access no longer allows this change. Nothing was changed.",
    };
    if (!mayMakeChange(context, action, operation.propertyId)) {
      return { operation, card: await cardOrNull(operation, authorization), refusal: notAllowed };
    }
    try {
      const card = await writeChangeCard(action.key, {
        propertyId: operation.propertyId,
        arguments: operation.arguments,
        reader: readerFor(authorization),
        now: now(),
        waiting: true,
      });
      return { operation, card };
    } catch (error) {
      if (error instanceof CardTargetMissingError) {
        return closed("changed", {
          statusCode: 409,
          code: "changed",
          message: "This changed since the AI asked. Nothing was changed.",
        });
      }
      if (error instanceof CardReadError && error.reason === "not_allowed") {
        return { operation, card: null, refusal: notAllowed };
      }
      if (error instanceof CardReadError) {
        return {
          operation,
          card: null,
          refusal: {
            statusCode: 503,
            code: "unavailable",
            message: "vayada can't show this change right now. Try again.",
          },
        };
      }
      throw error;
    }
  }

  const viewOf = (settled: Settled) =>
    pendingActionView(settled.operation, settled.card, now(), {
      notAllowed: settled.refusal?.code === "not_allowed",
    });

  app.get<{ Params: Params }>("/pending-actions/:id", async (request, reply) => {
    const loaded = await load(request, reply, false);
    if (!loaded) return reply;
    try {
      const settled = await settle(loaded.context, loaded.operation, authorizationOf(request));
      if (settled.refusal?.statusCode === 503) return sendError(reply, settled.refusal);
      return viewOf(settled);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.post<{ Params: Params; Body: unknown }>(
    "/pending-actions/:id/answer",
    async (request, reply) => {
      const loaded = await load(request, reply, true);
      if (!loaded) return reply;
      const body = request.body as { answer?: unknown; cardSha256?: unknown } | null;
      const invalid = (message: string) =>
        sendError(reply, { statusCode: 422, code: "invalid_body", message });
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "answer" && key !== "cardSha256")
      ) {
        return invalid('Send { answer: "yes", cardSha256 } or { answer: "no" }.');
      }
      const given = body.answer === "yes" || body.answer === "no" ? body.answer : null;
      if (!given) return invalid('answer must be "yes" or "no".');
      if (
        given === "yes" &&
        (typeof body.cardSha256 !== "string" || !SHA256.test(body.cardSha256))
      ) {
        return invalid("A yes needs the cardSha256 of the card shown.");
      }
      const answer = async (
        context: RequestContext,
        operation: AiOperation,
        given: "yes" | "no",
        shownSha256: unknown,
      ) => {
        const authorization = authorizationOf(request);

        if (given === "no") {
          // Only the No that closed it counts: a second click finds it answered, as a second Yes does.
          const declined = await options.store.closePending(operation.id, "declined", now());
          const current = declined ?? (await options.store.find(operation.id)) ?? operation;
          const view = pendingActionView(current, await cardOrNull(current, authorization), now());
          if (declined?.closeReason === "declined") return view;
          return sendError(reply, answeredRefusal(current), view);
        }

        const settled = await settle(context, operation, authorization);
        if (settled.refusal) return sendError(reply, settled.refusal, viewOf(settled));
        // A card that reads differently now (a renamed room, another preview) is not what the person
        // said yes to.
        if (cardSha256(operation, settled.card!) !== shownSha256) {
          const current = await close(operation, "changed");
          return sendError(
            reply,
            closedAs(current, "changed")
              ? {
                  statusCode: 409,
                  code: "changed",
                  message: "This changed since you saw it. Nothing was changed.",
                }
              : answeredRefusal(current),
            pendingActionView(current, settled.card, now()),
          );
        }
        // One winner runs it; a second tab or a double click gets the same run. The card stays the
        // one the person said yes to.
        const after = (await options.startAndRun(operation.id)) ?? operation;
        return pendingActionView(after, settled.card, now());
      };
      try {
        return await answer(loaded.context, loaded.operation, given, body.cardSha256);
      } catch (error) {
        return unavailable(request, reply, error);
      }
    },
  );
}
