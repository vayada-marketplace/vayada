import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadAffiliatePayoutStatement,
  getAffiliatePayout,
  getAffiliatePayouts,
  startAffiliateStripeSetup,
} from "./affiliatePayouts";
import { targetApiClient } from "./targetClient";

vi.mock("./targetClient", () => ({
  targetApiClient: { get: vi.fn(), getBlob: vi.fn(), post: vi.fn() },
}));

describe("affiliate payout client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses server-derived scope and currency-bound detail and statement paths", async () => {
    vi.mocked(targetApiClient.get).mockResolvedValue({});
    vi.mocked(targetApiClient.getBlob).mockResolvedValue(new Blob());
    await getAffiliatePayouts({ limit: 25, offset: 50 });
    await getAffiliatePayout("payout/id", "EUR");
    await downloadAffiliatePayoutStatement("payout/id", "EUR");
    expect(targetApiClient.get).toHaveBeenNthCalledWith(
      1,
      "/api/marketplace/affiliate-payouts?limit=25&offset=50",
      { signal: undefined },
    );
    expect(targetApiClient.get).toHaveBeenNthCalledWith(
      2,
      "/api/marketplace/affiliate-payouts/payout%2Fid?currency=EUR",
      { signal: undefined },
    );
    expect(targetApiClient.getBlob).toHaveBeenCalledWith(
      "/api/marketplace/affiliate-payouts/payout%2Fid/statement?currency=EUR",
    );
  });

  it("reuses the caller's idempotency identity for Stripe setup retries", async () => {
    vi.mocked(targetApiClient.post).mockResolvedValue({ onboardingUrl: "https://stripe.test" });
    await startAffiliateStripeSetup("DE", "command-1515");
    await startAffiliateStripeSetup("DE", "command-1515");
    expect(targetApiClient.post).toHaveBeenCalledTimes(2);
    expect(targetApiClient.post).toHaveBeenNthCalledWith(
      2,
      "/api/marketplace/affiliate-payouts/stripe",
      {
        commandId: "command-1515",
        idempotencyKey: "command-1515",
        country: "DE",
      },
    );
  });
});
