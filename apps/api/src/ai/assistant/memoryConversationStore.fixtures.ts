// An in-memory stand-in for the PostgreSQL conversation store (VAY-2518), for tests of the
// assistant's loop: one conversation, its messages checked with the store's own rules. The real
// store, with its tool-call rules and locks, is tested on PostgreSQL.
import {
  checkMessage,
  type ChatMessage,
  type ConversationOwner,
  type ConversationStore,
  type StartTurnResult,
  type TurnEnd,
} from "./conversationStore.js";

const TURN_ID = "22222222-2222-4222-8222-222222222222";

export function memoryConversationStore(options: { start?: StartTurnResult } = {}) {
  const messages: ChatMessage[] = [];
  const ends: TurnEnd[] = [];
  const contracts: string[] = [];
  let running = false;
  let owner: ConversationOwner | undefined;
  const store: ConversationStore = {
    async startTurn(input) {
      contracts.push(input.contract.sha256);
      if (options.start) return options.start;
      checkMessage(input.message, ["user"]);
      owner = input.owner;
      messages.push(input.message);
      running = true;
      return {
        status: "started",
        conversationId:
          input.conversationId ?? input.newConversationId ?? "11111111-1111-4111-8111-111111111111",
        turnId: TURN_ID,
        messages: [...messages],
      };
    },
    async append(_turnId, batch) {
      if (!running) return { status: "turn_ended" };
      for (const message of batch) checkMessage(message, ["assistant", "tool"]);
      messages.push(...batch);
      return { status: "appended" };
    },
    async heartbeat() {
      return running;
    },
    async endTurn(_turnId, end) {
      if (!running) return false;
      running = false;
      ends.push(end);
      return true;
    },
    async stopTurn(who, _conversationId, turnId) {
      const mine = owner && JSON.stringify(who) === JSON.stringify(owner);
      if (!running || !mine || (turnId !== undefined && turnId !== TURN_ID)) return false;
      running = false;
      ends.push({ status: "stopped", reason: "user_stopped" });
      return true;
    },
    async read() {
      throw new Error("not used by the loop");
    },
    async list() {
      throw new Error("not used by the loop");
    },
  };
  return {
    store,
    messages,
    ends,
    contracts,
    /** As if the store had closed the turn after a missed heartbeat. */
    closeElsewhere() {
      running = false;
    },
  };
}
