import { getPmsMessagingUnreadCount } from "../api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";

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
  listThreads: (_params?: { status?: ThreadStatus; limit?: number; before?: string }) =>
    unsupportedPmsNextStackFeature<ThreadListResponse>("Messaging threads"),

  getThread: (_id: string) =>
    unsupportedPmsNextStackFeature<ThreadDetailResponse>("Messaging thread details"),

  sendMessage: (_id: string, _body: string, _attachmentIds: string[] = []) =>
    unsupportedPmsNextStackFeature<Message>("Messaging replies"),

  uploadAttachment: (_threadId: string, _file: File) =>
    unsupportedPmsNextStackFeature<{ attachmentId: string }>("Messaging attachments"),

  markRead: (_id: string) => unsupportedPmsNextStackFeature<MessageThread>("Messaging read state"),

  closeThread: (_id: string) => unsupportedPmsNextStackFeature<MessageThread>("Messaging close"),

  markNoReplyNeeded: (_id: string) =>
    unsupportedPmsNextStackFeature<MessageThread>("Messaging no-reply-needed state"),

  unreadCount: () => getPmsMessagingUnreadCount(),
};
