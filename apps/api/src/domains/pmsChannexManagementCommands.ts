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
  restrictionsOnly?: boolean;
  markups?: Array<{ channel: string; markupPercent: number }>;
};

export type PmsChannexManagementCommandResult =
  | { ok: true; operation: ChannexManagementOperation; replayed: boolean }
  | {
      ok: false;
      code: "connection_required" | "idempotency_conflict";
      message: string;
    };

export type PmsChannexManagementCommandPort = {
  enqueue(
    context: RequestContext,
    propertyId: string,
    input: PmsChannexManagementCommandInput,
  ): Promise<PmsChannexManagementCommandResult>;
  close?(): Promise<void>;
};
