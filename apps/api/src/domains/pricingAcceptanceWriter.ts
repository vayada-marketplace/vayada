import type pg from "pg";
import { finishPricingAcceptance } from "./finishPricingAcceptance.js";
import { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import { stagePricingAcceptanceNotifications } from "./pricingAcceptanceNotifications.js";
import { stagePricingBookingDraft } from "./pricingBookingDraft.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { stagePricingBookingRevenue } from "./pricingBookingRevenue.js";
import { stagePmsAcceptedPricingReservationJob } from "./pricingPmsAcceptedReservationJob.js";
import { storePricingAcceptance } from "./storePricingAcceptance.js";

export async function writePricingAcceptance(
  pool: Pick<pg.Pool, "connect">,
  input: {
    slug: unknown;
    command: unknown;
    bookingId: string;
    publicReference: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const prepared = await preparePricingAcceptance(client, input.slug, input.command);
    if (prepared.kind === "replayed") {
      await client.query("COMMIT");
      return prepared;
    }
    await stagePricingBookingDraft(client, input.slug, {
      ...prepared,
      bookingId: input.bookingId,
      publicReference: input.publicReference,
    });
    const lifecycle = await stagePricingBookingLifecycle(
      client,
      input.slug,
      prepared.current,
      input.bookingId,
    );
    const revenue = await stagePricingBookingRevenue(
      client,
      input.slug,
      prepared.current,
      lifecycle,
    );
    const accepted = await storePricingAcceptance(client, input.slug, prepared, lifecycle, revenue);
    await stagePricingAcceptanceNotifications(client, input.slug, accepted);
    await stagePmsAcceptedPricingReservationJob(client, input.slug, accepted);
    const checkedAt = await finishPricingAcceptance(
      client,
      input.slug,
      prepared.current,
      prepared.finance,
    );
    await client.query("COMMIT");
    return { kind: "accepted" as const, ...accepted, checkedAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
