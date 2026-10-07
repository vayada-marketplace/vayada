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
      bookingReference: expect.stringMatching(/^VAY-[A-Z0-9]{32}$/),
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
    vi.mocked(finishPricingAcceptance).mockRejectedValue(
      new Error("Booking acceptance expired or unavailable"),
    );
    await expect(writePricingAcceptance(pool as never, input)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("classifies PostgreSQL failures separately from quote conflicts", async () => {
    vi.mocked(preparePricingAcceptance).mockRejectedValueOnce(
      Object.assign(new Error("connection lost"), { code: "08006" }),
    );
    await expect(writePricingAcceptance(pool as never, input)).rejects.toEqual(
      expect.objectContaining({ code: "storage" }),
    );
    vi.mocked(preparePricingAcceptance).mockRejectedValueOnce(
      new Error("Booking acceptance unavailable"),
    );
    await expect(writePricingAcceptance(pool as never, input)).rejects.toEqual(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("classifies pool connection failures without attempting cleanup", async () => {
    pool.connect.mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"));
    await expect(writePricingAcceptance(pool as never, input)).rejects.toEqual(
      expect.objectContaining({ code: "storage" }),
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("returns a historical replay without staging new writes", async () => {
    vi.mocked(preparePricingAcceptance).mockResolvedValue({
      kind: "replayed",
      bookingId: "existing",
      bookingReference: "VAY-EXISTING",
      replayed: true,
    });
    await expect(writePricingAcceptance(pool as never, input)).resolves.toEqual({
      kind: "replayed",
      bookingId: "existing",
      bookingReference: "VAY-EXISTING",
      replayed: true,
    });
    expect(stagePricingBookingDraft).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "COMMIT",
    ]);
  });

  it("passes a server-owned synthetic context only for a fresh booking", async () => {
    await writePricingAcceptance(pool as never, input, {
      syntheticAffiliateContextId: "trusted-fixture-context",
    });
    expect(stagePricingBookingDraft).toHaveBeenCalledWith(
      client,
      input.slug,
      expect.objectContaining({ syntheticAffiliateContextId: "trusted-fixture-context" }),
    );
  });
  it("passes a server-owned live context only for a fresh booking", async () => {
    await writePricingAcceptance(pool as never, input, {
      affiliateContextId: "trusted-live-context",
    });
    expect(stagePricingBookingDraft).toHaveBeenCalledWith(
      client,
      input.slug,
      expect.objectContaining({ affiliateContextId: "trusted-live-context" }),
    );
  });
});
