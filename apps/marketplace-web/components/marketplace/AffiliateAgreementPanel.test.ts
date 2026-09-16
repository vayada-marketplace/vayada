import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/collaborations", async (original) => ({
  ...(await original<object>()),
  getMarketplaceCollaborationAffiliateAssent: mocks.read,
}));

import { ApiErrorResponse } from "@vayada/marketplace-shared/api/client";
import { AffiliateAgreementPanel, disclosureEntries } from "./AffiliateAgreementPanel";

const agreement = {
  participationId: "participation-1",
  attemptId: "attempt-1",
  programId: "program-1",
  propertyId: "property-1",
  offerId: "offer-1",
  creatorProfileId: "creator-1",
  origin: "application" as const,
  revision: 2,
  assentState: "matched" as const,
  terms: {
    id: "terms-1",
    disclosure: '{ "commission": "12.50%", "windowDays": 14 }',
    disclosureHash: "hash-1",
  },
  hotelApprovedAt: "2026-09-10T08:00:00.000Z",
  creatorAcceptedAt: "2026-09-11T08:00:00.000Z",
};

describe("AffiliateAgreementPanel", () => {
  let view: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => view?.unmount());
  });

  async function render(
    affiliateExpected = true,
    currentUserType: "creator" | "hotel" = "creator",
  ) {
    await act(async () => {
      view = create(
        createElement(AffiliateAgreementPanel, {
          collaborationId: "Existing:QA",
          currentUserType,
          affiliateExpected,
        }),
      );
    });
    return () => JSON.stringify(view?.toJSON());
  }

  it("shows the retained terms and separates matched assent from activation", async () => {
    mocks.read.mockResolvedValue(agreement);
    const output = await render();

    expect(output()).toContain("Agreement accepted");
    expect(output()).toContain("Commission");
    expect(output()).toContain("12.50%");
    expect(output()).toContain("Window Days");
    expect(output()).toContain("earning eligibility are checked separately");
    expect(mocks.read).toHaveBeenCalledWith("Existing:QA", {
      signal: expect.any(AbortSignal),
    });
  });

  it("identifies the missing decision for each participant", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      revision: 1,
      assentState: "pending",
      creatorAcceptedAt: null,
    });
    const creatorOutput = await render(true, "creator");
    expect(creatorOutput()).toContain("Your acceptance is pending");
    await act(async () => view?.unmount());

    const hotelOutput = await render(true, "hotel");
    expect(hotelOutput()).toContain("Waiting for creator acceptance");
  });

  it("hides an unavailable agreement for an ordinary non-affiliate collaboration", async () => {
    mocks.read.mockRejectedValue(new ApiErrorResponse(404, { code: "scope_unavailable" }));
    const output = await render(false);
    expect(output()).toBe("null");
  });

  it("shows a sanitized unavailable state when affiliate terms were advertised", async () => {
    mocks.read.mockRejectedValue(new ApiErrorResponse(404, { code: "scope_unavailable" }));
    const output = await render(true);
    expect(output()).toContain("Affiliate agreement unavailable");
    expect(output()).not.toContain("scope_unavailable");
  });

  it("retries other read failures", async () => {
    mocks.read.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(agreement);
    const output = await render();
    expect(output()).toContain("Could not load affiliate agreement");

    await act(async () => {
      view?.root.findByProps({ children: "Try again" }).props.onClick();
    });
    expect(output()).toContain("Agreement accepted");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("ignores an earlier collaboration response after the panel changes", async () => {
    let finishEarlier!: (value: typeof agreement) => void;
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishEarlier = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...agreement,
        terms: { ...agreement.terms, disclosure: '{"commission":"20%"}' },
      });
    await render();

    await act(async () => {
      view?.update(
        createElement(AffiliateAgreementPanel, {
          collaborationId: "Later:QA",
          currentUserType: "creator",
          affiliateExpected: true,
        }),
      );
    });
    await act(async () => finishEarlier(agreement));

    const output = JSON.stringify(view?.toJSON());
    expect(output).toContain("20%");
    expect(output).not.toContain("12.50%");
  });
});

describe("disclosureEntries", () => {
  it("keeps every top-level retained field and complete structured values", () => {
    expect(disclosureEntries('{"commission":"12%","conditions":["direct","mobile"]}')).toEqual([
      ["Commission", "12%"],
      ["Conditions", '["direct","mobile"]'],
    ]);
  });

  it("falls back to the exact retained string when it is not an object", () => {
    expect(disclosureEntries("Original retained terms")).toBeNull();
  });
});
