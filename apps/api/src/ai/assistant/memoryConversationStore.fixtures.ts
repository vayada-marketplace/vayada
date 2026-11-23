// An in-memory stand-in for the PostgreSQL conversation store (VAY-2518), for tests of the
// assistant's loop: one conversation, its messages checked with the store's own rules. The real
// store, with its tool-call rules and locks, is tested on PostgreSQL.
import {
  checkMessage,
  type ChatMessage,
  type ConversationStore,
  type StartTurnResult,
  type TurnEnd,
} from "./conversationStore.js";

export function memoryConversationStore(options: { start?: StartTurnResult } = {}) {
  const messages: ChatMessage[] = [];
  const ends: TurnEnd[] = [];
  const contracts: string[] = [];
  let running = false;
  const store: ConversationStore = {
    async startTurn(input) {
      contracts.push(input.contract.sha256);
      if (options.start) return options.start;
      checkMessage(input.message, ["user"]);
      messages.push(input.message);
      running = true;
      return {
        status: "started",
        conversationId: "11111111-1111-4111-8111-111111111111",
        turnId: "22222222-2222-4222-8222-222222222222",
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
    async read() {
      throw new Error("not used by the loop");
    },
    async list() {
      throw new Error("not used by the loop");
    },
    async exists() {
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
