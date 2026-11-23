import type pg from "pg";

import type { SealedRequestContract } from "./requestContract.js";

/**
 * The in-app assistant's chat history (VAY-2518, plan 3.9, research 04 §7), kept in vayada's
 * database and never at the AI provider. A conversation belongs to one user, one property and one
 * app; a turn is one question and everything the assistant did for it; messages are stored
 * exactly as the provider layer hands them over and are only ever added.
 *
 * The store keeps the history valid for replay: no empty message, every tool call gets exactly
 * one result, in the message right after it, and a turn that ends early (a deploy, a limit, an
 * error) gets an error result for each call it never answered. A turn whose API task stopped
 * beating is closed as "interrupted" the next time anyone opens or continues the conversation.
 */

export const AI_CONVERSATION_RETENTION = "30 days";
/** Then the conversation is read-only and the panel offers a new one (research 04 §7.4). */
export const MAX_TURNS_PER_CONVERSATION = 100;
/** About 150K tokens of history at ~4 bytes a token (research 04 §7.4). */
export const MAX_CONVERSATION_BYTES = 600_000;
/** The loop beats every 15 s with its keep-alives; deploys drain open requests within 30 s. */
export const STALE_TURN_AFTER = "60 seconds";
export const MAX_MESSAGE_BYTES = 262_144;
export const MAX_TOOL_CALLS_PER_MESSAGE = 64;

export type AssistantApp = "pms" | "booking_admin";
export type ChatRole = "user" | "assistant" | "tool";
/** One message as the provider layer hands it over (the AI SDK's ModelMessage), plain JSON. */
export type ChatMessage = { role: ChatRole; content: unknown; providerOptions?: unknown };
/** Whose chats: one user, for one property of one account, in one app. */
export type ConversationOwner = {
  organizationId: string;
  propertyId: string;
  userId: string;
  app: AssistantApp;
};
/**
 * too_long is stored. contract_changed is worked out on every request from the caller's current
 * request contract: during a rolling deploy old and new API tasks both answer, and a question
 * that reaches an old task must not close a chat the new tasks can continue.
 */
export type ReadOnlyReason = "contract_changed" | "too_long";
export type TurnStatus =
  | "running"
  | "done"
  | "waiting_for_answer"
  | "stopped"
  | "failed"
  | "interrupted";
/** `reason`: why a turn stopped, failed or was cut off, e.g. step_limit or shutdown. */
export type TurnEnd = { status: Exclude<TurnStatus, "running">; reason?: string };

export type StartTurnResult =
  | { status: "started"; conversationId: string; turnId: string; messages: ChatMessage[] }
  | { status: "not_found" }
  /** Another turn of this conversation is still running (a second tab, a double click). */
  | { status: "busy" }
  | { status: "read_only"; reason: ReadOnlyReason };

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
  messages: { seq: number; turnId: string; message: ChatMessage; createdAt: string }[];
};

export type ConversationSummary = {
  id: string;
  readOnlyReason: ReadOnlyReason | null;
  /** The start of the first question, for the list of chats. */
  preview: string;
  createdAt: string;
  /** With the id, the cursor for the next page (full database precision). */
  lastActivityAt: string;
};

