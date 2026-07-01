import {
  isSafeSharedHotelSetupReturnTo,
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupStatus,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

export type SharedHotelSetupGuardDecision =
  | {
      action: "enter_product";
      propertyId: string;
      redirectPath: null;
    }
  | {
      action: "redirect_to_setup";
      propertyId: string | null;
      redirectPath: string;
    };

export function resolveSharedHotelSetupGuardDecision(
  status: SharedHotelSetupStatus,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnTo: string;
  },
): SharedHotelSetupGuardDecision {
  if (
    status.nextAction.action === "enter_product" &&
    status.nextAction.product === input.entryProduct
  ) {
    return {
      action: "enter_product",
      propertyId: status.nextAction.propertyId,
      redirectPath: null,
    };
  }

  return {
    action: "redirect_to_setup",
    propertyId: "propertyId" in status.nextAction ? status.nextAction.propertyId : null,
    redirectPath: buildSharedHotelSetupRedirectPath(input),
  };
}

export async function resolveSharedHotelSetupGuard(
  api: Pick<SharedHotelSetupApi, "getStatus">,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnTo: string;
    propertyId?: string | null;
  },
): Promise<SharedHotelSetupGuardDecision> {
  const status = await api.getStatus({
    entryProduct: input.entryProduct,
    returnTo: input.returnTo,
    propertyId: input.propertyId,
  });
  return resolveSharedHotelSetupGuardDecision(status, input);
}

export function buildSharedHotelSetupRedirectPath(input: {
  entryProduct: SharedHotelSetupEntryProduct;
  returnTo: string;
}): string {
  const query = new URLSearchParams({ entryProduct: input.entryProduct });
  if (isSafeSharedHotelSetupReturnTo(input.returnTo)) {
    query.set("returnTo", input.returnTo);
  }
  return `/setup?${query.toString()}`;
}
