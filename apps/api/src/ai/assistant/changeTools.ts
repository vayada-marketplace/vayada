// The in-app assistant's change tools (VAY-2518 with VAY-2524): asking for a change, never making
// one. Each call hands the change to VAY-2524's proposer (ai/changes/proposeChange.ts), which
// checks it and records it as one pending operation; vayada then shows the person a Yes/No card
// (VAY-2519) and only their Yes makes the change. The tool's answer is the proposer's result,
// unchanged: the panel reads its `pendingActionId`, and the turn ends to wait for the answer.
import type { RequestContext } from "@vayada/backend-auth";
import { z } from "zod";

import type { ChangeAction } from "../actions/defineChangeAction.js";
import { CHANGE_ACTIONS, surfaceOf } from "../actions/registry.js";
import type { AssistantTool } from "./assistantTurn.js";

/** What the in-app assistant sends the proposer (VAY-2524's ProposeChangeRequest). */
export type InAppChangeRequest = {
  /** "room_block_create@1" */
  action: string;
  arguments: unknown;
  client: "in_app_assistant";
  /** The turn: a retried step stays in it, a new question is a new one. */
  requestScope: string;
  /** The provider's tool-call id: logged, never the identity. */
  externalCallId: string;
  model: string | null;
};

/** VAY-2524's ProposeChangeResult. */
export type InAppChangeResult =
  | {
      ok: true;
      pendingActionId: string;
      /** "pending" for a new one; a retry may find it running, done or ended. */
      status: string;
      expiresAt: string | null;
      created: boolean;
    }
  | { ok: false; error: { code: string; message: string } };

/** VAY-2524's proposeChange, given the tool call's own delegated (read) context. */
export type AssistantChangeProposer = (
  context: RequestContext,
  request: InAppChangeRequest,
) => Promise<InAppChangeResult>;

const PROPOSAL = z.object({
  ok: z.literal(true),
  pendingActionId: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  created: z.boolean(),
});

/** The change actions to offer this user in the app: on the in-app surface, with every right the route checks. */
export function inAppChangeActions(
  context: RequestContext,
  actions: readonly ChangeAction[] = CHANGE_ACTIONS,
): ChangeAction[] {
  if (surfaceOf(context) !== "in_app") return [];
  const held = new Set(context.membership.permissions);
  return actions.filter(
    (action) =>
      action.surfaces.includes("in_app") &&
      [action.permission, ...(action.alsoNeeds ?? [])].every((key) => held.has(key)),
  );
}

export function changeTools(options: {
  /** The user's in-app delegated context: it decides which changes are offered. */
  context: RequestContext;
  /** A fresh delegated context for each tool call (the proposer reads its conversation). */
  contextFor: (toolCallId: string) => Promise<RequestContext>;
  propose: AssistantChangeProposer;
  /** The model route vayada pays for, as logged with each call. */
  model: string | null;
  /** For tests: the change actions to choose from. */
  actions?: readonly ChangeAction[];
}): AssistantTool[] {
  return inAppChangeActions(options.context, options.actions).map((action) => ({
    asksFirst: true,
    definition: {
      name: action.name,
      description: `${action.description} This only asks: vayada shows the person a Yes/No card, and only their Yes makes the change.`,
      inputSchema: z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" }) as Record<
        string,
        unknown
      >,
      outputSchema: z.toJSONSchema(PROPOSAL, { io: "output" }) as Record<string, unknown>,
    },
    run: async (input, call) => {
      const result = await options.propose(await options.contextFor(call.toolCallId), {
        action: action.key,
        arguments: input,
        client: "in_app_assistant",
        requestScope: call.turnId,
        externalCallId: call.toolCallId,
        model: options.model,
      });
      if (!result.ok) return { ok: false, error: result.error };
      // Unchanged, so the panel finds its pendingActionId; a new change waits for the Yes.
      return { ok: true, data: result, waitsForAnswer: result.status === "pending" };
    },
  }));
}
