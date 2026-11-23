import { randomUUID } from "node:crypto";

import type { RequestContext } from "@vayada/backend-auth";

import type { AiProvider } from "../provider/aiProvider.js";
import {
  ASSISTANT_TASK,
  runAssistantTurn,
  type AssistantEvent,
  type AssistantTool,
  type RefusedEvent,
  type TurnEndEvent,
} from "./assistantTurn.js";
import type {
  AssistantApp,
  ConversationOwner,
  ConversationStore,
  ConversationSummary,
  ConversationView,
} from "./conversationStore.js";
import { ASSISTANT_INSTRUCTIONS, turnContext } from "./instructions.js";
import { requestContract } from "./requestContract.js";

/**
 * The in-app assistant inside one API task (VAY-2518): who may use it where, the turns running
 * here, the user's Stop and the drain at shutdown.
 *
 * Drain: Fastify gives each preClose hook 10 s (its plugin timeout), within the 30 s a deploy
 * gives the task. Running turns get DRAIN_GRACE_MS to finish; then their model call and tool are
 * cut, and they get CUT_WAIT_MS to store that and end as interrupted, with every call answered, so
 * a reload says what ran. The drain never takes longer than both together.
 */
export const DRAIN_GRACE_MS = 8_000;
export const CUT_WAIT_MS = 1_500;

/**
 * The person's tools for one property, delegated for one conversation (an in-app delegation
 * always names its conversation); undefined when they may not use the property.
 */
export type AssistantToolsFor = (input: {
  session: RequestContext;
  propertyId: string;
  conversationId: string;
}) => Promise<AssistantTool[] | undefined>;

export type TurnRequest = {
  session: RequestContext;
  propertyId: string;
  app: AssistantApp;
  conversationId?: string;
  question: string;
  requestId: string;
};
export type RunTurn = (
  emit: (event: AssistantEvent) => void,
) => Promise<TurnEndEvent | RefusedEvent>;
type Scope = { session: RequestContext; propertyId: string; app: AssistantApp };

export type AssistantRuntime = {
  /** Checks access first: undefined when the person may not use the property. */
  prepareTurn(request: TurnRequest): Promise<RunTurn | undefined>;
  read(scope: Scope, conversationId: string): Promise<ConversationView | undefined | "forbidden">;
  list(
    scope: Scope,
    page: { limit: number; before?: { lastActivityAt: string; id: string } },
  ): Promise<ConversationSummary[] | "forbidden">;
  /**
   * True when a running turn was stopped. With `turnId` (from the turn's event) only that turn:
   * a late second click never stops the next question.
   */
  stop(scope: Scope, conversationId: string, turnId?: string): Promise<boolean | "forbidden">;
  drain(graceMs?: number): Promise<void>;
};

