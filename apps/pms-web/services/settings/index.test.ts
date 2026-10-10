import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, put: mocks.put },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  getPmsPropertyProfile: vi.fn(),
  listPmsProperties: vi.fn(),
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

vi.mock("../api/unsupported", () => ({ unsupportedPmsNextStackFeature: vi.fn() }));

import { settingsService } from ".";

describe("PMS booking acceptance settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
  });

  it("reads and writes the typed target acceptance control", async () => {
    await settingsService.getBookingAcceptance();
    await settingsService.updateBookingAcceptance("request");

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/booking-acceptance",
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/booking-acceptance",
      { acceptanceMode: "request" },
      expect.any(Object),
    );
  });

  it("reads and idempotently updates the target same-day cutoff", async () => {
    await settingsService.getSameDayBooking();
    await settingsService.updateSameDayBooking(true, "17:30");

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/same-day-booking",
      expect.any(Object),
    );
    const [, body] = mocks.put.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      commandId: expect.stringMatching(/^pms\.same-day-booking:/),
      idempotencyKey: body.commandId,
      enabled: true,
      cutoffLocalTime: "17:30",
    });
  });
});

describe("PMS check-in and check-out templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.put.mockImplementation(async (_endpoint: string, body: { steps: unknown[] }) => ({
      template: { steps: body.steps, updatedAt: "2026-10-10T09:00:00.000Z", updatedByUserId: null },
    }));
  });

  it("saves and reads back the check-in step prompt and input type", async () => {
    const saved = await settingsService.updateCheckinChecklist([
      {
        id: "deposit",
        label: "Collect deposit",
        prompt: "Card or cash",
        type: "amount",
        required: true,
        position: 0,
      },
      {
        id: "ids",
        label: "Check IDs",
        prompt: " ",
        type: "checkbox",
        required: false,
        position: 1,
      },
    ]);

    const [endpoint, body] = mocks.put.mock.calls[0] as [string, { steps: unknown[] }];
    expect(endpoint).toBe("/api/pms/properties/property-1/check-in-checklist");
    expect(body.steps).toEqual([
      {
        stepId: "deposit",
        label: "Collect deposit",
        required: true,
        prompt: "Card or cash",
        type: "amount",
      },
      { stepId: "ids", label: "Check IDs", required: false, type: "checkbox" },
    ]);
    expect(saved.steps[0]).toMatchObject({ prompt: "Card or cash", type: "amount" });
  });

  it("saves and reads back the check-out answer labels and note hint", async () => {
    const saved = await settingsService.updateCheckoutInspection([
      {
        id: "minibar",
        label: "Minibar",
        okLabel: "Full",
        negativeLabel: "Used",
        notePrompt: "Which items?",
        required: true,
        position: 0,
      },
    ]);

    expect((mocks.put.mock.calls[0] as [string, { steps: unknown[] }])[1].steps).toEqual([
      {
        stepId: "minibar",
        label: "Minibar",
        required: true,
        okLabel: "Full",
        negativeLabel: "Used",
        notePrompt: "Which items?",
      },
    ]);
    expect(saved.steps[0]).toMatchObject({
      okLabel: "Full",
      negativeLabel: "Used",
      notePrompt: "Which items?",
    });
  });
});