export type ConversationStore = {
  /** Starts a turn with the user's question, in a new conversation or one of the user's own. */
  startTurn(input: {
    owner: ConversationOwner;
    /** An existing conversation of the user's. */
    conversationId?: string;
    /** For a new conversation: its id, chosen beforehand (tool calls are delegated for it). */
    newConversationId?: string;
    contract: SealedRequestContract;
    message: ChatMessage;
  }): Promise<StartTurnResult>;
  /** Adds assistant and tool messages to a running turn; "turn_ended" once it was closed. */
  append(
    turnId: string,
    messages: readonly ChatMessage[],
  ): Promise<{ status: "appended" | "turn_ended" }>;
  /** False once the turn has ended: the task must stop working on it. */
  heartbeat(turnId: string): Promise<boolean>;
  /** False if the turn had already ended. */
  endTurn(turnId: string, end: TurnEnd): Promise<boolean>;
  /**
   * The user's Stop when their turn runs in another API task: closes the conversation's running
   * turn as stopped; that task sees it at its next heartbeat. False when nothing was running.
   */
  stopTurn(owner: ConversationOwner, conversationId: string, turnId?: string): Promise<boolean>;
  /** `contractSha256`: the request contract this user's next question would use. */
  read(
    owner: ConversationOwner,
    conversationId: string,
    contractSha256: string,
  ): Promise<ConversationView | undefined>;
  list(
    owner: ConversationOwner,
    contractSha256: string,
    page: { limit: number; before?: { lastActivityAt: string; id: string } },
  ): Promise<ConversationSummary[]>;
  /**
   * Whether the conversation still exists and is this owner's: the same user, account, property
   * and app. False once it was deleted (30 days after its last activity), for anyone else's and
   * for an id that is no conversation id. A read-only conversation still exists. For VAY-2524: an
   * answer to an AI change must belong to a chat the person can still open.
   */
  exists(owner: ConversationOwner, conversationId: string): Promise<boolean>;
};

/** A message or a sequence of messages that would make the history unusable for replay. */
export class ChatHistoryError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const PREVIEW_CHARS = 120;
/** The owner filter on platform.ai_conversations, from parameter $first on (see ownerValues). */
const owned = (first: number) =>
  `organization_id = $${first}::uuid AND property_id = $${first + 1}::uuid
   AND user_id = $${first + 2}::uuid AND app = $${first + 3}`;

type ToolCall = { toolCallId: string; toolName: string };
type CheckedMessage = {
  role: ChatRole;
  json: string;
  /** assistant: the calls it makes; tool: the calls it answers. */
  toolCallIds: string[];
  calls: ToolCall[];
};

/** Checks one message and lists the tool calls it makes or answers. */
export function checkMessage(message: ChatMessage, roles: readonly ChatRole[]): CheckedMessage {
  if (!isPlainObject(message) || !roles.includes(message.role))
    throw new ChatHistoryError(`expected a message from: ${roles.join(", ")}`);
  assertJson(message, "message");
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES)
    throw new ChatHistoryError(`a message may have at most ${MAX_MESSAGE_BYTES} bytes`);
  const { role, content } = message;
  // Claude refuses empty messages and blank text anywhere but at the very end of a request.
  if (typeof content === "string") {
    if (role === "tool" || !content.trim())
      throw new ChatHistoryError(`a ${role} message needs text`);
    return { role, json, toolCallIds: [], calls: [] };
  }
  if (!Array.isArray(content) || content.length === 0)
    throw new ChatHistoryError(`a ${role} message needs content`);

  const calls: ToolCall[] = [];
  const answers: string[] = [];
  let says = false;
  for (const part of content as unknown[]) {
    const type = isPlainObject(part) ? part["type"] : undefined;
    if (typeof type !== "string") throw new ChatHistoryError("every content part needs a type");
    const { toolCallId, toolName, text } = part as Record<string, unknown>;
    if (type === "tool-call" && role === "assistant") {
      if (typeof toolCallId !== "string" || !TOOL_CALL_ID.test(toolCallId))
        throw new ChatHistoryError("a tool call needs a plain id");
      if (typeof toolName !== "string" || !TOOL_NAME.test(toolName))
        throw new ChatHistoryError("a tool call needs a plain tool name");
      calls.push({ toolCallId, toolName });
      says = true;
    } else if (type === "tool-result" && role === "tool") {
      if (typeof toolCallId !== "string" || !TOOL_CALL_ID.test(toolCallId))
        throw new ChatHistoryError("a tool result needs a plain id");
      answers.push(toolCallId);
    } else if (type.startsWith("tool-") || role === "tool") {
      // Provider-run tools, SDK tool approvals and the like are not used: our executor runs changes.
      throw new ChatHistoryError(`a ${role} message can't hold a ${type} part`);
    } else if (type === "text") {
      if (typeof text !== "string" || !text.trim())
        throw new ChatHistoryError("a text part needs text");
      says = true;
    } else if (role === "user") {
      says = true;
    }
  }
  if (role !== "tool" && !says)
    throw new ChatHistoryError(`a ${role} message needs text or a tool call`);
  const toolCallIds = role === "assistant" ? calls.map((call) => call.toolCallId) : answers;
  if (toolCallIds.length > MAX_TOOL_CALLS_PER_MESSAGE)
    throw new ChatHistoryError(
      `a message may hold at most ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls`,
    );
  if (new Set(toolCallIds).size !== toolCallIds.length)
    throw new ChatHistoryError("a tool call id appears twice in one message");
  return { role, json, toolCallIds, calls };
}

