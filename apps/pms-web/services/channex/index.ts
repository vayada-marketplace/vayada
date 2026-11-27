import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import type { ChannexInventoryRule } from "@vayada/domain-pms-channex";

export type ChannexCapabilityMode = "observe_only" | "mutating";
export type ChannexOperationType =
  | "enable"
  | "disable"
  | "provision"
  | "sync_ari"
  | "sync_bookings"
  | "update_markups"
  | "update_inventory_rules"
  | "install_messaging";
export type ChannexOperationStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export interface ChannexOperation {
  contractVersion: "pms-channex-management.v1";
  operationId: string;
  propertyId: string;
  operationType: ChannexOperationType;
  status: ChannexOperationStatus;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  attemptsMade: number;
  maxAttempts: number;
  retryAfter: string | null;
  lastError: { code: string; message: string } | null;
}

export interface ChannexSyncDomainState {
  status: "pending" | "ok" | "degraded" | "failed" | "idle";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryAfter: string | null;
}

export interface ChannexRoomTypeMapping {
  mappingId: string;
  roomTypeId: string;
  roomTypeName: string;
  externalRoomTypeId: string;
  status: "active" | "disabled" | "stale";
}

export interface ChannexRatePlanMapping {
  mappingId: string;
  roomTypeId: string;
  ratePlanId: string;
  ratePlanName: string;
  channel: string;
  externalRoomTypeId: string;
  externalRatePlanId: string;
  sellMode: "per_room" | "per_person";
  markupPercent: number;
  status: "active" | "disabled" | "stale";
}

export interface ConnectedChannel {
  externalChannelId?: string;
  key: string;
  application: string;
  title: string | null;
  isActive: boolean;
}

export interface ChannexSnapshot {
  inventoryRules?: { rules: ChannexInventoryRule[]; operation: ChannexOperation | null };
  contractVersion: "pms-channex-management.v1";
  propertyId: string;
  connection: {
    status: "connected" | "disconnected" | "suspended" | "degraded" | "setup_incomplete";
    externalPropertyId: string | null;
    messagingAppInstalled: boolean;
  };
  mappings: {
    roomTypes: ChannexRoomTypeMapping[];
    ratePlans: ChannexRatePlanMapping[];
  };
  channels: ConnectedChannel[];
  markups: Array<{ channel: string; markupPercent: number }>;
  sync: Record<"booking" | "ari" | "message" | "mapping", ChannexSyncDomainState>;
  capabilityModes: {
    connection: ChannexCapabilityMode;
    provisioning: ChannexCapabilityMode;
    ariSync: ChannexCapabilityMode;
    bookingSync: ChannexCapabilityMode;
    markups: ChannexCapabilityMode;
    messaging: ChannexCapabilityMode;
    iframe: ChannexCapabilityMode;
  };
  activeOperation: ChannexOperation | null;
}

async function endpoint(action: string) {
  const propertyId = await resolveSelectedPmsPropertyId(action);
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/channex`;
}

/** The Channex snapshot the calendar reads its connected channels from (VAY-2606 moved the Channel manager page
 * to its own read-only view, services/channelManager). */
export const channexService = {
  async getSnapshot() {
    return pmsOperationsClient.get<ChannexSnapshot>(
      await endpoint("loading channel management"),
      pmsOperationsRequestOptions,
    );
  },

  async listChannels() {
    return { channels: (await this.getSnapshot()).channels };
  },
};
