import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { stagePricingBookingDraft } from "./pricingBookingDraft.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";

vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
// Requires root's addon composition in stagePricingBookingDraft. Public authority
// and immutable quote lookup are fixture seams; all staging SQL and the addon
// projection are real. This does not exercise owner locks or full acceptance.
describe.skipIf(!url)("PostgreSQL pricing draft composition", () => {
  it.each([false, true])(
    "stages or rolls back booking/booker/addon (missing definition: %s)",
    async (missingDefinition) => {
      if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
        throw new Error("test database required");
      const propertyId = randomUUID(),
        addonId = randomUUID();
      const selected = {
        version: "addon-selection.v2" as const,
        id: addonId,
        quantity: 1,
        people: null,
        dates: ["2026-10-01"],
      };
      const input: Parameters<typeof stagePricingBookingDraft>[2] = pricingDraftFixture((quote) => {
        Object.assign(quote, { quoteId: randomUUID() });
        Object.assign(quote.stay, { propertyId, addons: [selected] });
        Object.assign(quote.evidence, {
          requestKey: replacementStayKey(quote.stay),
          totalMinor: "37250",
          dueLaterMinor: "37250",
          lines: [
            ...quote.evidence.lines,
            { id: "extra", kind: "addon", selectionId: null, amountMinor: "1250" },
          ],
        });
      });
      input.bookingId = randomUUID();
      input.publicReference = `VAY-${randomUUID().replaceAll("-", "").toUpperCase()}`;
      input.syntheticAffiliateContextId = randomUUID();
      input.current.scope.propertyId = propertyId;
      input.finance.scope.propertyId = propertyId;
      Object.assign(input.current, {
        calculation: {
          addons: {
            kind: "addon_components",
            evaluatorVersion: "booking.addon-components.v2",
            sourceRevision: input.current.quote.evidence.revisions.addons,
            requestKey: replacementStayKey(input.current.quote.stay),
            currency: "EUR",
            totalMinor: "1250",
            lines: [
              {
                definition: {
                  id: addonId,
                  name: "Synthetic extra",
                  amountMinor: "1250",
                  currency: "EUR",
                  pricingModel: "per_stay",
                  maxQuantity: 1,
                  maxGuests: null,
                  leadTime: null,
                  ownershipKind: "partner",
                  partnerCommissionRate: "12.5000",
                },
                quantity: 1,
                people: null,
                dates: selected.dates,
                peopleMultiplier: 1,
                daysMultiplier: 1,
                amountMinor: "1250",
              },
            ],
          },
        },
      });
      vi.mocked(lockPublicPricingAuthority).mockResolvedValue(input.current.scope);
      const db = new pg.Client({ connectionString: url });
      await db.connect();
      const caller = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.startsWith("SELECT id,payload FROM booking.pricing_quotes"))
            return {
              rows: [
                {
                  id: input.current.quote.quoteId,
                  payload: {
                    quote: input.current.quote,
                    calculation: { version: "booking.quote-calculation.v1" },
                  },
                },
              ],
            };
          return db.query(sql, values);
        },
      } as unknown as PoolClient;
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await db.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic draft')",
          [propertyId],
        );
        await db.query(
          "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,TRUE)",
          [input.syntheticAffiliateContextId, propertyId],
        );
        await db.query(
          `INSERT INTO booking.affiliate_click_admissions
             (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
          [input.syntheticAffiliateContextId, propertyId, randomUUID()],
        );
        if (!missingDefinition)
          await db.query(
            "INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,price_amount,currency,ownership_kind,partner_commission_rate) VALUES($1,$2,'Synthetic extra','per_stay',12.5,'EUR','partner',12.5)",
            [addonId, propertyId],
          );
        if (missingDefinition) {
          // Real composite definition FK fails after the booking/booker CTE.
          await expect(stagePricingBookingDraft(caller, "synthetic", input)).rejects.toMatchObject({
            code: "23503",
          });
        } else {
          await stagePricingBookingDraft(caller, "synthetic", input);
          const booking = (
            await db.query(
              "SELECT lifecycle_status,payment_status,total_amount::text,balance_amount::text,adults,children,room_count,quote_session_id,checkout_context_id,booking_metadata,billing_plan_snapshot,commission_terms_snapshot FROM booking.guest_bookings WHERE id=$1",
              [input.bookingId],
            )
          ).rows[0];
          expect(booking).toMatchObject({
            lifecycle_status: "draft",
            payment_status: "unpaid",
            total_amount: "372.50",
            balance_amount: "372.50",
            adults: 2,
            children: 1,
            room_count: 1,
            quote_session_id: null,
            checkout_context_id: null,
            billing_plan_snapshot: input.finance.billingPlanSnapshot,
            commission_terms_snapshot: input.finance.commissionTermsSnapshot,
            booking_metadata: {
              pricingQuoteId: input.current.quote.quoteId,
              pricingSelections: input.current.quote.stay.rooms,
            },
          });
          expect(
            (
              await db.query(
                `SELECT context_id,history_cutoff,original_public_reference,
                      original_check_in::text,original_check_out::text,original_currency
               FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1`,
                [input.bookingId],
              )
            ).rows[0],
          ).toEqual({
            context_id: input.syntheticAffiliateContextId,
            history_cutoff: "1",
            original_public_reference: input.publicReference,
            original_check_in: input.current.quote.stay.checkIn,
            original_check_out: input.current.quote.stay.checkOut,
            original_currency: input.current.quote.stay.currency,
          });
          expect(
            (
              await db.query(
                "SELECT guest_role,first_name,last_name,email FROM booking.booking_guests WHERE guest_booking_id=$1",
                [input.bookingId],
              )
            ).rows,
          ).toEqual([
            {
              guest_role: "booker",
              first_name: "Jane",
              last_name: "Guest",
              email: "jane@example.test",
            },
          ]);
          const addons = (
            await db.query(
              "SELECT total_amount::text,ownership_kind_snapshot,partner_commission_rate_snapshot::text,addon_snapshot FROM booking.booking_addon_selections WHERE guest_booking_id=$1",
              [input.bookingId],
            )
          ).rows;
          expect(addons).toHaveLength(1);
          expect(addons[0]).toMatchObject({
            total_amount: "12.50",
            ownership_kind_snapshot: "partner",
            partner_commission_rate_snapshot: "12.5000",
            addon_snapshot: {
              pricingQuoteId: input.current.quote.quoteId,
              selection: selected,
              amountMinor: "1250",
              sourceRevision: "a1",
            },
          });
        }
        await db.query("ROLLBACK");
        for (const [table, column] of [
          ["guest_bookings", "id"],
          ["booking_guests", "guest_booking_id"],
          ["booking_addon_selections", "guest_booking_id"],
          ["affiliate_original_booking_bindings", "booking_id"],
        ])
          expect(
            (
              await db.query(`SELECT count(*)::int AS n FROM booking.${table} WHERE ${column}=$1`, [
                input.bookingId,
              ])
            ).rows[0].n,
          ).toBe(0);
      } finally {
        await db.query("ROLLBACK");
        await db.end();
      }
    },
  );
});
