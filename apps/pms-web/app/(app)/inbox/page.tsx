"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { messagingService, Message, MessageThread, ThreadStatus } from "@/services/messaging";

const CHANNEL_BADGE: Record<string, { bg: string; label: string }> = {
  "booking.com": { bg: "bg-[#003580] text-white", label: "Booking.com" },
  airbnb: { bg: "bg-rose-500 text-white", label: "Airbnb" },
  expedia: { bg: "bg-amber-400 text-amber-950", label: "Expedia" },
  other: { bg: "bg-gray-400 text-white", label: "Other" },
};

const LIST_POLL_MS = 30_000;
const DETAIL_POLL_MS = 15_000;

// Channex's Messaging & Reviews app forwards a fixed set of media types to the
// OTAs. The list and per-channel size caps are mirrored on the backend in
// app/routers/admin_messaging.py — keep them in sync.
const ALLOWED_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
const ATTACHMENT_ACCEPT_ATTR = ALLOWED_ATTACHMENT_TYPES.join(",");

function maxAttachmentBytesForChannel(channel: string | null | undefined): number {
  switch ((channel || "").toLowerCase()) {
    case "booking.com":
      return 8 * 1024 * 1024;
    case "airbnb":
      return 25 * 1024 * 1024;
    case "expedia":
      return 10 * 1024 * 1024;
    default:
      return 25 * 1024 * 1024;
  }
}

