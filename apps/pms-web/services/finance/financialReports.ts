import type { FinanceDashboardResponse, FinanceRevenueResponse } from "@vayada/domain-finance";

import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";

type RoomTypeListResponse = { items: Array<{ roomTypeId: string; name: string }> };

export function getFinanceDashboard(
  propertyId: string,
  input: { asOf?: string; signal?: AbortSignal } = {},
): Promise<FinanceDashboardResponse> {
  const query = input.asOf ? `?${new URLSearchParams({ asOf: input.asOf })}` : "";
  return pmsOperationsClient.get<FinanceDashboardResponse>(
    `/api/finance/properties/${encodeURIComponent(propertyId)}/financials/dashboard${query}`,
    { ...pmsOperationsRequestOptions, signal: input.signal },
  );
}

export function getFinanceRevenue(
  propertyId: string,
  input: { from: string; to: string; signal?: AbortSignal },
): Promise<FinanceRevenueResponse> {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  return pmsOperationsClient.get<FinanceRevenueResponse>(
    `/api/finance/properties/${encodeURIComponent(propertyId)}/financials/revenue?${query}`,
    { ...pmsOperationsRequestOptions, signal: input.signal },
  );
}

export function getRoomTypeNames(
  propertyId: string,
  signal?: AbortSignal,
): Promise<RoomTypeListResponse> {
  return pmsOperationsClient.get<RoomTypeListResponse>(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
    { ...pmsOperationsRequestOptions, signal },
  );
}
