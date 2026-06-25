import { ApiClient, omitHotelContext } from "./client";

export function isPmsOperationsReadModelEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PMS_OPERATIONS_READS_ENABLED !== "false";
}

const PMS_OPERATIONS_API_URL =
  process.env.NEXT_PUBLIC_PMS_OPERATIONS_API_URL ||
  process.env.NEXT_PUBLIC_VAYADA_API_URL ||
  "https://api.localhost";

export const pmsOperationsClient = new ApiClient(PMS_OPERATIONS_API_URL);
export const pmsOperationsRequestOptions = omitHotelContext;

export function assertPmsOperationsReadModelEnabled(): void {
  if (!isPmsOperationsReadModelEnabled()) {
    throw new Error("PMS operations TypeScript routes are disabled for this build.");
  }
}
