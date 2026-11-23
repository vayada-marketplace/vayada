"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AssistantUnavailableError,
  type AssistantApi,
  type AssistantScope,
  type ReadOnlyReason,
  type RefusedEvent,
  type TurnEndEvent,
} from "./assistantApi";
import { runningTurn, transcriptOf, type TranscriptItem } from "./transcript";

/** How often a turn that runs on without a stream (after a reload) is read again. */
export const FOLLOW_MS = 2_000;

/** What happened to the last question, shown once under the chat. */
export type Notice =
  | "reloaded"
  | "busy"
  | "restarting"
  | "failed"
  | "not_found"
  | "load_failed";

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
  const turnId = useRef<string | undefined>(undefined);
  const follow = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Which chat the state belongs to: a late answer for another property is dropped.
  const scopeKey = useRef(storageKey(scope));

  const stopFollowing = () => {
    clearTimeout(follow.current);
    follow.current = undefined;
  };

  const load = useCallback(
    async (id: string, key = scopeKey.current): Promise<void> => {
      let view;
      try {
        view = await api.read(scope, id);
      } catch {
        if (key === scopeKey.current) setNotice("load_failed");
        return;
      }
      if (key !== scopeKey.current) return;
      if (!view) {
        setConversationId(undefined);
        remember(scope, undefined);
        setItems([]);
        setNotice("not_found");
        return;
      }
      setItems(transcriptOf(view));
      setBlocker((current) =>
        view.readOnlyReason
          ? { kind: "read_only", reason: view.readOnlyReason }
          : current?.kind === "read_only"
            ? null
            : current,
      );
      const running = runningTurn(view);
      stopFollowing();
      if (running) {
        // A turn that went on without this page (a reload mid-answer): follow it until it ends.
        turnId.current = running.id;
        setAnswering(true);
        follow.current = setTimeout(() => void load(id, key), FOLLOW_MS);
      } else {
        setAnswering(false);
      }
    },
    [api, scope],
  );

  // A new property or app: its own remembered chat.
  useEffect(() => {
    scopeKey.current = storageKey(scope);
    stopFollowing();
    const id = remembered(scope);
    setConversationId(id);
    setItems([]);
    setLive(null);
    setAnswering(false);
    setNotice(null);
    setBlocker(null);
    if (id) void load(id);
    return stopFollowing;
  }, [scope, load]);

  const open = useCallback(
    (id: string) => {
      stopFollowing();
      setConversationId(id);
      remember(scope, id);
      setNotice(null);
      setBlocker(null);
      setItems([]);
      void load(id);
    },
    [scope, load],
  );

  const newChat = useCallback(() => {
    stopFollowing();
    setConversationId(undefined);
    remember(scope, undefined);
    setItems([]);
    setLive(null);
    setNotice(null);
    setAnswering(false);
    setBlocker((current) => (current?.kind === "read_only" ? null : current));
  }, [scope]);

  function settle(last: TurnEndEvent | RefusedEvent | undefined, hadTurn: boolean) {
    if (!last) {
      if (hadTurn) setNotice("reloaded");
      else setNotice("failed");
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
      const key = scopeKey.current;
      stopFollowing();
      setNotice(null);
      setLastQuestion(text);
      setAnswering(true);
      setLive({ question: text, text: "", tools: [] });
      let id = conversationId;
      let hadTurn = false;
      try {
        const last = await api.ask(scope, { question: text, conversationId: id }, (event) => {
          if (key !== scopeKey.current) return;
          if (event.type === "turn") {
            hadTurn = true;
            id = event.conversationId;
            turnId.current = event.turnId;
            setConversationId(id);
            remember(scope, id);
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
        if (key !== scopeKey.current) return;
        settle(last, hadTurn);
      } catch (error) {
        if (key !== scopeKey.current) return;
        if (error instanceof AssistantUnavailableError) setBlocker({ kind: "off" });
        else setNotice("failed");
      } finally {
        if (key === scopeKey.current) {
          setLive(null);
          setAnswering(false);
          // The stored chat is what counts, also after a broken stream.
          if (id) await load(id, key);
        }
      }
    },
    [answering, api, conversationId, load, scope],
  );

  const stop = useCallback(async () => {
    if (!conversationId) return;
    try {
      await api.stop(scope, conversationId, turnId.current);
    } catch {
      // The turn ends on its own limits; the next read shows how it ended.
    }
  }, [api, conversationId, scope]);

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
