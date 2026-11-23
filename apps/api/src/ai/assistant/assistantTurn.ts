import type { ToolDefinition } from "../actions/registry.js";
import type { AiCallContext, AiProvider, AiStepResult } from "../provider/aiProvider.js";
import {
  MAX_CONVERSATION_BYTES,
  type ChatMessage,
  type ConversationOwner,
  type ConversationStore,
  type ReadOnlyReason,
  type TurnEnd,
} from "./conversationStore.js";
import { canonicalJson, requestContract } from "./requestContract.js";

/**
 * One turn of the in-app assistant (VAY-2518, plan 3.9): the user's question, then model steps
 * until it answers. A step's tool calls are run here, one by one, through the tools the caller
 * passes (the registry's actions, as the user): neither the AI SDK nor any framework runs a tool.
 * Every step and every batch of tool results is stored before the next step starts, so a turn
 * cut off anywhere leaves a history that says what ran.
 *
 * The turn stops at a limit: model calls, identical tool calls, time, tokens and history size.
 * It starts no new step or tool once the API is shutting down, the user pressed Stop or the time
 * is up, and it ends when a tool asks first (an Ask-first change waits for the user's Yes; only
 * the executor runs it, and the step's other calls don't run).
 */

export const ASSISTANT_TASK = "assistant_chat";

export type TurnLimits = {
  /** Model calls per turn. */
  steps: number;
  /** How often one tool may run with the same input in one turn. */
  repeats: number;
  /** The whole turn, model calls and tools. */
  turnMs: number;
  /** Tokens in and out over all of the turn's model calls. */
  tokens: number;
};

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  steps: 12,
  repeats: 2,
  turnMs: 180_000,
  tokens: 600_000,
};

/** The loop beats this often; the store treats 60 s without a beat as a cut-off turn. */
export const HEARTBEAT_MS = 15_000;
/** A bigger tool answer is replaced by an error asking for less (a message holds 256 KiB). */
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

export type ToolOutcome =
  | {
      ok: true;
      data: unknown;
      /** An Ask-first change is waiting for the user's Yes: the turn ends here. */
      waitsForAnswer?: boolean;
    }
  | { ok: false; error: { code: string; message: string } };

export type AssistantTool = {
  definition: ToolDefinition;
  /** A change tool (VAY-2524): it only asks; the person's Yes on vayada's card makes the change. */
  asksFirst?: true;
  run(
    input: unknown,
    call: { toolCallId: string; signal: AbortSignal; turnId: string },
  ): Promise<ToolOutcome>;
};

export type TurnEndEvent = { type: "end"; status: TurnEnd["status"]; reason: string | null };
export type RefusedEvent = {
  type: "refused";
  /**
   * unavailable: AI is switched off (no allowed route). restarting: this API task is shutting
   * down; ask again in a moment. Nothing was stored for either.
   */
  reason: "unavailable" | "restarting" | "not_found" | "busy" | "read_only";
  readOnlyReason?: ReadOnlyReason;
};
export type AssistantEvent =
  | { type: "turn"; conversationId: string; turnId: string }
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string; name: string; status: "running" | "ok" | "failed" }
  | TurnEndEvent
  | RefusedEvent;

export type AssistantTurnInput = {
  store: ConversationStore;
  provider: Pick<AiProvider, "routeFor" | "step">;
  owner: ConversationOwner;
  /** Absent: a new conversation. */
  conversationId?: string;
  /** A new conversation's id, chosen beforehand. */
  newConversationId?: string;
  question: string;
  /**
   * vayada's note for this turn (today's date, the property), sent with the question in the same
   * message and marked `providerOptions.vayada.context`, so the panel shows only the question.
   * Per turn, not in the system prompt, which must stay the same for every hotel and every day.
   */
  context?: string;
  /** vayada's system prompt, the same for every hotel (it is part of the cached prefix). */
  instructions: string;
  tools: readonly AssistantTool[];
  requestId: string;
  emit(event: AssistantEvent): void;
  /** The user's Stop. */
  signal?: AbortSignal;
  /** True once the API is draining for a deploy: no new step starts. */
  shuttingDown?: () => boolean;
  limits?: Partial<TurnLimits>;
  heartbeatMs?: number;
  now?: () => number;
  /** Error names only: never a prompt, an answer or a tool's text. */
  log?: { warn(fields: object, message: string): void };
};

type ToolCall = { toolCallId: string; toolName: string; input: unknown };

const failure = (code: string, message: string): ToolOutcome => ({
  ok: false,
  error: { code, message },
});

