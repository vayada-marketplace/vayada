"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AssistantUnavailableError,
  type AssistantApi,
  type AssistantScope,
  type ConversationView,
  type ReadOnlyReason,
  type RefusedEvent,
  type TurnEndEvent,
} from "./assistantApi";
import { runningTurn, transcriptOf, type TranscriptItem } from "./transcript";

/** How often a turn that runs on without a stream (after a reload) is read again. */
export const FOLLOW_MS = 2_000;

/** What happened to the last question, shown once under the chat. */
export type Notice = "reloaded" | "busy" | "restarting" | "failed" | "not_found" | "load_failed";

/** Why no question can be asked here now. */
export type Blocker =
  | { kind: "read_only"; reason: ReadOnlyReason }
  | { kind: "off" }
  | { kind: "allowance" }
  | null;

export type LiveTool = { id: string; name: string; status: "running" | "ok" | "failed" };
/** The question being answered right now, as it streams in (replaced by the stored chat). */
export type LiveTurn = { question: string; text: string; tools: LiveTool[] };

const storageKey = (scope: AssistantScope) => `vayada.assistant.${scope.app}.${scope.propertyId}`;

function remembered(scope: AssistantScope): string | undefined {
  try {
    return window.sessionStorage.getItem(storageKey(scope)) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(scope: AssistantScope, conversationId: string | undefined) {
  try {
    if (conversationId) window.sessionStorage.setItem(storageKey(scope), conversationId);
    else window.sessionStorage.removeItem(storageKey(scope));
  } catch {
    // Private mode: the panel simply starts a new chat next time.
  }
}

export function useAssistantChat(api: AssistantApi, scope: AssistantScope) {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [answering, setAnswering] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  // Bumped by every question, chat switch, New chat, property switch and close: whatever an
  // earlier one still sends back (a late event, a read, a timer) is dropped.
  const epoch = useRef(0);
  // The turn being answered; a Stop pressed before the API named the turn is sent once it does.
  const turn = useRef<{ conversationId?: string; turnId?: string; stopAsked: boolean }>({
    stopAsked: false,
  });
  const follow = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const begin = () => {
    clearTimeout(follow.current);
    epoch.current += 1;
    return epoch.current;
  };

  /**
   * Shows the stored chat. While one of its turns still runs (a reload mid-answer, a dropped
   * stream), reads it again every FOLLOW_MS until the turn ends; a failed read is retried then.
   * Resolves true once the chat is shown.
   */
  const load = useCallback(
    async (id: string, mine: number, following = false): Promise<boolean> => {
      let view: ConversationView | undefined;
      try {
        view = await api.read(scope, id);
      } catch {
        if (mine !== epoch.current) return false;
        if (following) follow.current = setTimeout(() => void load(id, mine, true), FOLLOW_MS);
        else setNotice("load_failed");
        return false;
      }
      if (mine !== epoch.current) return false;
      if (!view) {
        setConversationId(undefined);
        remember(scope, undefined);
        setItems([]);
        setLive(null);
        setAnswering(false);
        setNotice("not_found");
        return false;
      }
      setItems(transcriptOf(view));
      setLive(null);
      const readOnlyReason = view.readOnlyReason;
      setBlocker((current) =>
        readOnlyReason
          ? { kind: "read_only", reason: readOnlyReason }
          : current?.kind === "read_only"
            ? null
            : current,
      );
      const running = runningTurn(view);
      if (running) {
        turn.current = { conversationId: id, turnId: running.id, stopAsked: false };
        setAnswering(true);
        follow.current = setTimeout(() => void load(id, mine, true), FOLLOW_MS);
      } else {
        setAnswering(false);
      }
      return true;
    },
    [api, scope],
  );

  // A new property or app: its own remembered chat. Closing the panel drops what is in flight.
  useEffect(() => {
    const mine = begin();
    const id = remembered(scope);
    setConversationId(id);
    setItems([]);
    setLive(null);
    setAnswering(false);
    setNotice(null);
    setBlocker(null);
    if (id) void load(id, mine);
    return () => {
      begin();
    };
  }, [scope, load]);

  const open = useCallback(
    (id: string) => {
      const mine = begin();
      setConversationId(id);
      remember(scope, id);
      setItems([]);
      setLive(null);
      setAnswering(false);
      setNotice(null);
      setBlocker(null);
      void load(id, mine);
    },
    [scope, load],
  );

  const newChat = useCallback(() => {
    begin();
    setConversationId(undefined);
    remember(scope, undefined);
    setItems([]);
    setLive(null);
    setAnswering(false);
    setNotice(null);
    setBlocker((current) => (current?.kind === "read_only" ? null : current));
  }, [scope]);

  function settle(last: TurnEndEvent | RefusedEvent | undefined, hadTurn: boolean) {
    if (!last) {
      setNotice(hadTurn ? "reloaded" : "failed");
      return;
    }
    if (last.type === "refused") {
      if (last.reason === "unavailable") setBlocker({ kind: "off" });
      else if (last.reason === "read_only")
        setBlocker({ kind: "read_only", reason: last.readOnlyReason ?? "contract_changed" });
      else if (last.reason === "not_found") {
        setConversationId(undefined);
        remember(scope, undefined);
        setNotice("not_found");
      } else setNotice(last.reason);
      return;
    }
    // Every other ending is stored with the turn and shown from the stored chat.
    if (last.status !== "failed") return;
    if (last.reason === "allowance_used_up") setBlocker({ kind: "allowance" });
    else if (last.reason === "unavailable") setBlocker({ kind: "off" });
  }

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || answering) return;
      const mine = begin();
      turn.current = { conversationId, stopAsked: false };
      setNotice(null);
      setLastQuestion(text);
      setAnswering(true);
      setLive({ question: text, text: "", tools: [] });
      let id = conversationId;
      let hadTurn = false;
      let last: TurnEndEvent | RefusedEvent | undefined;
      let broke = false;
      try {
        last = await api.ask(scope, { question: text, conversationId: id }, (event) => {
          if (mine !== epoch.current) return;
          if (event.type === "turn") {
            hadTurn = true;
            id = event.conversationId;
            const stopAsked = turn.current.stopAsked;
            turn.current = { conversationId: id, turnId: event.turnId, stopAsked: false };
            setConversationId(id);
            remember(scope, id);
            if (stopAsked) void api.stop(scope, id, event.turnId).catch(() => undefined);
          } else if (event.type === "text") {
            setLive((current) => current && { ...current, text: current.text + event.text });
          } else if (event.type === "tool") {
            setLive((current) => {
              if (!current) return current;
              const others = current.tools.filter((tool) => tool.id !== event.toolCallId);
              const tool = { id: event.toolCallId, name: event.name, status: event.status };
              return { ...current, tools: [...others, tool] };
            });
          }
        });
      } catch (error) {
        broke = true;
        if (mine !== epoch.current) return;
        if (error instanceof AssistantUnavailableError) setBlocker({ kind: "off" });
        else setNotice("failed");
      }
      if (mine !== epoch.current) return;
      if (!broke) settle(last, hadTurn);
      if (last?.type === "refused" && last.reason === "not_found") id = undefined;
      // The stored chat is what counts, also after a broken stream. Until it is read, the
      // streamed answer stays on screen (and stays if the read fails).
      if (id && (await load(id, mine))) return;
      if (mine !== epoch.current) return;
      if (!id) setLive(null);
      setAnswering(false);
    },
    [answering, api, conversationId, load, scope],
  );

  const stop = useCallback(async () => {
    const current = turn.current;
    if (!current.conversationId || !current.turnId) {
      turn.current = { ...current, stopAsked: true };
      return;
    }
    try {
      await api.stop(scope, current.conversationId, current.turnId);
    } catch {
      // The turn ends on its own limits; the next read shows how it ended.
    }
  }, [api, scope]);

  return {
    conversationId,
    items,
    live,
    answering,
    notice,
    blocker,
    lastQuestion,
    ask,
    stop,
    newChat,
    open,
    dismissNotice: () => setNotice(null),
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