type Running = {
  owner: ConversationOwner;
  conversationId?: string;
  turnId?: string;
  stop: AbortController;
  cut: AbortController;
  done?: Promise<unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A delegation needs a well-formed conversation id; a bad one is simply not found later. */
const uuidOr = (id: string) => (UUID.test(id) ? id : randomUUID());

const sameOwner = (a: ConversationOwner, b: ConversationOwner) =>
  a.organizationId === b.organizationId &&
  a.userId === b.userId &&
  a.propertyId === b.propertyId &&
  a.app === b.app;

export function createAssistantRuntime(config: {
  store: ConversationStore;
  provider: Pick<AiProvider, "routeFor" | "step">;
  toolsFor: AssistantToolsFor;
  /** The property's IANA time zone, for "today"; UTC when unknown. */
  timeZoneOf?: (propertyId: string) => Promise<string | null | undefined>;
  instructions?: string;
  log?: { warn(fields: object, message: string): void };
  now?: () => Date;
  drainGraceMs?: number;
}): AssistantRuntime {
  const instructions = config.instructions ?? ASSISTANT_INSTRUCTIONS;
  const now = config.now ?? (() => new Date());
  const running = new Set<Running>();
  let draining = false;

  // Read, list and stop only check access: their tools never run (a list has no conversation).
  async function access(scope: Scope, conversationId: string = randomUUID()) {
    const tools = await config.toolsFor({
      session: scope.session,
      propertyId: scope.propertyId,
      conversationId,
    });
    if (!tools) return undefined;
    const owner: ConversationOwner = {
      organizationId: scope.session.selectedOrganization.organizationId,
      propertyId: scope.propertyId,
      userId: scope.session.actor.internalUserId,
      app: scope.app,
    };
    const route = config.provider.routeFor(ASSISTANT_TASK);
    // With no model to ask (AI off), there is no contract to compare a chat with: chats read as
    // they are, not as "can't continue"; a question is refused as unavailable, and the panel says
    // AI is off.
    const contractSha256 = route
      ? requestContract({
          route,
          systemPrompt: instructions,
          tools: tools.map((tool) => tool.definition),
        }).sha256
      : null;
    return { owner, tools, contractSha256 };
  }

  async function timeZone(propertyId: string): Promise<string | undefined> {
    try {
      return (await config.timeZoneOf?.(propertyId)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async prepareTurn(request) {
      // A new chat's id is chosen now, so its tool calls are delegated for it from the start.
      const conversationId = request.conversationId ?? randomUUID();
      const granted = await access(request, conversationId);
      if (!granted) return undefined;
      const context = turnContext(now(), request.propertyId, await timeZone(request.propertyId));
      return async (emit) => {
        if (draining) {
          const refused: RefusedEvent = { type: "refused", reason: "restarting" };
          emit(refused);
          return refused;
        }
        const entry: Running = {
          owner: granted.owner,
          conversationId,
          stop: new AbortController(),
          cut: new AbortController(),
        };
        running.add(entry);
        const turn = runAssistantTurn({
          store: config.store,
          provider: config.provider,
          owner: granted.owner,
          ...(request.conversationId ? { conversationId } : { newConversationId: conversationId }),
          question: request.question,
          context,
          instructions,
          tools: granted.tools,
          requestId: request.requestId,
          emit: (event) => {
            if (event.type === "turn") entry.turnId = event.turnId;
            emit(event);
          },
          signal: AbortSignal.any([entry.stop.signal, entry.cut.signal]),
          shuttingDown: () => draining,
          log: config.log,
        });
        entry.done = turn.catch(() => undefined);
        try {
          return await turn;
        } finally {
          running.delete(entry);
        }
      };
    },

    async read(scope, conversationId) {
      const granted = await access(scope, uuidOr(conversationId));
      if (!granted) return "forbidden";
      return config.store.read(granted.owner, conversationId, granted.contractSha256);
    },

    async list(scope, page) {
      const granted = await access(scope);
      if (!granted) return "forbidden";
      return config.store.list(granted.owner, granted.contractSha256, page);
    },

    async stop(scope, conversationId, turnId) {
      const granted = await access(scope, uuidOr(conversationId));
      if (!granted) return "forbidden";
      for (const entry of running) {
        if (entry.conversationId !== conversationId || !sameOwner(entry.owner, granted.owner))
          continue;
        if (turnId !== undefined && entry.turnId !== turnId) return false;
        entry.stop.abort();
        return true;
      }
      // Running in another API task (two run during a deploy): it sees this at its next beat.
      return config.store.stopTurn(granted.owner, conversationId, turnId);
    },

    async drain(graceMs = config.drainGraceMs ?? DRAIN_GRACE_MS) {
      draining = true;
      const settled = () => Promise.all([...running].map((entry) => entry.done));
      const within = async (ms: number) => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          settled(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, ms);
          }),
        ]);
        clearTimeout(timer);
      };
      await within(graceMs);
      for (const entry of running) entry.cut.abort();
      // A cut turn stores what happened and ends; a tool that ignores the cut is not waited for.
      await within(CUT_WAIT_MS);
      if (running.size)
        config.log?.warn({ turns: running.size }, "Assistant turns still running at shutdown");
    },
  };
}
