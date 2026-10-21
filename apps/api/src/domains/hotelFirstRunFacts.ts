import type { BookingDesignReadPort } from "@vayada/domain-booking";
import type {
  FinancePaymentReadinessReadPort,
  FinanceSubscriptionService,
} from "@vayada/domain-finance";
import type { PropertyProfileResponse } from "@vayada/domain-hotels";
import { parseDraftRoomId, type PmsOperatingCalendarReadPort } from "@vayada/domain-pms";

import type { BookingPublicationProjectionReadinessPort } from "./bookingPublicationProjector.js";
import type { HotelFirstRunPricingPorts } from "./hotelFirstRunPricing.js";
import type { HotelFirstRunWriteFacts } from "./hotelFirstRunService.js";
import type { HotelFirstRunFacts } from "./hotelFirstRunState.js";
import {
  FIRST_RUN_MAX_ROOM_TYPES,
  firstRunDraftRoomId,
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247: reads everything the first run needs to know about a hotel, through the existing read ports
 * only (no first-run table). Readiness supplies what only the publish check knows: whether saved prices
 * went stale and whether the calendar's days are prepared.
 */

type Scope = { propertyId: string; organizationId: string; actorUserId: string };

export type HotelFirstRunFactsPorts = Readonly<{
  profile: {
    getPropertyProfile(input: {
      organizationId: string;
      propertyId: string;
    }): Promise<PropertyProfileResponse | null>;
  };
  /** The hotel's booking language (Booking settings → default language), or null before it has one. */
  language: { read(propertyId: string): Promise<string | null> };
  pricingRead: HotelFirstRunSetupPorts["pricingRead"];
  roomRead: HotelFirstRunSetupPorts["roomRead"];
  paymentRead: FinancePaymentReadinessReadPort;
  pricing: Pick<HotelFirstRunPricingPorts["pricing"], "read">;
  calendarRead: Pick<PmsOperatingCalendarReadPort, "getCurrentOperatingCalendarConfiguration">;
  guestRules: { read(scope: Scope): Promise<unknown | null> };
  terms: { read(scope: Scope): Promise<{ termsText: string | null }> };
  designRead: BookingDesignReadPort;
  plans: Pick<FinanceSubscriptionService, "getPlanStatus">;
  readiness: BookingPublicationProjectionReadinessPort;
}>;

const PRICING_STALE = [
  "pricing_rooms_changed",
  "pricing_payments_changed",
  "pricing_terms_changed",
] as const;
type PricingStale = (typeof PRICING_STALE)[number];
const INVENTORY_NOT_PREPARED = "inventory_launch_readiness_incomplete";

/** Every blocker code of the booking readiness, or null when readiness can't be evaluated right now. */
async function readinessCodes(
  ports: HotelFirstRunFactsPorts,
  actor: HotelFirstRunActor,
): Promise<Set<string> | null> {
  const result = await ports.readiness.getBookingReadiness({
    organizationId: actor.organizationId,
    propertyId: actor.propertyId,
  });
  if (result.outcome !== "evaluated") return null;
  const codes = new Set<string>();
  for (const group of result.groups)
    for (const step of group.steps)
      for (const entity of step.entities)
        for (const blocker of entity.blockers) codes.add(blocker.code);
  return codes;
}

/** The room types the first run made, in order: it makes them one after another, so the first gap ends them. */
async function firstRunRoomTypeIds(
  ports: HotelFirstRunFactsPorts,
  propertyId: string,
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let index = 0; index < FIRST_RUN_MAX_ROOM_TYPES; index += 1) {
    const binding = await ports.roomRead.getDraftRoomTypeBinding(
      propertyId,
      parseDraftRoomId(firstRunDraftRoomId(index))!,
    );
    if (!binding) break;
    ids.push(binding.roomTypeId);
  }
  return Object.freeze(ids);
}