/** How a provider answer without a usable step ends the turn. */
const STEP_FAILURE: Record<Extract<AiStepResult, { ok: false }>["reason"], TurnEnd> = {
  refused: { status: "stopped", reason: "refused" },
  truncated: { status: "stopped", reason: "output_limit" },
  allowance_used_up: { status: "failed", reason: "allowance_used_up" },
  busy: { status: "failed", reason: "busy" },
  unavailable: { status: "failed", reason: "unavailable" },
  failed: { status: "failed", reason: "provider_error" },
};

export async function runAssistantTurn(
  input: AssistantTurnInput,
): Promise<TurnEndEvent | RefusedEvent> {
  const { store, provider, emit } = input;
  const limits = { ...DEFAULT_TURN_LIMITS, ...input.limits };
  const now = input.now ?? Date.now;
  const refuse = (event: RefusedEvent) => {
    emit(event);
    return event;
  };

  const route = provider.routeFor(ASSISTANT_TASK);
  if (!route) return refuse({ type: "refused", reason: "unavailable" });
  const definitions = input.tools.map((tool) => tool.definition);
  const byName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
  const contract = requestContract({
    route,
    systemPrompt: input.instructions,
    tools: definitions,
  });

  const started = await store.startTurn({
    owner: input.owner,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.newConversationId ? { newConversationId: input.newConversationId } : {}),
    contract,
    message: {
      role: "user",
      content: input.context
        ? [
            { type: "text", text: input.context, providerOptions: { vayada: { context: true } } },
            { type: "text", text: input.question },
          ]
        : input.question,
    },
  });
  if (started.status === "read_only")
    return refuse({ type: "refused", reason: "read_only", readOnlyReason: started.reason });
  if (started.status !== "started") return refuse({ type: "refused", reason: started.status });
  const { turnId } = started;
  emit({ type: "turn", conversationId: started.conversationId, turnId });

  const context: AiCallContext = {
    organizationId: input.owner.organizationId,
    propertyId: input.owner.propertyId,
    userId: input.owner.userId,
    surface: "assistant",
    requestId: input.requestId,
  };
  // Aborted by the user's Stop, or when someone else closed the turn (its beat was missed).
  const running = new AbortController();
  const stop = () => running.abort();
  input.signal?.addEventListener("abort", stop);
  if (input.signal?.aborted) stop();
  let closedElsewhere = false;
  const beat = setInterval(() => {
    store.heartbeat(turnId).then(
      (alive) => {
        if (!alive) {
          closedElsewhere = true;
          stop();
        }
      },
      // A missed beat is retried in the next interval; the store's next write would fail anyway.
      () => undefined,
    );
  }, input.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref?.();

  const finish = async (end: TurnEnd): Promise<TurnEndEvent> => {
    const ended = await store.endTurn(turnId, end);
    // Already closed elsewhere: the store closed it as interrupted.
    const event: TurnEndEvent = ended
      ? { type: "end", status: end.status, reason: end.reason ?? null }
      : { type: "end", status: "interrupted", reason: "closed_elsewhere" };
    emit(event);
    return event;
  };
  const deadline = now() + limits.turnMs;
  const history: ChatMessage[] = [...started.messages];
  const seenCalls = new Map<string, number>();
  let tokens = 0;

  try {
    return await loop();
  } catch (error) {
    // Our own mistake or the database: the turn ends plainly, and its open calls get results.
    input.log?.warn(
      { requestId: input.requestId, error: errorName(error) },
      "Assistant turn failed",
    );
    await store.endTurn(turnId, { status: "failed", reason: "internal_error" }).catch(() => false);
    const event: TurnEndEvent = { type: "end", status: "failed", reason: "internal_error" };
    emit(event);
    return event;
  } finally {
    clearInterval(beat);
    input.signal?.removeEventListener("abort", stop);
  }

  async function loop(): Promise<TurnEndEvent> {
    for (let step = 1; ; step += 1) {
      if (closedElsewhere) return finish({ status: "interrupted" });
      if (input.shuttingDown?.()) return finish({ status: "interrupted", reason: "shutdown" });
      if (input.signal?.aborted) return finish({ status: "stopped", reason: "user_stopped" });
      if (step > limits.steps) return finish({ status: "stopped", reason: "step_limit" });
      if (now() >= deadline) return finish({ status: "stopped", reason: "time_limit" });
      if (tokens >= limits.tokens) return finish({ status: "stopped", reason: "token_limit" });
      // Past this the model can't take the history; the store closes the chat at its next turn.
      if (Buffer.byteLength(JSON.stringify(history)) >= MAX_CONVERSATION_BYTES)
        return finish({ status: "stopped", reason: "too_long" });

      const result = await provider.step(
        ASSISTANT_TASK,
        { instructions: input.instructions, messages: history, tools: definitions },
        {
          context,
          abortSignal: AbortSignal.any([running.signal, untilDeadline()]),
          onTextDelta: (text) => emit({ type: "text", text }),
        },
      );
      if ("usage" in result) {
        const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = result.usage;
        tokens += inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
      }
      if (!result.ok) {
        if (closedElsewhere) return finish({ status: "interrupted" });
        if (input.shuttingDown?.()) return finish({ status: "interrupted", reason: "shutdown" });
        if (input.signal?.aborted) return finish({ status: "stopped", reason: "user_stopped" });
        if (now() >= deadline) return finish({ status: "stopped", reason: "time_limit" });
        return finish(STEP_FAILURE[result.reason]);
      }

      if ((await store.append(turnId, result.messages)).status === "turn_ended")
        return finish({ status: "interrupted" });
      history.push(...result.messages);
      const open = openCalls(result.messages);
      if (open.length === 0) {
        if (result.finishReason === "stop") return finish({ status: "done" });
        continue;
      }

      // One message per result, so a big answer can't overflow another's; they reach the
      // model together, as one turn of tool results.
      let waitsForAnswer = false;
      const toolMessages: ChatMessage[] = [];
      for (const call of open) {
        const key = `${call.toolName} ${canonicalJson(call.input ?? null)}`;
        const seen = (seenCalls.get(key) ?? 0) + 1;
        seenCalls.set(key, seen);
        const outcome = waitsForAnswer
          ? failure("not_run", "A change is waiting for the user's answer: ask again after it.")
          : await runTool(call, seen);
        if (outcome.ok && outcome.waitsForAnswer) waitsForAnswer = true;
        toolMessages.push({ role: "tool", content: [resultPart(call, outcome)] });
      }
      if ((await store.append(turnId, toolMessages)).status === "turn_ended")
        return finish({ status: "interrupted" });
      history.push(...toolMessages);
      if (waitsForAnswer) return finish({ status: "waiting_for_answer" });
    }
  }

  function untilDeadline(): AbortSignal {
    return AbortSignal.timeout(Math.max(1, deadline - now()));
  }

  async function runTool(call: ToolCall, seen: number): Promise<ToolOutcome> {
    const tool = byName.get(call.toolName);
    if (!tool) return failure("unknown_tool", "There is no tool with this name.");
    if (seen > limits.repeats)
      return failure("repeat_limit", "This exact call already ran in this turn: use its result.");
    // A closing server answers no route any more: say so instead of a failure that never ran.
    if (input.shuttingDown?.())
      return failure("not_run", "The server restarted before this ran. Ask again in a moment.");
    if (running.signal.aborted) return failure("not_run", "Stopped before this ran.");
    if (now() >= deadline) return failure("not_run", "The turn ran out of time before this ran.");
    emit({ type: "tool", toolCallId: call.toolCallId, name: call.toolName, status: "running" });
    let outcome: ToolOutcome;
    try {
      outcome = await tool.run(call.input, {
        toolCallId: call.toolCallId,
        signal: AbortSignal.any([running.signal, untilDeadline()]),
        turnId,
      });
    } catch (error) {
      // Never the error's own text: it can carry what the route answered.
      input.log?.warn(
        { requestId: input.requestId, tool: call.toolName, error: errorName(error) },
        "Assistant tool failed",
      );
      outcome = failure("failed", "The request did not succeed.");
    }
    emit({
      type: "tool",
      toolCallId: call.toolCallId,
      name: call.toolName,
      status: outcome.ok ? "ok" : "failed",
    });
    return outcome;
  }
}

function resultPart(call: ToolCall, outcome: ToolOutcome) {
  const output = outcome.ok
    ? { type: "json", value: outcome.data ?? null }
    : { type: "error-json", value: outcome.error };
  const fits = Buffer.byteLength(JSON.stringify(output)) <= MAX_TOOL_RESULT_BYTES;
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: fits
      ? output
      : {
          type: "error-json",
          value: {
            code: "too_large",
            message: "The answer was too large to use. Ask for less, e.g. a shorter date range.",
          },
        },
  };
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** The step's tool calls that no message of the same step answered (the SDK answers none). */
function openCalls(messages: readonly ChatMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const answered = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Record<string, unknown>[]) {
      if (message.role === "assistant" && part["type"] === "tool-call")
        calls.push({
          toolCallId: String(part["toolCallId"]),
          toolName: String(part["toolName"]),
          input: part["input"],
        });
      if (message.role === "tool" && part["type"] === "tool-result")
        answered.add(String(part["toolCallId"]));
    }
  }
  return calls.filter((call) => !answered.has(call.toolCallId));
}
