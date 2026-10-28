import { apiClient, omitHotelContext, type ApiClient } from "./client";

/** The signed-in member's own role and resolved permissions in the selected hotel account. */
export type StaffSelfAccess = {
  membershipId: string;
  roleKey: string;
  permissions: string[];
};

export function getStaffSelfAccess(
  client: Pick<ApiClient, "get"> = apiClient,
): Promise<StaffSelfAccess> {
  return client.get<StaffSelfAccess>("/api/identity/staff/self-access", omitHotelContext);
}

/** Billing, payout accounts and the bank account guests pay into are the owner's (VAY-2401). */
export function canManageOwnerFinance(access: StaffSelfAccess): boolean {
  return access.permissions.includes("finance.billing.manage");
}