export function createHotelFirstRunFactsReader(ports: HotelFirstRunFactsPorts) {
  return {
    async read(actor: HotelFirstRunActor): Promise<HotelFirstRunWriteFacts> {
      const { propertyId, organizationId } = actor;
      const scope = { propertyId, organizationId, actorUserId: actor.userId };
      // One read at a time (VAY-2247 incident, 2026-10-21): in parallel, these ~13 reads and the per-room
      // ones queued on the API's shared pools, several of which hold a single connection, and starved
      // every other request. Sequential holds at most one connection per request.
      const profile = await ports.profile.getPropertyProfile({ organizationId, propertyId });
      const language = await ports.language.read(propertyId);
      const currency = await ports.pricingRead.getPropertyPricingCurrency(propertyId);
      const roomTypes = await ports.roomRead.listRoomTypeFacts(propertyId);
      const firstRunRoomTypes = await firstRunRoomTypeIds(ports, propertyId);
      const payments = await ports.paymentRead.getPaymentReadiness({ organizationId, propertyId });
      const pricing = await ports.pricing.read(propertyId);
      const calendar =
        await ports.calendarRead.getCurrentOperatingCalendarConfiguration(propertyId);
      const rules = await ports.guestRules.read(scope);
      const terms = await ports.terms.read(scope);
      const design = await ports.designRead.getCurrentDesign({ organizationId, propertyId });
      const plan = await ports.plans.getPlanStatus(propertyId);
      const codes = await readinessCodes(ports, actor);

      const rooms: HotelFirstRunFacts["roomTypes"][number][] = [];
      for (const room of roomTypes) {
        const capacity = await ports.roomRead.getRoomTypeCapacity(propertyId, room.roomTypeId);
        const units = await ports.roomRead.listPhysicalRoomUnitIdentities(
          propertyId,
          room.roomTypeId,
        );
        rooms.push(
          Object.freeze({
            roomTypeId: room.roomTypeId,
            roomFactsRevision: room.roomFactsRevision,
            roomUnitsRevision: capacity?.roomUnitsRevision ?? 0,
            activeUnitCount: capacity?.activeUnitCount ?? 0,
            unlabelledUnitIds: units
              .filter(
                (unit) => unit.lifecycle === "active" && unit.operationalLabelStatus !== "verified",
              )
              .map((unit) => unit.roomUnitId),
          }),
        );
      }

      const location = profile?.profile.location;
      const selected = new Set(
        payments?.methods.filter((method) => method.selected).map((method) => method.method),
      );
      return Object.freeze({
        propertyId,
        firstRunRoomTypeIds: firstRunRoomTypes,
        language,
        profile: profile
          ? Object.freeze({
              revision: profile.profileRevision,
              countryCode: location?.countryCode || null,
              timezone: location?.timezone || null,
              city: location?.city || null,
              localityPublic: location?.localityPublic ?? false,
            })
          : null,
        currency: currency
          ? Object.freeze({ code: currency.currency, revision: currency.pricingCurrencyRevision })
          : null,
        roomTypes: Object.freeze(rooms),
        payments: Object.freeze({
          payAtPropertySelected: selected.has("pay_at_property"),
          currencyMatches: payments?.pricingCurrency.matchesCurrent ?? false,
        }),
        pricing: Object.freeze({
          pricedRoomTypeIds: Object.freeze(
            (pricing?.rooms ?? [])
              .filter((room) => room.offers.length > 0)
              .map((room) => room.roomTypeId),
          ),
          staleReasons: Object.freeze(
            PRICING_STALE.filter((code): code is PricingStale => codes?.has(code) ?? false),
          ),
        }),
        calendar: Object.freeze({
          configured: Boolean(calendar),
          stale: calendar?.sourceStatus === "stale",
          // Unknown readiness counts as not prepared: preparing again replays, a wrong "prepared" would stick.
          inventoryPrepared:
            Boolean(calendar) && codes !== null && !codes.has(INVENTORY_NOT_PREPARED),
        }),
        guestRules: Object.freeze({
          rulesSaved: Boolean(rules),
          termsSaved: Boolean(terms.termsText),
          designSaved: Boolean(design),
        }),
        plan: firstRunPlan(plan),
      });
    },

    /**
     * What the setup checklist shows of setup, on every dashboard load: whether the first room and its price,
     * and how guests pay, are done. Four reads, one at a time, without the booking readiness or the
     * per-room reads `read` needs to run the first run (VAY-2247 incident, 2026-10-21).
     */
    async readSetupProgress(actor: HotelFirstRunActor): Promise<HotelFirstRunSetupProgress> {
      const { propertyId, organizationId } = actor;
      const roomTypes = await ports.roomRead.listRoomTypeFacts(propertyId);
      const pricing = await ports.pricing.read(propertyId);
      const payments = await ports.paymentRead.getPaymentReadiness({ organizationId, propertyId });
      const plan = firstRunPlan(await ports.plans.getPlanStatus(propertyId));
      const priced = new Set(
        (pricing?.rooms ?? [])
          .filter((room) => room.offers.length > 0)
          .map((room) => room.roomTypeId),
      );
      const payAtProperty = (payments?.methods ?? []).some(
        (method) => method.selected && method.method === "pay_at_property",
      );
      const currencyMatches = payments?.pricingCurrency.matchesCurrent ?? false;
      return Object.freeze({
        firstRoom: roomTypes.length > 0 && roomTypes.every((room) => priced.has(room.roomTypeId)),
        guestPayment:
          payAtProperty && currencyMatches && (plan === "commission" || plan === "fixed"),
      });
    },
  };
}

/** The setup checklist's view of setup: room and price, and how guests pay (done or not). */
export type HotelFirstRunSetupProgress = Readonly<{ firstRoom: boolean; guestPayment: boolean }>;

function firstRunPlan(
  plan: Awaited<ReturnType<HotelFirstRunFactsPorts["plans"]["getPlanStatus"]>>,
) {
  return plan.plan === "commission"
    ? ("commission" as const)
    : plan.plan === "fixed"
      ? ("fixed" as const)
      : plan.checkoutPending
        ? ("fixed_checkout_pending" as const)
        : ("none" as const);
}
