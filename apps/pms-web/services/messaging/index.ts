import { pmsClient } from '../api/pmsClient'

export interface Conversation {
  id: string
  bookingId: string | null
  channel: string
  guestName: string
  guestEmail: string
  subject: string
  status: 'open' | 'closed' | 'archived'
  unreadCount: number
  lastMessageAt: string | null
  lastMessagePreview: string | null
  bookingReference: string | null
  roomName: string | null
  createdAt: string
}

export interface ConversationListResponse {
  conversations: Conversation[]
  total: number
  limit: number
  offset: number
}

export interface Message {
  id: string
  conversationId: string
  senderType: 'guest' | 'host' | 'system'
  senderName: string
  body: string
  channel: string
  isRead: boolean
  createdAt: string
}

export interface MessageListResponse {
  messages: Message[]
  total: number
  limit: number
  offset: number
}

export interface UnreadCountResponse {
  unreadCount: number
}

export const messagingService = {
  listConversations: (params?: {
    status?: string
    channel?: string
    search?: string
    limit?: number
    offset?: number
  }) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.channel) query.set('channel', params.channel)
    if (params?.search) query.set('search', params.search)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return pmsClient.get<ConversationListResponse>(`/admin/conversations${qs ? `?${qs}` : ''}`)
  },

  getConversation: (id: string) =>
    pmsClient.get<Conversation>(`/admin/conversations/${id}`),

  getMessages: (id: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams()
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return pmsClient.get<MessageListResponse>(`/admin/conversations/${id}/messages${qs ? `?${qs}` : ''}`)
  },

  sendMessage: (id: string, body: string) =>
    pmsClient.post<Message>(`/admin/conversations/${id}/messages`, { body }),

  updateStatus: (id: string, status: string) =>
    pmsClient.patch<Conversation>(`/admin/conversations/${id}/status`, { status }),

  markRead: (id: string) =>
    pmsClient.post(`/admin/conversations/${id}/mark-read`),

  getUnreadCount: () =>
    pmsClient.get<UnreadCountResponse>('/admin/conversations/unread-count'),
}
