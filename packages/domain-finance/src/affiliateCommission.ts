export type FinanceAffiliateCommissionAccessStatus = "active" | "inactive" | "missing";

export interface FinanceAffiliateCommissionRepository {
  getBookingFinanceAccess(
    propertyId: string,
    organizationId: string,
  ): Promise<FinanceAffiliateCommissionAccessStatus>;
  close?(): Promise<void>;
}