/** What a tool call the turn never answered gets as its result, so replay stays valid. */
export function unansweredResult(call: ToolCall, end: TurnEnd) {
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "error-json",
      value:
        end.status === "interrupted"
          ? {
              error: "interrupted",
              detail:
                "The answer was cut off before this step's result was recorded. It may or may " +
                "not have run: check before doing it again.",
            }
          : { error: "not_run", reason: end.reason ?? end.status },
    },
  };
}

export function createPgConversationStore(config: { pool: pg.Pool }): ConversationStore {
  const { pool } = config;

  async function transaction<T>(
    work: (client: pg.PoolClient) => Promise<T>,
    begin = "BEGIN",
  ): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        broken = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
      });
      throw error;
    } finally {
      // A connection that could not roll back is dropped, not reused.
      client.release(broken);
    }
  }

  return {
    async startTurn(input) {
      const question = checkMessage(input.message, ["user"]);
      const { owner } = input;
      return transaction<StartTurnResult>(async (client) => {
        let conversationId = input.conversationId;
        if (conversationId !== undefined) {
          if (!UUID.test(conversationId)) return { status: "not_found" };
          const { rows } = await client.query<{
            contract_sha256: string;
            read_only_reason: "too_long" | null;
            turns: number;
            bytes: number;
          }>(
            `SELECT contract_sha256, read_only_reason,
                    (SELECT count(*)::int FROM platform.ai_conversation_turns turn
                      WHERE turn.conversation_id = conversation.id) AS turns,
                    (SELECT COALESCE(sum(octet_length(message::text)), 0)::int
                       FROM platform.ai_conversation_messages stored
                      WHERE stored.conversation_id = conversation.id) AS bytes
               FROM platform.ai_conversations conversation
              WHERE id = $1::uuid AND ${owned(2)}
                FOR UPDATE`,
            [conversationId, ...ownerValues(owner)],
          );
          const conversation = rows[0];
          if (!conversation) return { status: "not_found" };
          if (conversation.read_only_reason)
            return { status: "read_only", reason: conversation.read_only_reason };
          if (conversation.contract_sha256 !== input.contract.sha256)
            return { status: "read_only", reason: "contract_changed" };
          if (
            conversation.turns >= MAX_TURNS_PER_CONVERSATION ||
            conversation.bytes >= MAX_CONVERSATION_BYTES
          ) {
            await client.query(
              "UPDATE platform.ai_conversations SET read_only_reason = 'too_long' WHERE id = $1::uuid",
              [conversationId],
            );
            return { status: "read_only", reason: "too_long" };
          }
          if (await turnStillRunning(client, conversationId)) return { status: "busy" };
        } else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO platform.ai_conversations
               (id, organization_id, property_id, user_id, app, contract, contract_sha256)
             VALUES (COALESCE($7::uuid, gen_random_uuid()), $1::uuid, $2::uuid, $3::uuid, $4,
                     $5::jsonb, $6)
             RETURNING id`,
            [
              ...ownerValues(owner),
              JSON.stringify(input.contract.contract),
              input.contract.sha256,
              input.newConversationId ?? null,
            ],
          );
          conversationId = rows[0]!.id;
        }

        const { rows: turns } = await client.query<{ id: string }>(
          `INSERT INTO platform.ai_conversation_turns (conversation_id, seq)
           SELECT $1::uuid, COALESCE(max(seq), 0) + 1
             FROM platform.ai_conversation_turns WHERE conversation_id = $1::uuid
           RETURNING id`,
          [conversationId],
        );
        const turnId = turns[0]!.id;
        await insertMessages(client, conversationId, turnId, [question]);
        const { rows: history } = await client.query<{ message: ChatMessage }>(
          `SELECT message FROM platform.ai_conversation_messages
            WHERE conversation_id = $1::uuid ORDER BY seq`,
          [conversationId],
        );
        return {
          status: "started",
          conversationId,
          turnId,
          messages: history.map((row) => row.message),
        };
      });
    },

    async append(turnId, messages) {
      const checked = messages.map((message) => checkMessage(message, ["assistant", "tool"]));
      return transaction<{ status: "appended" | "turn_ended" }>(async (client) => {
        const conversationId = await lockRunningTurn(client, turnId);
        if (!conversationId) return { status: "turn_ended" };
        const state = await readTurnState(client, conversationId, turnId);
        for (const message of checked) {
          if (message.role === "assistant") {
            if (state.open.size > 0)
              throw new ChatHistoryError("the last tool calls have no results yet");
            for (const call of message.calls) {
              if (state.calledIds.has(call.toolCallId))
                throw new ChatHistoryError(`tool call ${call.toolCallId} was already made`);
              state.calledIds.add(call.toolCallId);
              state.open.set(call.toolCallId, call);
            }
          } else {
            for (const id of message.toolCallIds) {
              if (!state.open.delete(id))
                throw new ChatHistoryError(`tool result ${id} answers no open tool call`);
            }
          }
        }
        await insertMessages(client, conversationId, turnId, checked);
        await client.query(
          "UPDATE platform.ai_conversation_turns SET heartbeat_at = now() WHERE id = $1::uuid",
          [turnId],
        );
        return { status: "appended" };
      });
    },

    async heartbeat(turnId) {
      if (!UUID.test(turnId)) return false;
      const { rowCount } = await pool.query(
        `UPDATE platform.ai_conversation_turns SET heartbeat_at = now()
          WHERE id = $1::uuid AND status = 'running'`,
        [turnId],
      );
      return rowCount === 1;
    },

    async endTurn(turnId, end) {
      checkTurnEnd(end);
      return transaction(async (client) => {
        const conversationId = await lockRunningTurn(client, turnId);
        if (!conversationId) return false;
        await closeTurn(client, conversationId, turnId, end);
        return true;
      });
    },

    async stopTurn(owner, conversationId, turnId) {
      if (!UUID.test(conversationId)) return false;
      return transaction(async (client) => {
        const { rowCount } = await client.query(
          `SELECT 1 FROM platform.ai_conversations WHERE id = $1::uuid AND ${owned(2)} FOR UPDATE`,
          [conversationId, ...ownerValues(owner)],
        );
        if (rowCount !== 1) return false;
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM platform.ai_conversation_turns
            WHERE conversation_id = $1::uuid AND status = 'running'`,
          [conversationId],
        );
        if (!rows[0] || (turnId !== undefined && rows[0].id !== turnId)) return false;
        await closeTurn(client, conversationId, rows[0].id, {
          status: "stopped",
          reason: "user_stopped",
        });
        return true;
      });
    },

    async read(owner, conversationId, contractSha256) {
      if (!UUID.test(conversationId)) return undefined;
      // A reload after a deploy shows the cut-off turn as interrupted. Only then is the
      // conversation locked, so reading never holds up a running turn.
      const { rowCount: stale } = await pool.query(
        `SELECT 1 FROM platform.ai_conversation_turns turn
           JOIN platform.ai_conversations conversation ON conversation.id = turn.conversation_id
          WHERE conversation.id = $1::uuid AND ${owned(2)}
            AND turn.status = 'running' AND turn.heartbeat_at < now() - $6::text::interval`,
        [conversationId, ...ownerValues(owner), STALE_TURN_AFTER],
      );
      if (stale)
        await transaction(async (client) => {
          const { rowCount } = await client.query(
            `SELECT 1 FROM platform.ai_conversations WHERE id = $1::uuid AND ${owned(2)} FOR UPDATE`,
            [conversationId, ...ownerValues(owner)],
          );
          if (rowCount === 1) await turnStillRunning(client, conversationId);
        });

      // One snapshot, so the turns and messages read belong together.
      return transaction<ConversationView | undefined>(async (client) => {
        const { rows } = await client.query<{
          id: string;
          contract_sha256: string;
          read_only_reason: "too_long" | null;
          created_at: string;
          last_activity_at: string;
        }>(
          `SELECT id, contract_sha256, read_only_reason,
                  to_json(created_at) #>> '{}' AS created_at,
                  to_json(last_activity_at) #>> '{}' AS last_activity_at
             FROM platform.ai_conversations WHERE id = $1::uuid AND ${owned(2)}`,
          [conversationId, ...ownerValues(owner)],
        );
        const conversation = rows[0];
        if (!conversation) return undefined;
        const { rows: turns } = await client.query<{
          id: string;
          seq: number;
          status: TurnStatus;
          end_reason: string | null;
          started_at: string;
          ended_at: string | null;
        }>(
          `SELECT id, seq, status, end_reason, to_json(started_at) #>> '{}' AS started_at,
                  to_json(ended_at) #>> '{}' AS ended_at
             FROM platform.ai_conversation_turns WHERE conversation_id = $1::uuid ORDER BY seq`,
          [conversationId],
        );
        const { rows: messages } = await client.query<{
          seq: number;
          turn_id: string;
          message: ChatMessage;
          created_at: string;
        }>(
          `SELECT seq, turn_id, message, to_json(created_at) #>> '{}' AS created_at
             FROM platform.ai_conversation_messages WHERE conversation_id = $1::uuid ORDER BY seq`,
          [conversationId],
        );
        return {
          id: conversation.id,
          readOnlyReason: readOnlyReason(conversation, contractSha256),
          createdAt: conversation.created_at,
          lastActivityAt: conversation.last_activity_at,
          turns: turns.map((turn) => ({
            id: turn.id,
            seq: turn.seq,
            status: turn.status,
            endReason: turn.end_reason,
            startedAt: turn.started_at,
            endedAt: turn.ended_at,
          })),
          messages: messages.map((row) => ({
            seq: row.seq,
            turnId: row.turn_id,
            message: row.message,
            createdAt: row.created_at,
          })),
        };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async list(owner, contractSha256, page) {
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100)
        throw new Error("A page of conversations holds 1 to 100");
      if (page.before && !UUID.test(page.before.id))
        throw new Error("A page cursor needs a conversation id");
      const { rows } = await pool.query<{
        id: string;
        contract_sha256: string;
        read_only_reason: "too_long" | null;
        first: ChatMessage | null;
        created_at: string;
        last_activity_at: string;
      }>(
        `SELECT conversation.id, conversation.contract_sha256, conversation.read_only_reason,
                to_json(conversation.created_at) #>> '{}' AS created_at,
                to_json(conversation.last_activity_at) #>> '{}' AS last_activity_at,
                (SELECT message FROM platform.ai_conversation_messages first
                  WHERE first.conversation_id = conversation.id ORDER BY seq LIMIT 1) AS first
           FROM platform.ai_conversations conversation
          WHERE ${owned(1)}
            AND ($5::timestamptz IS NULL OR (last_activity_at, id) < ($5::timestamptz, $6::uuid))
          ORDER BY last_activity_at DESC, id DESC
          LIMIT $7`,
        [
          ...ownerValues(owner),
          page.before?.lastActivityAt ?? null,
          page.before?.id ?? null,
          page.limit,
        ],
      );
      return rows.map((row) => ({
        id: row.id,
        readOnlyReason: readOnlyReason(row, contractSha256),
        preview: preview(row.first),
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
      }));
    },

    async exists(owner, conversationId) {
      if (!UUID.test(conversationId)) return false;
      const { rowCount } = await pool.query(
        `SELECT 1 FROM platform.ai_conversations WHERE id = $1::uuid AND ${owned(2)}`,
        [conversationId, ...ownerValues(owner)],
      );
      return rowCount === 1;
    },
  };
}

