import { randomUUID } from "node:crypto";

import {
  AuthError,
  delegatedPropertyIds,
  DelegationRefusedError,
  resolveDelegatedContext,
  type AuthorizationResolver,
  type IdentityRepository,
  type RequestContext,
} from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import type { AiActionLog } from "../actionLog/actionLog.js";
import { listActionsFor, toolDefinition } from "../actions/registry.js";
import { runRouteAction } from "../actions/runRouteAction.js";
import type { AssistantToolsFor } from "./assistantRuntime.js";
import type { AssistantTool, ToolOutcome } from "./assistantTurn.js";
import type { ChangeAction } from "../actions/defineChangeAction.js";
import { changeTools, type AssistantChangeProposer } from "./changeTools.js";

/**
 * The registry's in-app actions this user may use, as the assistant's tools (VAY-2518). Each call
 * runs the action's route as the user, with a delegated context of its own, and writes its one
 * AI action log row (VAY-2508), joined to the provider's tool-call id.
 */
export function registryTools(
  app: FastifyInstance,
  options: {
    /** The user's in-app delegated context: it decides which actions are offered. */
    context: RequestContext;
    /** A fresh delegated context for each tool call (the auth hook refuses a reused one). */
    contextFor: (toolCallId: string) => Promise<RequestContext>;
    log: AiActionLog;
    /** The model route vayada pays for, as logged with each call. */
    model: string | null;
  },
): AssistantTool[] {
  return listActionsFor(options.context).map((action) => ({
    definition: toolDefinition(action),
    run: async (input, call) => {
      const result = runRouteAction(app, await options.contextFor(call.toolCallId), action, input, {
        log: options.log,
        client: "in_app_assistant",
        externalCallId: call.toolCallId,
        model: options.model,
      });
      // Stop and the shutdown cut don't wait for a slow route (only reads run as tools today;
      // the route still finishes and logs its row).
      return Promise.race([result, abandoned(call.signal)]);
    },
  }));
}

/** `providerIdentity.impersonated` (VAY-2524 follow-up, #4225); absent before it lands. */
export function isImpersonated(session: RequestContext): boolean {
  const identity = session.actor.providerIdentity as
    | (typeof session.actor.providerIdentity & { impersonated?: true })
    | undefined;
  return identity?.impersonated === true;
}

function abandoned(signal: AbortSignal): Promise<ToolOutcome> {
  return new Promise((resolve) => {
    const answer = () =>
      resolve({
        ok: false,
        error: {
          code: "stopped",
          message: "Stopped while this was running; its answer was not used.",
        },
      });
    if (signal.aborted) answer();
    else signal.addEventListener("abort", answer, { once: true });
  });
}

/**
 * The assistant's tools for a signed-in person and one property, as in production: the person's
 * delegated in-app context, resolved fresh from the database and narrowed to that property, once
 * to choose the tools and again for every tool call. Undefined when the person may not use the
 * property (or their membership is gone).
 */
export function delegatedAssistantTools(
  app: FastifyInstance,
  options: {
    identityRepository: IdentityRepository;
    authorizationResolver: AuthorizationResolver;
    log: AiActionLog;
    /** The model route in use, for the log; null while AI is off. */
    model: () => string | null;
    /**
     * VAY-2524's proposer, only with AI_CHANGES_ENABLED: the change actions on the in-app surface
     * become tools that ask for a change. Without it the assistant only reads.
     */
    propose?: AssistantChangeProposer;
    /** For tests: the change actions to offer from (the registry's by default). */
    changeActions?: readonly ChangeAction[];
  },
): AssistantToolsFor {
  return async ({ session, propertyId, conversationId }) => {
    const delegate = (toolCallId: string) =>
      resolveDelegatedContext(
        options.identityRepository,
        {
          userId: session.actor.internalUserId,
          organizationId: session.selectedOrganization.organizationId,
          delegation: { channel: "in_app", toolCallId, conversationId },
          propertyIds: [propertyId],
        },
        { authorizationResolver: options.authorizationResolver },
      );
    let context: RequestContext;
    try {
      context = await delegate(`assistant-${randomUUID()}`);
    } catch (error) {
      if (error instanceof AuthError || error instanceof DelegationRefusedError) return undefined;
      throw error;
    }
    if (!delegatedPropertyIds(context).includes(propertyId)) return undefined;
    const model = options.model();
    const reads = registryTools(app, { context, contextFor: delegate, log: options.log, model });
    // Staff signed in as the person (WorkOS impersonation, flagged by VAY-2524's follow-up) only
    // read: a change they asked for would wait in the person's chat as if the person had asked.
    if (!options.propose || isImpersonated(session)) return reads;
    return [
      ...reads,
      ...changeTools({
        context,
        contextFor: delegate,
        propose: options.propose,
        model,
        ...(options.changeActions ? { actions: options.changeActions } : {}),
      }),
    ];
  };
}
