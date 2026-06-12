import { apiClient } from "./client";

export const MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION =
  "marketplace-collaboration-reads.v1" as const;

export type MarketplaceCollaborationReadsContractVersion =
  typeof MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION;

export type MarketplaceCollaborationSide = "creator" | "hotel";

export type MarketplaceCollaborationStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "active"
  | "completed"
  | "cancelled"
  | "rejected"
  | "declined";

export type MarketplaceCollaborationType = "free_stay" | "paid" | "discount" | "affiliate";

export type MarketplaceCollaborationAuthorizationMode =
  | "creator_workspace_resource_link"
  | "hotel_group_resource_link";

export type MarketplaceCollaborationParticipant = {
  side: MarketplaceCollaborationSide;
  organizationId: string;
  profileId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type MarketplaceCollaborationDeliverable = {
  deliverableId: string;
  platform: string;
  type: string;
  quantity: number;
  status: "pending" | "completed";
  completedAt: string | null;
};

export type MarketplaceCollaborationRead = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  collaborationId: string;
  listingId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationSide;
  initiatorSide: MarketplaceCollaborationSide;
  isInitiator: boolean;
  status: MarketplaceCollaborationStatus;
  collaborationType: MarketplaceCollaborationType | null;
  listingName: string;
  listingLocation: string | null;
  creator: MarketplaceCollaborationParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: {
    freeStayMinNights: number | null;
    freeStayMaxNights: number | null;
    paidAmount: string | null;
    currency: string | null;
    discountPercentage: number | null;
    creatorFee: string | null;
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
    preferredMonths: string[];
  };
  deliverables: MarketplaceCollaborationDeliverable[];
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceCollaborationListInput = {
  side: MarketplaceCollaborationSide;
  status?: MarketplaceCollaborationStatus;
  initiatedBy?: MarketplaceCollaborationSide;
  listingId?: string;
};

export type MarketplaceCollaborationListResponse = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationRead[];
};

export type MarketplaceConversationSummary = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  collaborationId: string;
  side: MarketplaceCollaborationSide;
  partnerName: string;
  partnerAvatarUrl: string | null;
  listingName: string | null;
  collaborationStatus: MarketplaceCollaborationStatus;
  lastMessageContent: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
};

export type MarketplaceCollaborationMessage = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  messageId: string;
  collaborationId: string;
  senderUserId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  content: string;
  contentType: "text" | "image" | "system";
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type MarketplaceCollaborationMessagesResponse = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationMessage[];
};

export const marketplaceCollaborationEndpoints = {
  myCollaborations: (input: MarketplaceCollaborationListInput) =>
    `/api/marketplace/collaborations/me${toCollaborationQuery(input)}`,
  collaboration: (collaborationId: string, side: MarketplaceCollaborationSide) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}?side=${side}`,
  conversations: (side?: MarketplaceCollaborationSide) =>
    `/api/marketplace/collaborations/conversations${side ? `?side=${side}` : ""}`,
  messages: (
    collaborationId: string,
    input: { side?: MarketplaceCollaborationSide; before?: string },
  ) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/messages${toMessageQuery(input)}`,
} as const;

export async function getMyMarketplaceCollaborations(
  input: MarketplaceCollaborationListInput,
): Promise<MarketplaceCollaborationListResponse> {
  return apiClient.get<MarketplaceCollaborationListResponse>(
    marketplaceCollaborationEndpoints.myCollaborations(input),
  );
}

export async function getMarketplaceCollaboration(
  collaborationId: string,
  side: MarketplaceCollaborationSide,
): Promise<MarketplaceCollaborationRead> {
  return apiClient.get<MarketplaceCollaborationRead>(
    marketplaceCollaborationEndpoints.collaboration(collaborationId, side),
  );
}

export async function getMarketplaceConversations(
  side?: MarketplaceCollaborationSide,
): Promise<MarketplaceConversationSummary[]> {
  return apiClient.get<MarketplaceConversationSummary[]>(
    marketplaceCollaborationEndpoints.conversations(side),
  );
}

export async function getMarketplaceMessages(
  collaborationId: string,
  input: { side?: MarketplaceCollaborationSide; before?: string } = {},
): Promise<MarketplaceCollaborationMessagesResponse> {
  return apiClient.get<MarketplaceCollaborationMessagesResponse>(
    marketplaceCollaborationEndpoints.messages(collaborationId, input),
  );
}

function toCollaborationQuery(input: MarketplaceCollaborationListInput): string {
  const params = new URLSearchParams({ side: input.side });
  if (input.status) params.set("status", input.status);
  if (input.initiatedBy) params.set("initiatedBy", input.initiatedBy);
  if (input.listingId) params.set("listingId", input.listingId);
  return `?${params.toString()}`;
}

function toMessageQuery(input: { side?: MarketplaceCollaborationSide; before?: string }): string {
  const params = new URLSearchParams();
  if (input.side) params.set("side", input.side);
  if (input.before) params.set("before", input.before);
  const query = params.toString();
  return query ? `?${query}` : "";
}
