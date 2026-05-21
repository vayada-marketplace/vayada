import { pmsClient } from "../api/pmsClient";
import { buildQueryString } from "@/lib/utils/queryString";

export type ThreadStatus = "open" | "closed" | "no_reply_needed";
export type MessageDirection = "inbound" | "outbound";
export type MessageChannel = "booking.com" | "airbnb" | "expedia" | "other" | null;

export interface MessageAttachment {
  id: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  url: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  direction: MessageDirection;
  senderName: string | null;
  body: string;
  sentAt: string;
  readAt: string | null;
  attachments: MessageAttachment[];
}

export interface MessageThread {
  id: string;
  source: string;
  channel: MessageChannel;
  bookingId: string | null;
  guestName: string | null;
  guestEmail: string | null;
  status: ThreadStatus;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: MessageDirection | null;
  unreadCount: number;
}

export interface ThreadListResponse {
  threads: MessageThread[];
  nextCursor: string | null;
}

export interface ThreadDetailResponse {
  thread: MessageThread;
  messages: Message[];
}

export interface UnreadCountResponse {
  unreadCount: number;
}

export const messagingService = {
  listThreads: (params?: { status?: ThreadStatus; limit?: number; before?: string }) => {
    const qs = buildQueryString(params);
    return pmsClient.get<ThreadListResponse>(`/admin/messaging/threads${qs}`);
  },

  getThread: (id: string) => pmsClient.get<ThreadDetailResponse>(`/admin/messaging/threads/${id}`),

  sendMessage: (id: string, body: string, attachmentIds: string[] = []) =>
    pmsClient.post<Message>(`/admin/messaging/threads/${id}/messages`, {
      body,
      attachmentIds,
    }),

  uploadAttachment: async (threadId: string, file: File): Promise<{ attachmentId: string }> => {
    const form = new FormData();
    form.append("file", file);
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    const hotelId = typeof window !== "undefined" ? localStorage.getItem("selectedHotelId") : null;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (hotelId) headers["X-Hotel-Id"] = hotelId;
    const baseUrl = process.env.NEXT_PUBLIC_PMS_API_URL || "http://localhost:8002";
    const res = await fetch(`${baseUrl}/admin/messaging/threads/${threadId}/attachments`, {
      method: "POST",
      body: form,
      headers,
    });
    if (!res.ok) {
      // Backend returns FastAPI's `{ "detail": "..." }` on validation
      // failures (415 / 413). Surface that text so the user sees the real
      // reason ("Booking.com doesn't accept .zip files…") instead of a
      // status code.
      let detail = "";
      try {
        const parsed = await res.json();
        detail = typeof parsed?.detail === "string" ? parsed.detail : "";
      } catch {
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
      }
      throw new Error(detail || `Upload failed (${res.status})`);
    }
    return res.json();
  },

  markRead: (id: string) =>
    pmsClient.post<MessageThread>(`/admin/messaging/threads/${id}/read`, {}),

  closeThread: (id: string) =>
    pmsClient.post<MessageThread>(`/admin/messaging/threads/${id}/close`, {}),

  markNoReplyNeeded: (id: string) =>
    pmsClient.post<MessageThread>(`/admin/messaging/threads/${id}/no-reply-needed`, {}),

  unreadCount: () => pmsClient.get<UnreadCountResponse>("/admin/messaging/unread-count"),
};
