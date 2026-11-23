import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import type { AiActionLog } from "../actionLog/actionLog.js";
import { listActionsFor, toolDefinition } from "../actions/registry.js";
import { runRouteAction } from "../actions/runRouteAction.js";
import type { AssistantTool } from "./assistantTurn.js";

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
    model: string;
  },
): AssistantTool[] {
  return listActionsFor(options.context).map((action) => ({
    definition: toolDefinition(action),
    run: async (input, call) =>
      runRouteAction(app, await options.contextFor(call.toolCallId), action, input, {
        log: options.log,
        client: "in_app_assistant",
        externalCallId: call.toolCallId,
        model: options.model,
      }),
  }));
}
