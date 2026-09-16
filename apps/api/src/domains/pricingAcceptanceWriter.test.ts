import { beforeEach, describe, expect, it, vi } from "vitest";
import { finishPricingAcceptance } from "./finishPricingAcceptance.js";
import { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import { stagePricingAcceptanceNotifications } from "./pricingAcceptanceNotifications.js";
import { writePricingAcceptance } from "./pricingAcceptanceWriter.js";
import { stagePricingBookingDraft } from "./pricingBookingDraft.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { stagePricingBookingRevenue } from "./pricingBookingRevenue.js";
import { stagePmsAcceptedPricingReservationJob } from "./pricingPmsAcceptedReservationJob.js";
import { storePricingAcceptance } from "./storePricingAcceptance.js";

vi.mock("./finishPricingAcceptance.js", () => ({ finishPricingAcceptance: vi.fn() }));
vi.mock("./preparePricingAcceptance.js", () => ({ preparePricingAcceptance: vi.fn() }));
vi.mock("./pricingAcceptanceNotifications.js", () => ({
  stagePricingAcceptanceNotifications: vi.fn(),
}));
vi.mock("./pricingBookingDraft.js", () => ({ stagePricingBookingDraft: vi.fn() }));
vi.mock("./pricingBookingLifecycle.js", () => ({ stagePricingBookingLifecycle: vi.fn() }));
vi.mock("./pricingBookingRevenue.js", () => ({ stagePricingBookingRevenue: vi.fn() }));
vi.mock("./pricingPmsAcceptedReservationJob.js", () => ({
  stagePmsAcceptedPricingReservationJob: vi.fn(),
}));
vi.mock("./storePricingAcceptance.js", () => ({ storePricingAcceptance: vi.fn() }));

const client = { query: vi.fn(), release: vi.fn() };
const pool = { connect: vi.fn(async () => client) };
const current = { scope: { propertyId: "property", organizationId: "organization" } };
const finance = { scope: current.scope };
const prepared = { kind: "fresh" as const, current, finance, disclosure: {}, command: {} };
const lifecycle = { bookingId: "booking" };
const revenue = { bookingId: "booking", roomNights: 2 };
const accepted = { bookingId: "booking", acceptanceId: "acceptance", acceptedAt: "accepted" };
const input = { slug: "hotel", command: {}, bookingId: "booking", publicReference: "VAY-ABC123" };

describe("pricing acceptance writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.query.mockResolvedValue({ rows: [] });
    vi.mocked(preparePricingAcceptance).mockResolvedValue(prepared as never);
    vi.mocked(stagePricingBookingLifecycle).mockResolvedValue(lifecycle as never);
    vi.mocked(stagePricingBookingRevenue).mockResolvedValue(revenue as never);
    vi.mocked(storePricingAcceptance).mockResolvedValue(accepted);
    vi.mocked(finishPricingAcceptance).mockResolvedValue("checked");
  });

  it("commits only after every staged write and the final gate", async () => {
    await expect(writePricingAcceptance(pool as never, input)).resolves.toEqual({
      kind: "accepted",
      ...accepted,
      checkedAt: "checked",
    });
    expect(stagePricingBookingDraft).toHaveBeenCalledBefore(
      vi.mocked(stagePricingBookingLifecycle),
    );
    expect(stagePricingBookingLifecycle).toHaveBeenCalledBefore(
      vi.mocked(stagePricingBookingRevenue),
    );
    expect(storePricingAcceptance).toHaveBeenCalledBefore(
      vi.mocked(stagePricingAcceptanceNotifications),
    );
    expect(stagePricingAcceptanceNotifications).toHaveBeenCalledBefore(
      vi.mocked(stagePmsAcceptedPricingReservationJob),
    );
    expect(stagePmsAcceptedPricingReservationJob).toHaveBeenCalledBefore(
      vi.mocked(finishPricingAcceptance),
    );
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back all staged writes when the final gate fails", async () => {
    vi.mocked(finishPricingAcceptance).mockRejectedValue(new Error("expired"));
    await expect(writePricingAcceptance(pool as never, input)).rejects.toThrow("expired");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns a historical replay without staging new writes", async () => {
    vi.mocked(preparePricingAcceptance).mockResolvedValue({
      kind: "replayed",
      bookingId: "existing",
      replayed: true,
    });
    await expect(writePricingAcceptance(pool as never, input)).resolves.toEqual({
      kind: "replayed",
      bookingId: "existing",
      replayed: true,
    });
    expect(stagePricingBookingDraft).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "COMMIT",
    ]);
  });
});
