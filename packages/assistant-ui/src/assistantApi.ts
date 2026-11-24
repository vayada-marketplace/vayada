/**
 * The in-app assistant's API (VAY-2518, apps/api routes/assistant.ts), as the panel uses it.
 * Each app passes its own HTTP client, so the calls carry the app's own sign-in. A question streams
 * back as server-sent events over fetch (EventSource can't send the sign-in header).
 */

export type AssistantApp = "pms" | "booking_admin";
export type AssistantScope = { propertyId: string; app: AssistantApp };

export type TurnStatus =
  | "running"
  | "done"
  | "waiting_for_answer"
  | "stopped"
  | "failed"
  | "interrupted";
export type ReadOnlyReason = "contract_changed" | "too_long";

export type TurnEndEvent = {
  type: "end";
  status: Exclude<TurnStatus, "running">;
  reason: string | null;
};
export type RefusedEvent = {
  type: "refused";
  reason: "unavailable" | "restarting" | "not_found" | "busy" | "read_only";
  readOnlyReason?: ReadOnlyReason;
};
export type AssistantEvent =
  | { type: "turn"; conversationId: string; turnId: string }
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string; name: string; status: "running" | "ok" | "failed" }
  | TurnEndEvent
  | RefusedEvent;

/** One stored message: the AI SDK's ModelMessage, as the API returns it. */
export type StoredMessage = { role: "user" | "assistant" | "tool"; content: unknown };

export type ConversationView = {
  id: string;
  readOnlyReason: ReadOnlyReason | null;
  createdAt: string;
  lastActivityAt: string;
  turns: {
    id: string;
    seq: number;
    status: TurnStatus;
    endReason: string | null;
    startedAt: string;
    endedAt: string | null;
  }[];
  messages: { seq: number; turnId: string; message: StoredMessage; createdAt: string }[];
};

export type ConversationSummary = {
  id: string;
  readOnlyReason: ReadOnlyReason | null;
  preview: string;
  createdAt: string;
  lastActivityAt: string;
};

/** The app's API client: its JSON calls throw an error with `status` for an error answer. */
export type AssistantHttp = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, value?: unknown): Promise<T>;
  /** A POST whose response is handed back as it is, for streaming; same sign-in as `post`. */
  stream(path: string, value: unknown, signal?: AbortSignal): Promise<Response>;
};

/** The assistant's routes are not mounted: it is switched off (AI_ASSISTANT_ENABLED). */
export class AssistantUnavailableError extends Error {
  constructor() {
    super("The assistant is not available");
    this.name = "AssistantUnavailableError";
  }
}

/** The API refused the question before streaming (e.g. 403 for a property the person can't use). */
export class AssistantRequestError extends Error {
  constructor(readonly status: number) {
    super(`The assistant refused the request (${status})`);
    this.name = "AssistantRequestError";
  }
}

const statusOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;

async function unlessUnmounted<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (statusOf(error) === 404) throw new AssistantUnavailableError();
    throw error;
  }
}

/**
 * An AI change waiting for the person's Yes or No, and what became of it (VAY-2524, apps/api
 * ai/changes/pendingActions.ts). vayada writes the card from the stored change, never the model.
 */
export type PendingActionState =
  | "needs_answer"
  | "running"
  | "done"
  | "declined"
  | "expired"
  | "changed"
  | "not_allowed"
  | "stopped"
  | "failed"
  | "unsure";

export type ChangeCard = {
  question: string;
  doneTitle: string;
  yesLabel: string;
  details: readonly { label: string; value: string }[];
  effects: readonly string[];
};

export type PendingActionView = {
  id: string;
  state: PendingActionState;
  /** The hotel the change is for. */
  propertyId: string;
  /** While it waits: the answer is due by then. */
  answerBy: string | null;
  answeredAt: string | null;
  finishedAt: string | null;
  /** Null when vayada can't write it now (a record it names is gone or hidden). */
  card: ChangeCard | null;
  /** Sent back with the Yes: it binds the Yes to this card. Only while it waits. */
  cardSha256: string | null;
};

/**
 * The person may not see this change at all: another of their accounts' (`other_account`), or
 * another person's (`not_your_change`). Final: reading it again changes nothing. Any other refusal
 * stays a failed read, tried again.
 */
export class PendingActionRefusedError extends Error {
  constructor(readonly code: "other_account" | "not_your_change") {
    super(`The change can't be shown here (${code})`);
    this.name = "PendingActionRefusedError";
  }
}

/**
 * The change as it is now, from a refused answer: 409 (answered elsewhere, expired, changed since)
 * or 403 (not allowed). A 503 may carry one too, but then nothing is known about the answer.
 */
