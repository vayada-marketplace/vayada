"use client";

import {
  createReplacementPricingClient as createSharedClient,
  type PricingHttp,
} from "@vayada/product-onboarding/replacementPricingClient";
import { ApiErrorResponse } from "./client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export * from "@vayada/product-onboarding/replacementPricingClient";

/** The shared pricing-v2 client over the PMS operations API. */
export function createReplacementPricingClient(
  propertyId: string,
  http: PricingHttp = pmsOperationsClient,
) {
  return createSharedClient(propertyId, {
    http,
    requestOptions: pmsOperationsRequestOptions,
    isNotFound: (error) =>
      error instanceof ApiErrorResponse && error.status === 404 && error.data.code === "not_found",
    conflict: (detail) => new ApiErrorResponse(409, { code: "stale", detail }),
  });
}
