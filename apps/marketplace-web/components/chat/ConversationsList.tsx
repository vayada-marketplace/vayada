"use client";

import { useState } from "react";
import { getStatusClasses } from "@/lib/constants";
import { AvatarSimple } from "@/components/ui";
import type { ConversationResponse } from "@/services/api/collaborations";

interface ConversationsListProps {
  conversations: ConversationResponse[];
  selectedChatId: string | null;
  isLoading: boolean;
  onSelectChat: (id: string) => void;
}

// Format relative time for messages
function formatTime(dateStr: string | null) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));

  if (diffInHours < 24) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffInHours < 168) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ConversationsList({
  conversations,
  selectedChatId,
  isLoading,
  onSelectChat,
}: ConversationsListProps) {
  const [activeTab, setActiveTab] = useState<"Active" | "Archived">("Active");

  const archivedStatuses = ["completed", "cancelled", "declined"];
  const filteredConversations = conversations.filter((chat) => {
    const isArchived = archivedStatuses.includes(chat.collaboration_status.toLowerCase());
    return activeTab === "Archived" ? isArchived : !isArchived;
  });

  return (
    <>
      {/* Tabs */}
      <div className="sticky top-0 z-10 flex items-center border-b border-gray-200 bg-white p-2">
        <button
          onClick={() => setActiveTab("Active")}
          className={`relative flex-1 rounded-md py-2 text-center text-sm font-medium transition-colors ${
            activeTab === "Active"
              ? "bg-gray-100 text-gray-950"
              : "text-gray-500 hover:text-gray-800"
          }`}
        >
          Active
        </button>
        <button
          onClick={() => setActiveTab("Archived")}
          className={`relative flex-1 rounded-md py-2 text-center text-sm font-medium transition-colors ${
            activeTab === "Archived"
              ? "bg-gray-100 text-gray-950"
              : "text-gray-500 hover:text-gray-800"
          }`}
        >
          Archived
        </button>
      </div>

      {/* Chats List */}
      <div className="divide-y divide-gray-50">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600 mx-auto"></div>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {activeTab === "Active" ? "No active conversations." : "No archived conversations."}
          </div>
        ) : (
          filteredConversations.map((chat) => (
            <div
              key={chat.collaboration_id}
              onClick={() => onSelectChat(chat.collaboration_id)}
              className={`relative cursor-pointer p-4 transition-colors hover:bg-gray-50 ${
                selectedChatId === chat.collaboration_id
                  ? "border-r-2 border-gray-900 bg-gray-50"
                  : ""
              }`}
            >
              <div className="flex gap-3">
                <div className="relative">
                  <AvatarSimple
                    src={chat.partner_avatar}
                    name={chat.partner_name}
                    size="md"
                    variant="blue"
                  />
                  {chat.unread_count > 0 && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white">
                      {chat.unread_count}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="truncate">
                      <h4 className="text-sm font-semibold text-gray-900 truncate">
                        {chat.my_role === "creator" && chat.listing_name
                          ? chat.listing_name
                          : chat.partner_name}
                      </h4>
                      {chat.my_role === "creator" && chat.listing_name && (
                        <p className="text-[10px] text-gray-400 truncate">{chat.partner_name}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">
                      {formatTime(chat.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium capitalize ${getStatusClasses(chat.collaboration_status)}`}
                    >
                      {chat.collaboration_status}
                    </span>
                    {chat.my_role && (
                      <span className="text-[10px] text-gray-400 capitalize">{chat.my_role}</span>
                    )}
                  </div>
                  <p
                    className={`text-sm truncate ${
                      chat.unread_count > 0 ? "font-medium text-gray-900" : "text-gray-500"
                    }`}
                  >
                    {chat.last_message_content || "No messages yet"}
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
