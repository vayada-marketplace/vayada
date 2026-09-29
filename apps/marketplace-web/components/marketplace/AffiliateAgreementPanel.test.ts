import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  record: vi.fn(),
  lifecycle: vi.fn(),
  link: vi.fn(),
  diagnostic: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/collaborations", async (original) => ({
  ...(await original<object>()),
  getMarketplaceCollaborationAffiliateAssent: mocks.read,
  recordMarketplaceCollaborationAffiliateAssent: mocks.record,
  changeMarketplaceCollaborationAffiliateLifecycle: mocks.lifecycle,
  createMarketplaceCollaborationAffiliateLink: mocks.link,
  diagnoseMarketplaceCollaborationAffiliateLink: mocks.diagnostic,
}));

import { ApiErrorResponse } from "@vayada/marketplace-shared/api/client";
import { AffiliateAgreementPanel } from "./AffiliateAgreementPanel";

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
  lifecycle: null,
};

describe("AffiliateAgreementPanel", () => {
  let view: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue({ ok: true, revision: 1, state: "pending", replayed: false });
    mocks.link.mockResolvedValue({
      ok: true,
      contractVersion: "marketplace-affiliate-link.v1",
      linkId: "link-1",
      agreementId: "agreement-1",
      propertyId: "property-1",
      publicToken: "va_abcdefghijklmnopqrstuv",
      path: "/r/va_abcdefghijklmnopqrstuv",
      createdAt: "2026-09-29T08:00:00.000Z",
      replayed: false,
    });
    mocks.diagnostic.mockResolvedValue({
      ok: true,
      contractVersion: "marketplace-affiliate-link-diagnostic.v1",
      status: "ready",
      association: "verified",
      programStatus: "active",
      destinationUrl: "https://alpine.next-booking.vayada.com/",
      campaignLabel: "instagram.reel-1",
      normalMetricsExcluded: true,
      externalPurchaseVerified: false,
    });
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
          collaborationStatus: "accepted",
        }),
      );
    });
    return () => JSON.stringify(view?.toJSON());
  }

  it("shows the retained terms and separates matched assent from activation", async () => {
    mocks.read.mockResolvedValue(agreement);
    const output = await render();

    expect(output()).toContain("Terms accepted — activation pending");
    expect(output()).toContain("commission");
    expect(output()).toContain("12.50%");
    expect(output()).toContain("windowDays");
    expect(output()).toContain("checking activation and earning eligibility");
    expect(mocks.read).toHaveBeenCalledWith("Existing:QA", {
      signal: expect.any(AbortSignal),
    });
  });

  it("identifies the missing decision for each participant", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      revision: 0,
      assentState: "pending",
      hotelApprovedAt: null,
      creatorAcceptedAt: null,
    });
    const creatorOutput = await render(true, "creator");
    expect(creatorOutput()).toContain("Your acceptance is pending");
    expect(creatorOutput()).toContain("Accept affiliate terms");
    expect(creatorOutput()).toContain("does not activate links or earnings");
    await act(async () => view?.unmount());

    mocks.read.mockResolvedValue({
      ...agreement,
      revision: 1,
      assentState: "pending",
      hotelApprovedAt: null,
    });
    const hotelOutput = await render(true, "hotel");
    expect(hotelOutput()).toContain("Your approval is pending");
    expect(hotelOutput()).toContain("Approve affiliate agreement");
  });

  it("hides an unavailable agreement for an ordinary non-affiliate collaboration", async () => {
    mocks.read.mockRejectedValue(new ApiErrorResponse(404, { code: "scope_unavailable" }));
    const output = await render(false);
    expect(output()).toBe("null");
  });

  it("shows a sanitized unavailable state when affiliate terms were advertised", async () => {
    mocks.read.mockRejectedValue(new ApiErrorResponse(404, { code: "scope_unavailable" }));
    const output = await render(true);
    expect(output()).toContain("Affiliate partnership not eligible yet");
    expect(output()).not.toContain("scope_unavailable");
  });

  it("retries other read failures", async () => {
    mocks.read.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(agreement);
    const output = await render();
    expect(output()).toContain("Could not load affiliate agreement");

    await act(async () => {
      view?.root.findByProps({ children: "Try again" }).props.onClick();
    });
    expect(output()).toContain("Terms accepted — activation pending");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("hides a ready agreement immediately when the collaboration changes", async () => {
    let finishLater!: (value: typeof agreement) => void;
    mocks.read.mockResolvedValueOnce(agreement).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLater = resolve;
        }),
    );
    const output = await render();
    expect(output()).toContain("12.50%");

    await act(async () => {
      view?.update(
        createElement(AffiliateAgreementPanel, {
          collaborationId: "Later:QA",
          currentUserType: "creator",
          affiliateExpected: true,
          collaborationStatus: "accepted",
        }),
      );
    });
    expect(output()).toContain("Loading affiliate agreement");
    expect(output()).not.toContain("12.50%");

    await act(async () =>
      finishLater({
        ...agreement,
        terms: { ...agreement.terms, disclosure: '{"commission":"20%"}' },
      }),
    );

    expect(output()).toContain("20%");
    expect(output()).not.toContain("12.50%");
  });

  it("renders the exact retained disclosure without parsing or reordering it", async () => {
    const exact = '{"minimumRevenueCents":9007199254740993,"cap":null,"2":"second","1":"first"}';
    mocks.read.mockResolvedValue({
      ...agreement,
      terms: { ...agreement.terms, disclosure: exact },
    });
    await render();
    expect(view?.root.findByType("pre").children).toEqual([exact]);
  });

  it("records the current side without sending agreement identifiers and refreshes the read", async () => {
    mocks.read
      .mockResolvedValueOnce({
        ...agreement,
        revision: 1,
        assentState: "pending",
        creatorAcceptedAt: null,
      })
      .mockResolvedValueOnce(agreement);
    const output = await render();

    await act(async () => {
      await view?.root.findByProps({ children: "Accept affiliate terms" }).props.onClick();
    });

    expect(mocks.record).toHaveBeenCalledWith("Existing:QA", expect.any(String));
    expect(output()).toContain("Terms accepted — activation pending");
    expect(output()).not.toContain("Accept affiliate terms");
  });

  it("reports replay and retryable write failures without exposing backend details", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      revision: 1,
      assentState: "pending",
      creatorAcceptedAt: null,
    });
    mocks.record.mockResolvedValueOnce({ ok: true, revision: 1, state: "pending", replayed: true });
    const replay = await render();
    await act(async () => {
      await view?.root.findByProps({ children: "Accept affiliate terms" }).props.onClick();
    });
    expect(replay()).toContain("Your decision was already recorded");
    await act(async () => view?.unmount());

    mocks.record.mockRejectedValueOnce(new Error("private database detail"));
    const failed = await render();
    await act(async () => {
      await view?.root.findByProps({ children: "Accept affiliate terms" }).props.onClick();
    });
    expect(failed()).toContain("Could not record your decision");
    expect(failed()).not.toContain("private database detail");
  });

  it("shows active and paused lifecycle controls without tying them to collaboration completion", async () => {
    mocks.read
      .mockResolvedValueOnce({
        ...agreement,
        lifecycle: { status: "active", revision: 0, pausedBy: [] },
      })
      .mockResolvedValueOnce({
        ...agreement,
        lifecycle: { status: "paused", revision: 1, pausedBy: ["creator"] },
      });
    mocks.lifecycle.mockResolvedValue({
      ok: true,
      eventId: "event-1",
      revision: 1,
      effectiveAt: "2026-09-27T00:00:00.000Z",
      replayed: false,
    });
    const output = await render();
    expect(output()).toContain("Affiliate agreement active");
    expect(output()).toContain("independently of the hosted collaboration");
    expect(view?.root.findByProps({ children: "View results & earnings" }).props.href).toBe(
      "/earnings?propertyId=property-1",
    );
    await act(async () => {
      await view?.root.findByProps({ children: "Pause affiliate agreement" }).props.onClick();
    });
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      "Existing:QA",
      { action: "pause", reason: "Paused in Marketplace", expectedRevision: 0 },
      expect.any(String),
    );
    expect(output()).toContain("Affiliate agreement paused");
    expect(output()).toContain("Resume affiliate agreement");
  });

  it("retrieves the creator stable link without sending agreement identifiers", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      lifecycle: { status: "active", revision: 0, pausedBy: [] },
    });
    const output = await render();

    await act(async () => {
      await view?.root.findByProps({ children: "Get affiliate link" }).props.onClick();
    });

    expect(mocks.link).toHaveBeenCalledWith("Existing:QA", expect.any(String));
    expect(output()).toContain("https://api.localhost/r/va_abcdefghijklmnopqrstuv");
    expect(view?.root.findByProps({ "aria-label": "Stable affiliate link" }).props.href).toBe(
      undefined,
    );
  });

  it("copies, shares and safely tests a labeled mobile link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    mocks.read.mockResolvedValue({
      ...agreement,
      lifecycle: { status: "active", revision: 0, pausedBy: [] },
    });
    const output = await render();
    await act(async () =>
      view?.root.findByProps({ children: "Get affiliate link" }).props.onClick(),
    );
    await act(async () => view?.root.findByProps({ children: "Copy link" }).props.onClick());
    expect(writeText).toHaveBeenLastCalledWith(
      "https://api.localhost/r/va_abcdefghijklmnopqrstuv",
    );
    const input = view?.root.findByProps({ placeholder: "instagram.reel-1" });
    await act(async () => input?.props.onChange({ target: { value: "instagram.reel-1" } }));
    await act(async () =>
      view?.root.findByProps({ children: "Use labeled variant" }).props.onClick(),
    );
    expect(output()).toContain("?campaign=instagram.reel-1");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => view?.root.findByProps({ children: "Copy link" }).props.onClick());
    expect(output()).toContain("Select the URL and copy it manually");
    await act(async () => view?.root.findByProps({ children: "Copy link" }).props.onClick());
    expect(writeText).toHaveBeenLastCalledWith(
      "https://api.localhost/r/va_abcdefghijklmnopqrstuv?campaign=instagram.reel-1",
    );
    await act(async () => view?.root.findByProps({ children: "Share link" }).props.onClick());
    expect(share).toHaveBeenCalledWith({
      title: "Book this hotel",
      url: "https://api.localhost/r/va_abcdefghijklmnopqrstuv?campaign=instagram.reel-1",
    });
    await act(async () => view?.root.findByProps({ children: "Preview & test" }).props.onClick());
    expect(mocks.diagnostic).toHaveBeenCalledWith("Existing:QA", "instagram.reel-1");
    expect(output()).toContain("Link ready to share");
    expect(output()).toContain("Creator and hotel association verified");
    expect(output()).toContain("no visit was recorded or added to normal metrics");
    expect(output()).toContain("no booking or purchase was verified");

    for (const [status, expected] of [
      ["program_inactive", "Resume the paused agreement"],
      ["destination_unavailable", "Ask the hotel to fix its booking destination"],
      ["link_invalid", "Retrieve the affiliate link again"],
    ] as const) {
      mocks.diagnostic.mockResolvedValueOnce({
        ok: true,
        contractVersion: "marketplace-affiliate-link-diagnostic.v1",
        status,
        association: "verified",
        programStatus: status === "program_inactive" ? "paused" : "active",
        destinationUrl: null,
        campaignLabel: "instagram.reel-1",
        normalMetricsExcluded: true,
        externalPurchaseVerified: false,
      });
      await act(async () => view?.root.findByProps({ children: "Preview & test" }).props.onClick());
      expect(output()).toContain(expected);
    }
    mocks.diagnostic.mockRejectedValueOnce(
      new ApiErrorResponse(422, { code: "invalid_request" }),
    );
    await act(async () => view?.root.findByProps({ children: "Preview & test" }).props.onClick());
    expect(output()).toContain("Could not test that label");

    let resolveDiagnostic!: (value: Awaited<ReturnType<typeof mocks.diagnostic>>) => void;
    mocks.diagnostic.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiagnostic = resolve;
      }),
    );
    const staleRequest = view?.root.findByProps({ children: "Preview & test" }).props.onClick();
    await act(async () => input?.props.onChange({ target: { value: "youtube.short-2" } }));
    await act(async () =>
      view?.root.findByProps({ children: "Use labeled variant" }).props.onClick(),
    );
    await act(async () =>
      resolveDiagnostic({
        ok: true,
        contractVersion: "marketplace-affiliate-link-diagnostic.v1",
        status: "ready",
        association: "verified",
        programStatus: "active",
        destinationUrl: "https://alpine.next-booking.vayada.com/",
        campaignLabel: "instagram.reel-1",
        normalMetricsExcluded: true,
        externalPurchaseVerified: false,
      }),
    );
    await staleRequest;
    expect(output()).not.toContain("Link ready to share");
  });

  it("keeps creator link issuance out of the hotel controls", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      lifecycle: { status: "active", revision: 0, pausedBy: [] },
    });
    const hotelOutput = await render(true, "hotel");
    expect(hotelOutput()).not.toContain("Get affiliate link");
  });

  it.each(["active", "paused", "ended"] as const)(
    "offers a retry for a generic %s link failure",
    async (status) => {
      mocks.read.mockResolvedValue({
        ...agreement,
        lifecycle: { status, revision: 0, pausedBy: [] },
      });
      mocks.link.mockRejectedValueOnce(new Error("private readiness detail"));
      const output = await render();
      await act(async () => {
        await view?.root.findByProps({ children: "Get affiliate link" }).props.onClick();
      });
      expect(output()).toContain("Could not retrieve the affiliate link. Try again.");
      expect(output()).not.toContain("private readiness detail");
    },
  );

  it("explains coded link readiness and lifecycle failures", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      lifecycle: { status: "active", revision: 0, pausedBy: [] },
    });
    mocks.link.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "link_creation_blocked" }));
    const blocked = await render();
    await act(async () => {
      await view?.root.findByProps({ children: "Get affiliate link" }).props.onClick();
    });
    expect(blocked()).toContain("Ask the hotel to check its booking destination");
    await act(async () => view?.unmount());

    mocks.read.mockResolvedValue({
      ...agreement,
      lifecycle: { status: "paused", revision: 1, pausedBy: ["creator"] },
    });
    mocks.link.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "agreement_not_active" }));
    const inactive = await render();
    await act(async () => {
      await view?.root.findByProps({ children: "Get affiliate link" }).props.onClick();
    });
    expect(inactive()).toContain("Resume the agreement, then try again.");
  });

  it("explains a declined partnership and offers no assent action", async () => {
    mocks.read.mockResolvedValue({
      ...agreement,
      assentState: "pending",
      creatorAcceptedAt: null,
      hotelApprovedAt: null,
    });
    await act(async () => {
      view = create(
        createElement(AffiliateAgreementPanel, {
          collaborationId: "Existing:QA",
          currentUserType: "creator",
          affiliateExpected: true,
          collaborationStatus: "declined",
        }),
      );
    });
    const output = JSON.stringify(view?.toJSON());
    expect(output).toContain("Affiliate partnership declined");
    expect(output).not.toContain("Accept affiliate terms");
  });
});
