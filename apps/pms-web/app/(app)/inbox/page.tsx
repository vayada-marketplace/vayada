'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  XMarkIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import {
  messagingService,
  Conversation,
  Message,
} from '@/services/messaging'
import { useTranslation } from '@/lib/i18n'

const CHANNEL_STYLES: Record<string, { bg: string; labelKey: string }> = {
  direct: { bg: 'bg-blue-500', labelKey: 'inbox.channelDirect' },
  airbnb: { bg: 'bg-pink-500', labelKey: 'inbox.channelAirbnb' },
  'booking.com': { bg: 'bg-indigo-600', labelKey: 'inbox.channelBookingCom' },
  beds24: { bg: 'bg-purple-500', labelKey: 'inbox.channelBeds24' },
  email: { bg: 'bg-gray-500', labelKey: 'inbox.channelEmail' },
}

const STATUS_TAB_KEYS = [
  { labelKey: 'inbox.statusAll', value: '' },
  { labelKey: 'inbox.statusOpen', value: 'open' },
  { labelKey: 'inbox.statusClosed', value: 'closed' },
  { labelKey: 'inbox.statusArchived', value: 'archived' },
]

function formatTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function ChannelBadge({ channel, t }: { channel: string; t: (key: string) => string }) {
  const style = CHANNEL_STYLES[channel] || CHANNEL_STYLES.direct
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium text-white', style.bg)}>
      {t(style.labelKey)}
    </span>
  )
}