/** Retention: whole conversations, with their turns and messages, 30 days after the last activity. */
export async function purgeExpiredConversations(
  db: {
    query<T extends pg.QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  },
  now: Date,
  limit: number,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `WITH expired AS (
       SELECT id FROM platform.ai_conversations
        WHERE last_activity_at < LEAST($1::timestamptz, now()) - $3::text::interval
        ORDER BY last_activity_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), deleted AS (
       DELETE FROM platform.ai_conversations conversation USING expired
        WHERE conversation.id = expired.id
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM deleted`,
    [now.toISOString(), limit, AI_CONVERSATION_RETENTION],
  );
  return rows[0]?.n ?? 0;
}

function ownerValues(owner: ConversationOwner): string[] {
  return [owner.organizationId, owner.propertyId, owner.userId, owner.app];
}

function readOnlyReason(
  conversation: { contract_sha256: string; read_only_reason: "too_long" | null },
  contractSha256: string,
): ReadOnlyReason | null {
  if (conversation.read_only_reason) return conversation.read_only_reason;
  return conversation.contract_sha256 === contractSha256 ? null : "contract_changed";
}

/** Locks the turn's conversation; its id while the turn still runs, else undefined. */
async function lockRunningTurn(client: pg.PoolClient, turnId: string): Promise<string | undefined> {
  if (!UUID.test(turnId)) return undefined;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM platform.ai_conversations
      WHERE id = (SELECT conversation_id FROM platform.ai_conversation_turns WHERE id = $1::uuid)
        FOR UPDATE`,
    [turnId],
  );
  if (!rows[0]) return undefined;
  // Read after the lock: whoever closed the turn held the same lock.
  const { rows: turn } = await client.query<{ status: TurnStatus }>(
    "SELECT status FROM platform.ai_conversation_turns WHERE id = $1::uuid",
    [turnId],
  );
  return turn[0]?.status === "running" ? rows[0].id : undefined;
}

/**
 * With the conversation locked: true while a turn runs and its task still beats; a turn whose
 * task stopped beating is closed as interrupted first.
 */
async function turnStillRunning(client: pg.PoolClient, conversationId: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string; stale: boolean }>(
    `SELECT id, heartbeat_at < now() - $2::text::interval AS stale
       FROM platform.ai_conversation_turns
      WHERE conversation_id = $1::uuid AND status = 'running'`,
    [conversationId, STALE_TURN_AFTER],
  );
  const running = rows[0];
  if (!running) return false;
  if (!running.stale) return true;
  await closeTurn(client, conversationId, running.id, {
    status: "interrupted",
    reason: "no_heartbeat",
  });
  return false;
}

async function closeTurn(
  client: pg.PoolClient,
  conversationId: string,
  turnId: string,
  end: TurnEnd,
): Promise<void> {
  const { open } = await readTurnState(client, conversationId, turnId);
  if (open.size > 0) {
    // A turn that says it is done while calls wait for results is a bug in the loop.
    if (end.status === "done")
      throw new ChatHistoryError("a turn can't be done while tool calls have no results");
    const results: ChatMessage = {
      role: "tool",
      content: [...open.values()].map((call) => unansweredResult(call, end)),
    };
    await insertMessages(client, conversationId, turnId, [checkMessage(results, ["tool"])]);
  }
  await client.query(
    `UPDATE platform.ai_conversation_turns SET status = $2, end_reason = $3, ended_at = now()
      WHERE id = $1::uuid`,
    [turnId, end.status, end.reason ?? null],
  );
}

/** The conversation's tool call ids, and this turn's calls that have no result yet. */
async function readTurnState(
  client: pg.PoolClient,
  conversationId: string,
  turnId: string,
): Promise<{ calledIds: Set<string>; open: Map<string, ToolCall> }> {
  const { rows } = await client.query<{
    in_turn: boolean;
    role: ChatRole;
    tool_call_ids: string[];
    message: ChatMessage | null;
  }>(
    // Only this turn's assistant messages are needed whole, for the names of open calls.
    `SELECT turn_id = $2::uuid AS in_turn, role, tool_call_ids,
            CASE WHEN role = 'assistant' AND turn_id = $2::uuid THEN message END AS message
       FROM platform.ai_conversation_messages
      WHERE conversation_id = $1::uuid AND cardinality(tool_call_ids) > 0
      ORDER BY seq`,
    [conversationId, turnId],
  );
  const calledIds = new Set<string>();
  const open = new Map<string, ToolCall>();
  for (const row of rows) {
    if (row.role === "assistant") {
      for (const id of row.tool_call_ids) calledIds.add(id);
      if (row.in_turn) {
        open.clear();
        for (const call of storedToolCalls(row.message)) open.set(call.toolCallId, call);
      }
    } else if (row.in_turn) {
      for (const id of row.tool_call_ids) open.delete(id);
    }
  }
  return { calledIds, open };
}

/**
 * The tool calls of a stored assistant message. Not checked again: it passed when it was stored,
 * and a later, stricter rule must not stop an old turn from closing.
 */
function storedToolCalls(message: ChatMessage | null): ToolCall[] {
  const content: unknown = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) =>
    isPlainObject(part) && part["type"] === "tool-call"
      ? [{ toolCallId: String(part["toolCallId"]), toolName: String(part["toolName"]) }]
      : [],
  );
}

async function insertMessages(
  client: pg.PoolClient,
  conversationId: string,
  turnId: string,
  messages: readonly CheckedMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await client.query(
    `INSERT INTO platform.ai_conversation_messages
       (conversation_id, seq, turn_id, role, message, tool_call_ids)
     SELECT $1::uuid, base.seq + item.n, $2::uuid, item.role, item.message::json,
            ARRAY(SELECT json_array_elements_text(item.ids::json))
       FROM (SELECT COALESCE(max(seq), 0) AS seq FROM platform.ai_conversation_messages
              WHERE conversation_id = $1::uuid) base,
            unnest($3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS item(role, message, ids, n)`,
    [
      conversationId,
      turnId,
      messages.map((message) => message.role),
      messages.map((message) => message.json),
      messages.map((message) => JSON.stringify(message.toolCallIds)),
    ],
  );
  await client.query(
    "UPDATE platform.ai_conversations SET last_activity_at = now() WHERE id = $1::uuid",
    [conversationId],
  );
}

function checkTurnEnd(end: TurnEnd): void {
  const statuses: TurnStatus[] = ["done", "waiting_for_answer", "stopped", "failed", "interrupted"];
  if (!statuses.includes(end.status)) throw new Error(`A turn can't end as ${String(end.status)}`);
  if (end.reason !== undefined && !REASON.test(end.reason))
    throw new Error("A turn's end reason is a short snake_case code");
}

function preview(message: ChatMessage | null): string {
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: unknown) =>
              isPlainObject(part) && part["type"] === "text" && typeof part["text"] === "string"
                ? part["text"]
                : "",
            )
            .join(" ")
        : "";
  // By code point, so an emoji is never cut in half.
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length > PREVIEW_CHARS
    ? `${characters.slice(0, PREVIEW_CHARS - 1).join("")}…`
    : characters.join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Plain JSON only, so what is stored is exactly what is replayed. */
function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      if (item === undefined) throw new ChatHistoryError(`${path}[${index}] is missing`);
      assertJson(item, `${path}[${index}]`);
    });
    return;
  } else if (isPlainObject(value)) {
    // JSON drops a property that is undefined, as the AI SDK treats it.
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) assertJson(item, `${path}.${key}`);
    return;
  }
  throw new ChatHistoryError(`${path} is not plain JSON`);
}
