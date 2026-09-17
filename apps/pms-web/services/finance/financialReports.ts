import type { FinanceDashboardResponse } from "@vayada/domain-finance";

import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";

export function getFinanceDashboard(
  propertyId: string,
  input: { asOf?: string; signal?: AbortSignal } = {},
): Promise<FinanceDashboardResponse> {
  const query = input.asOf ? `?${new URLSearchParams({ asOf: input.asOf })}` : "";
  return pmsOperationsClient.get<FinanceDashboardResponse>(
    `/finance/properties/${encodeURIComponent(propertyId)}/financials/dashboard${query}`,
    { ...pmsOperationsRequestOptions, signal: input.signal },
  );
}
