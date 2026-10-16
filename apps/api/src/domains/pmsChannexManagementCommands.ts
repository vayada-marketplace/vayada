import type { RequestContext } from "@vayada/backend-auth";
import type {
  ChannexManagementOperation,
  ChannexManagementOperationType,
} from "@vayada/domain-pms-channex";

export type PmsChannexManagementCommandInput = {
  commandId: string;
  idempotencyKey: string;
  operationType: ChannexManagementOperationType;
  /** Internal pricing-save reconciliation scope; never accepted from the public command body. */
  mealRatePlanId?: string;
  /** Set only on jobs the database queues for restriction-only ARI; never by a command. */
  restrictionsOnly?: boolean;
  recoveryAlertId?: string;
  markups?: Array<{ channel: string; markupPercent: number }>;
  inventoryRules?: import("@vayada/domain-pms-channex").ChannexInventoryRulesInput;
  /** A hotel-selected published offer. Provider identities are deliberately absent. */
  publishedOffer?: {
    roomTypeId: string;
    offerId: string;
    publicationRevision: number;
    primaryOccupancy: number;
  };
};

export type PmsChannexManagementCommandResult =
  | { ok: true; operation: ChannexManagementOperation; replayed: boolean }
  | {
      ok: false;
      code:
        | "connection_required"
        | "channex_binding_exists"
        | "channex_historical_binding_required"
        | "idempotency_conflict"
        | "invalid_inventory_rules";
      message: string;
    };

export type PmsChannexManagementCommandPort = {
  enqueue(
    context: RequestContext,
    propertyId: string,
    input: PmsChannexManagementCommandInput,
  ): Promise<PmsChannexManagementCommandResult>;
  recoverStagingAlert?: PmsChannexManagementCommandPort["recoverAlert"];
  recoverAlert?(
    context: RequestContext,
    propertyId: string,
    alertId: string,
    round: number,
  ): Promise<{ ok: boolean; code?: string }>;
  close?(): Promise<void>;
};