const refusedWith = (error: unknown): PendingActionView | undefined => {
  const status = statusOf(error);
  if (status !== 409 && status !== 403) return undefined;
  const data = (error as { data?: { pendingAction?: unknown } } | null)?.data;
  const view = data?.pendingAction as PendingActionView | undefined;
  return view && typeof view.id === "string" && typeof view.state === "string" ? view : undefined;
};

const scopeQuery = (scope: AssistantScope) =>
  `propertyId=${encodeURIComponent(scope.propertyId)}&app=${encodeURIComponent(scope.app)}`;

export type AssistantApi = ReturnType<typeof createAssistantApi>;

export function createAssistantApi(http: AssistantHttp) {
  return {
    /** The person's own chats for the property. Throws AssistantUnavailableError while it is off. */
    list(scope: AssistantScope, cursor?: string, limit = 20) {
      const page = `${scopeQuery(scope)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      return unlessUnmounted(
        http.get<{ items: ConversationSummary[]; nextCursor: string | null }>(
          `/api/ai/assistant/conversations?${page}`,
        ),
      );
    },

    /** One chat; undefined when it is gone (deleted after 30 days) or not the person's. */
    async read(
      scope: AssistantScope,
      conversationId: string,
    ): Promise<ConversationView | undefined> {
      try {
        return await http.get<ConversationView>(
          `/api/ai/assistant/conversations/${encodeURIComponent(conversationId)}?${scopeQuery(scope)}`,
        );
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    },

    /** The Yes/No card of an AI change; undefined when there is none (or changes are off). */
    async pendingAction(id: string): Promise<PendingActionView | undefined> {
      try {
        return await http.get<PendingActionView>(
          `/api/ai/pending-actions/${encodeURIComponent(id)}`,
        );
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
        if (statusOf(error) === 403 && (code === "other_account" || code === "not_your_change")) {
          throw new PendingActionRefusedError(code);
        }
        throw error;
      }
    },

    /**
     * The person's Yes (bound to the card they saw) or No; resolves with the change as it is
     * after it. A refusal that names the change as it is now (answered in another tab, expired,
     * changed since, not allowed) resolves with that; anything else throws, and nobody knows yet
     * whether the answer arrived.
     */
    async answer(
      view: Pick<PendingActionView, "id" | "cardSha256">,
      given: "yes" | "no",
    ): Promise<PendingActionView> {
      try {
        const body =
          given === "yes" ? { answer: "yes", cardSha256: view.cardSha256 } : { answer: "no" };
        return await http.post<PendingActionView>(
          `/api/ai/pending-actions/${encodeURIComponent(view.id)}/answer`,
          body,
        );
      } catch (error) {
        const current = refusedWith(error);
        if (current) return current;
        throw error;
      }
    },

    stop(scope: AssistantScope, conversationId: string, turnId?: string) {
      return http.post<{ stopped: boolean }>(
        `/api/ai/assistant/conversations/${encodeURIComponent(conversationId)}/stop`,
        { ...scope, ...(turnId ? { turnId } : {}) },
      );
    },

    /**
     * Asks a question and hands each event to `onEvent` as it arrives. Resolves with the turn's
     * last event, or undefined when the stream broke before it (the turn goes on: reload it).
     */
    async ask(
      scope: AssistantScope,
      input: { question: string; conversationId?: string },
      onEvent: (event: AssistantEvent) => void,
      signal?: AbortSignal,
    ): Promise<TurnEndEvent | RefusedEvent | undefined> {
      const response = await http.stream(
        "/api/ai/assistant/turns",
        {
          ...scope,
          question: input.question,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        },
        signal,
      );
      if (response.status === 404) throw new AssistantUnavailableError();
      if (!response.ok || !response.body) throw new AssistantRequestError(response.status);
      let last: TurnEndEvent | RefusedEvent | undefined;
      try {
        await readEvents(response.body, (event) => {
          if (event.type === "end" || event.type === "refused") last = event;
          onEvent(event);
        });
      } catch {
        // The connection broke: what happened is stored; the caller reloads.
        return undefined;
      }
      return last;
    },
  };
}

const EVENT_TYPES = new Set(["turn", "text", "tool", "end", "refused"]);

/**
 * Hands each event of a server-sent-events body to `onEvent` until the body ends: `event:` and
 * `data:` lines; comments are skipped. (A callback, not an async generator: the apps compile for
 * ES5.)
 */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AssistantEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const event = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) onEvent(event);
        end = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): AssistantEvent | undefined {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return undefined; // a keep-alive comment
  try {
    const event = JSON.parse(data) as { type?: unknown };
    return typeof event.type === "string" && EVENT_TYPES.has(event.type)
      ? (event as AssistantEvent)
      : undefined;
  } catch {
    return undefined;
  }
}