export default function InboxPage() {
  const { t } = useTranslation()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [total, setTotal] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [messageInput, setMessageInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [search, setSearch] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const selectedConversation = conversations.find(c => c.id === selectedId)

  const fetchConversations = useCallback(async () => {
    try {
      const data = await messagingService.listConversations({
        status: statusFilter || undefined,
        channel: channelFilter || undefined,
        search: search || undefined,
        limit: 50,
      })
      setConversations(data.conversations)
      setTotal(data.total)
    } catch (e) {
      console.error('Failed to load conversations:', e)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, channelFilter, search])

  const fetchMessages = useCallback(async (conversationId: string) => {
    setMessagesLoading(true)
    try {
      const data = await messagingService.getMessages(conversationId, { limit: 200 })
      setMessages(data.messages)
      await messagingService.markRead(conversationId)
      // Update unread count locally
      setConversations(prev =>
        prev.map(c => c.id === conversationId ? { ...c, unreadCount: 0 } : c)
      )
    } catch (e) {
      console.error('Failed to load messages:', e)
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  // Load conversations
  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  // Poll conversations every 30s
  useEffect(() => {
    const interval = setInterval(fetchConversations, 30000)
    return () => clearInterval(interval)
  }, [fetchConversations])

  // Load messages when conversation selected
  useEffect(() => {
    if (selectedId) {
      fetchMessages(selectedId)
    } else {
      setMessages([])
    }
  }, [selectedId, fetchMessages])

  // Poll messages every 15s when conversation is open
  useEffect(() => {
    if (!selectedId) return
    const interval = setInterval(() => fetchMessages(selectedId), 15000)
    return () => clearInterval(interval)
  }, [selectedId, fetchMessages])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!selectedId || !messageInput.trim() || sending) return
    setSending(true)
    try {
      const newMsg = await messagingService.sendMessage(selectedId, messageInput.trim())
      setMessages(prev => [...prev, newMsg])
      setMessageInput('')
      // Update conversation preview
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedId
            ? { ...c, lastMessagePreview: newMsg.body, lastMessageAt: newMsg.createdAt }
            : c
        )
      )
    } catch (e) {
      console.error('Failed to send message:', e)
    } finally {
      setSending(false)
    }
  }

  const handleStatusChange = async (conversationId: string, newStatus: string) => {
    try {
      await messagingService.updateStatus(conversationId, newStatus)
      setConversations(prev =>
        prev.map(c => c.id === conversationId ? { ...c, status: newStatus as Conversation['status'] } : c)
      )
    } catch (e) {
      console.error('Failed to update status:', e)
    }
  }

  return (
    <div className="flex h-[calc(100vh-48px)] bg-white">
      {/* Left panel — Conversation list */}
      <div className="w-80 border-r border-gray-200 flex flex-col shrink-0">
        {/* Header */}
        <div className="p-3 border-b border-gray-200">
          <h1 className="text-sm font-semibold text-gray-900 mb-2">{t('inbox.title')}</h1>
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder={t('inbox.searchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {/* Status tabs */}
          <div className="flex gap-1 mt-2">
            {STATUS_TAB_KEYS.map(tab => (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className={cn(
                  'px-2 py-1 text-[11px] rounded-md font-medium transition-colors',
                  statusFilter === tab.value
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-xs text-gray-400">{t('common.loading')}</div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center">
              <ChatBubbleLeftRightIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">{t('inbox.noConversations')}</p>
            </div>
          ) : (
            conversations.map(conv => (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors',
                  selectedId === conv.id && 'bg-blue-50 hover:bg-blue-50'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {conv.unreadCount > 0 && (
                        <span className="w-2 h-2 bg-blue-600 rounded-full shrink-0" />
                      )}
                      <span className={cn(
                        'text-xs truncate',
                        conv.unreadCount > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'
                      )}>
                        {conv.guestName || conv.guestEmail || t('inbox.unknownGuest')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <ChannelBadge t={t} channel={conv.channel} />
                      {conv.bookingReference && (
                        <span className="text-[10px] text-gray-400 font-mono">{conv.bookingReference}</span>
                      )}
                    </div>
                    {conv.lastMessagePreview && (
                      <p className="text-[11px] text-gray-500 truncate mt-0.5">
                        {conv.lastMessagePreview}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">
                    {formatTime(conv.lastMessageAt)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Count */}
        {total > 0 && (
          <div className="px-3 py-1.5 border-t border-gray-200 text-[10px] text-gray-400">
            {t('inbox.conversationsCount', { count: String(total) })}
          </div>
        )}
      </div>

      {/* Right panel — Message thread */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedConversation ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <ChatBubbleLeftRightIcon className="w-12 h-12 text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-400">{t('inbox.selectConversation')}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900 truncate">
                    {selectedConversation.guestName || selectedConversation.guestEmail}
                  </h2>
                  <ChannelBadge t={t} channel={selectedConversation.channel} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {selectedConversation.bookingReference && (
                    <a
                      href={`/bookings/${selectedConversation.bookingId}`}
                      className="text-[11px] text-blue-600 hover:underline font-mono"
                    >
                      {selectedConversation.bookingReference}
                    </a>
                  )}
                  {selectedConversation.roomName && (
                    <span className="text-[11px] text-gray-400">
                      {selectedConversation.roomName}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {selectedConversation.status === 'open' ? (
                  <button
                    onClick={() => handleStatusChange(selectedConversation.id, 'closed')}
                    className="px-2 py-1 text-[11px] font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
                  >
                    {t('common.close')}
                  </button>
                ) : (
                  <button
                    onClick={() => handleStatusChange(selectedConversation.id, 'open')}
                    className="px-2 py-1 text-[11px] font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100 transition-colors"
                  >
                    {t('common.reopen')}
                  </button>
                )}
                <button
                  onClick={() => setSelectedId(null)}
                  className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors lg:hidden"
                >
                  <XMarkIcon className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messagesLoading ? (
                <div className="text-center text-xs text-gray-400 py-8">{t('inbox.loadingMessages')}</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-xs text-gray-400 py-8">{t('inbox.noMessages')}</div>
              ) : (
                messages.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'flex',
                      msg.senderType === 'host' ? 'justify-end' : 'justify-start',
                      msg.senderType === 'system' && 'justify-center'
                    )}
                  >
                    {msg.senderType === 'system' ? (
                      <div className="px-3 py-1.5 bg-gray-100 rounded-full text-[11px] text-gray-500">
                        {msg.body}
                      </div>
                    ) : (
                      <div
                        className={cn(
                          'max-w-[75%] rounded-lg px-3 py-2',
                          msg.senderType === 'host'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-900'
                        )}
                      >
                        {msg.senderType === 'guest' && msg.senderName && (
                          <p className="text-[10px] font-medium text-gray-500 mb-0.5">
                            {msg.senderName}
                          </p>
                        )}
                        <p className="text-[13px] whitespace-pre-wrap break-words">{msg.body}</p>
                        <p className={cn(
                          'text-[10px] mt-1',
                          msg.senderType === 'host' ? 'text-blue-200' : 'text-gray-400'
                        )}>
                          {formatTime(msg.createdAt)}
                        </p>
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input */}
            <div className="px-4 py-3 border-t border-gray-200">
              <div className="flex items-end gap-2">
                <textarea
                  value={messageInput}
                  onChange={e => setMessageInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  placeholder={t('inbox.typePlaceholder')}
                  rows={1}
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 max-h-24"
                />
                <button
                  onClick={handleSend}
                  disabled={!messageInput.trim() || sending}
                  className={cn(
                    'p-2 rounded-lg transition-colors',
                    messageInput.trim() && !sending
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  )}
                >
                  <PaperAirplaneIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
