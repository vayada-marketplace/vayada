import type { StayRestrictionReplacement } from "./pmsStayRestrictions.js";
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
  restrictions?: StayRestrictionReplacement;
  restrictionsOnly?: boolean;
  recoveryAlertId?: string;
  markups?: Array<{ channel: string; markupPercent: number }>;
  inventoryRules?: import("@vayada/domain-pms-channex").ChannexInventoryRulesInput;
};

export type PmsChannexManagementCommandResult =
  | { ok: true; operation: ChannexManagementOperation; replayed: boolean }
  | {
      ok: false;
      code:
        | "connection_required"
        | "idempotency_conflict"
        | "invalid_inventory_rules"
        | "invalid_stay_restrictions"
        | "stay_restriction_scope_not_found";
      message: string;
    };

export type PmsChannexManagementCommandPort = {
  enqueue(
    context: RequestContext,
    propertyId: string,
    input: PmsChannexManagementCommandInput,
  ): Promise<PmsChannexManagementCommandResult>;
  recoverAlert?(
    context: RequestContext,
    propertyId: string,
    alertId: string,
    round: number,
  ): Promise<{ ok: boolean; code?: string }>;
  close?(): Promise<void>;
};