function attachmentValidationError(file: File, channel: string | null | undefined): string | null {
  const ct = (file.type || "").toLowerCase();
  if (!ALLOWED_ATTACHMENT_TYPES.includes(ct as (typeof ALLOWED_ATTACHMENT_TYPES)[number])) {
    const channelLabel = channel || "this channel";
    return `${channelLabel} doesn't accept "${file.name}" (${ct || "unknown type"}). Try JPG, PNG, HEIC, WEBP, GIF or PDF.`;
  }
  const limit = maxAttachmentBytesForChannel(channel);
  if (file.size > limit) {
    const limitMb = Math.floor(limit / (1024 * 1024));
    const channelLabel = channel || "this channel";
    return `"${file.name}" is too large for ${channelLabel} (max ${limitMb} MB).`;
  }
  return null;
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

export default function InboxPage() {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<MessageThread[]>([]);
  const [statusFilter, setStatusFilter] = useState<ThreadStatus>("open");
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const fetchThreads = useCallback(async () => {
    if (!isVisible()) return;
    try {
      const res = await messagingService.listThreads({ status: statusFilter, limit: 100 });
      setThreads(res.threads);
    } catch (e) {
      console.error("Failed to load threads", e);
    } finally {
      setLoadingList(false);
    }
  }, [statusFilter]);

  const fetchThreadDetail = useCallback(async (id: string, opts: { markRead?: boolean } = {}) => {
    if (!isVisible()) return;
    try {
      const res = await messagingService.getThread(id);
      setThread(res.thread);
      setMessages(res.messages);
      if (opts.markRead && res.thread.unreadCount > 0) {
        await messagingService.markRead(id).catch(console.error);
        // Optimistically reflect in the list
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unreadCount: 0 } : t)));
      }
    } catch (e) {
      console.error("Failed to load thread", e);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    setLoadingList(true);
    fetchThreads();
    const i = setInterval(fetchThreads, LIST_POLL_MS);
    return () => clearInterval(i);
  }, [fetchThreads]);

  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      setMessages([]);
      return;
    }
    setComposerError(null);
    setLoadingDetail(true);
    fetchThreadDetail(selectedId, { markRead: true });
    const i = setInterval(() => fetchThreadDetail(selectedId), DETAIL_POLL_MS);
    return () => clearInterval(i);
  }, [selectedId, fetchThreadDetail]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSend = async () => {
    if (!selectedId) return;
    if (!composerBody.trim() && pendingFiles.length === 0) return;
    setSending(true);
    setComposerError(null);
    try {
      const attachmentIds: string[] = [];
      for (const f of pendingFiles) {
        const { attachmentId } = await messagingService.uploadAttachment(selectedId, f);
        attachmentIds.push(attachmentId);
      }
      await messagingService.sendMessage(selectedId, composerBody.trim(), attachmentIds);
      setComposerBody("");
      setPendingFiles([]);
      await fetchThreadDetail(selectedId);
      await fetchThreads();
    } catch (e) {
      // Keep the user's draft + attachments so they can retry without
      // re-typing or re-attaching.
      console.error("Send failed", e);
      setComposerError((e as Error).message || "Failed to send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const handleClose = async () => {
    if (!selectedId) return;
    if (!confirm("Close this conversation?")) return;
    try {
      await messagingService.closeThread(selectedId);
      setSelectedId(null);
      await fetchThreads();
    } catch (e) {
      console.error("Close failed", e);
    }
  };

  const handleNoReplyNeeded = async () => {
    if (!selectedId) return;
    try {
      await messagingService.markNoReplyNeeded(selectedId);
      setSelectedId(null);
      await fetchThreads();
    } catch (e) {
      console.error("No-reply-needed failed", e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div
        className={`border-b border-gray-200 bg-white px-5 py-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between ${
          selectedId ? "hidden md:flex" : "flex"
        }`}
      >
        <h1 className="text-xl font-semibold text-gray-900">{t("layout.sidebar.inbox")}</h1>
        <div className="flex flex-wrap gap-1 text-sm">
          {(["open", "closed", "no_reply_needed"] as ThreadStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setSelectedId(null);
              }}
              className={`px-3 py-1 rounded-md transition-colors ${
                statusFilter === s ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {s === "no_reply_needed" ? "No reply needed" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Thread list */}
        <aside
          className={`w-full md:w-80 border-r border-gray-200 bg-white overflow-y-auto shrink-0 ${
            selectedId ? "hidden md:block" : "block"
          }`}
        >
          {loadingList ? (
            <div className="p-6 text-sm text-gray-500">Loading…</div>
          ) : threads.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">No conversations.</div>
          ) : (
            <ul>
              {threads.map((thr) => {
                const badge = CHANNEL_BADGE[thr.channel || "other"] || CHANNEL_BADGE.other;
                const isSelected = thr.id === selectedId;
                return (
                  <li key={thr.id}>
                    <button
                      onClick={() => setSelectedId(thr.id)}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                        isSelected ? "bg-emerald-50" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${badge.bg}`}
                        >
                          {badge.label}
                        </span>
                        <span className="flex-1 text-sm font-semibold text-gray-900 truncate">
                          {thr.guestName || thr.guestEmail || "Guest"}
                        </span>
                        {thr.unreadCount > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold bg-emerald-600 text-white rounded-full px-1.5">
                            {thr.unreadCount}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-2">
                        {thr.lastMessageDirection === "outbound" && (
                          <span className="text-gray-400">You: </span>
                        )}
                        {thr.lastMessagePreview || "(no messages yet)"}
                      </p>
                      <p className="text-[11px] text-gray-400 mt-1">
                        {relativeTime(thr.lastMessageAt)}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Thread detail */}
        <section
          className={`flex-1 flex-col bg-gray-50 min-w-0 ${
            selectedId ? "flex" : "hidden md:flex"
          }`}
        >
          {!selectedId ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              Select a conversation
            </div>
          ) : loadingDetail && !thread ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              Loading…
            </div>
          ) : thread ? (
            <>
              <header className="border-b border-gray-200 bg-white px-5 py-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedId(null)}
                    className="md:hidden -ml-1 p-1 text-gray-500 hover:text-gray-900 shrink-0"
                    aria-label="Back to inbox"
                  >
                    <ArrowLeftIcon className="w-5 h-5" />
                  </button>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-gray-900 truncate">
                      {thread.guestName || thread.guestEmail || "Guest"}
                    </h2>
                    <p className="text-xs text-gray-500 truncate">
                      {(CHANNEL_BADGE[thread.channel || "other"] || CHANNEL_BADGE.other).label}
                      {thread.bookingId && " · Booking linked"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {thread.channel === "booking.com" && thread.status === "open" && (
                    <button
                      onClick={handleNoReplyNeeded}
                      className="text-xs px-2 py-1 text-gray-600 hover:text-gray-900 rounded border border-gray-200"
                    >
                      No reply needed
                    </button>
                  )}
                  {thread.status === "open" && (
                    <button
                      onClick={handleClose}
                      className="text-xs px-2 py-1 text-gray-600 hover:text-gray-900 rounded border border-gray-200"
                    >
                      Close
                    </button>
                  )}
                </div>
              </header>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {messages.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center mt-6">No messages yet.</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                          m.direction === "outbound"
                            ? "bg-emerald-600 text-white"
                            : "bg-white border border-gray-200 text-gray-900"
                        }`}
                      >
                        {m.body && (
                          <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                        )}
                        {m.attachments.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {m.attachments.map((a) => (
                              <a
                                key={a.id}
                                href={a.url || "#"}
                                target="_blank"
                                rel="noreferrer"
                                className={`block text-xs underline ${m.direction === "outbound" ? "text-white/90" : "text-emerald-700"}`}
                              >
                                📎 {a.filename || "Attachment"}
                              </a>
                            ))}
                          </div>
                        )}
                        <p
                          className={`text-[10px] mt-1 ${
                            m.direction === "outbound" ? "text-white/70" : "text-gray-400"
                          }`}
                        >
                          {formatTimestamp(m.sentAt)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {thread.status === "open" && (
                <div className="border-t border-gray-200 bg-white px-5 py-3">
                  {pendingFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {pendingFiles.map((f, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 text-xs bg-gray-100 px-2 py-1 rounded"
                        >
                          📎 {f.name}
                          <button
                            onClick={() =>
                              setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                            }
                            className="text-gray-400 hover:text-gray-600 ml-1"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {composerError && (
                    <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start justify-between gap-2">
                      <span className="whitespace-pre-wrap">{composerError}</span>
                      <button
                        onClick={() => setComposerError(null)}
                        className="text-red-500 hover:text-red-700 shrink-0"
                        aria-label="Dismiss error"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <label className="cursor-pointer text-gray-400 hover:text-gray-600 pb-2">
                      📎
                      <input
                        type="file"
                        accept={ATTACHMENT_ACCEPT_ATTR}
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files || []);
                          const accepted: File[] = [];
                          const errors: string[] = [];
                          for (const f of files) {
                            const err = attachmentValidationError(f, thread?.channel);
                            if (err) errors.push(err);
                            else accepted.push(f);
                          }
                          if (accepted.length > 0) {
                            setPendingFiles((prev) => [...prev, ...accepted]);
                          }
                          if (errors.length > 0) {
                            setComposerError(errors.join("\n"));
                          }
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <textarea
                      value={composerBody}
                      onChange={(e) => setComposerBody(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      placeholder="Reply… (⌘+Enter to send)"
                      rows={2}
                      className="flex-1 resize-none border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || (!composerBody.trim() && pendingFiles.length === 0)}
                      className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-md disabled:opacity-40 hover:bg-emerald-700"
                    >
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              Conversation not found.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
