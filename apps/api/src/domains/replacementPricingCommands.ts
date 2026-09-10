import type { RequestContext } from "@vayada/backend-auth";
import { parsePricingConfiguration, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool } from "pg";
import { lockBookingPricingOfferTerms } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { createReplacementChargeDeclarationStore } from "./replacementChargeDeclarations.js";
import { lockReplacementPricingDraftOwners } from "./replacementPricingOfferOwners.js";
import { createReplacementPricingStorageGuard, lockReplacementPricingSources } from "./replacementPricingStorageGuard.js";
import { createReplacementPricingStore, PricingStorageError, type PricingStorageScope, type PricingStorageSnapshot } from "./replacementPricingStore.js";

type Store = ReturnType<typeof createReplacementPricingStore>;
type Publication = Parameters<Store["save"]>[1] & { draft: { id: string; revision: number } };
type ChargeCommand = Parameters<ReturnType<typeof createReplacementChargeDeclarationStore>["confirm"]>[2];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (code: "invalid" | "denied"): never => { throw new PricingStorageError(code); };

/** Server boundary: bind an authenticated context, never body-supplied identity.
 * Route policy enforcement is still required at the HTTP boundary. */
export function createReplacementPricingCommands(pool: Pool, context: RequestContext | null) {
  const trustedContext = structuredClone(context);
  const store = createReplacementPricingStore(pool, createReplacementPricingStorageGuard(trustedContext));
  const charges = createReplacementChargeDeclarationStore(pool);
  function scope(propertyId: string): PricingStorageScope {
    if (!uuid(propertyId)) return fail("invalid");
    const actorUserId = trustedContext?.actor.internalUserId, organizationId = trustedContext?.selectedOrganization?.organizationId;
    if (!uuid(actorUserId) || !uuid(organizationId)) return fail("denied");
    return { propertyId: propertyId.toLowerCase(), actorUserId: actorUserId.toLowerCase(), organizationId: organizationId.toLowerCase() };
  }
  return {
    /** Read-only preparation. Returned evidence can become stale; saves revalidate it. */
    async prepare(propertyId: string, input: unknown) {
      const currentScope = scope(propertyId);
      if (!pricingObject(input) || !pricingKeys(input, ["currency", "rooms"]) || typeof input.currency !== "string" ||
          !Array.isArray(input.rooms) || !input.rooms.length) return fail("invalid");
      const parsed = Array.from(input.rooms, parsePricingConfiguration), revision = parsed[0]?.revision, currency = input.currency;
      if (!revision || revision > 2147483647 || parsed.some((room) => !room || !uuid(room.roomTypeId) ||
          room.propertyId !== currentScope.propertyId || room.currency !== currency || room.revision !== revision) ||
          new Set(parsed.map((room) => room!.roomTypeId.toLowerCase())).size !== parsed.length) return fail("invalid");
      const rooms = parsed.map((room) => room!);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const sources = await lockReplacementPricingSources(client, trustedContext, currentScope, "manage");
        if (!sources) return fail("denied");
        const terms = await lockBookingPricingOfferTerms(client, currentScope.propertyId,
          rooms.flatMap((room) => room.offers.map((offer) => ({ roomTypeId: room.roomTypeId, offerId: offer.id, revision: offer.termsRevision }))));
        if (!terms) return fail("denied");
        const finance = await lockFinanceReplacementPricingReadiness(client, { propertyId: currentScope.propertyId, currency, pricingRevision: revision, terms });
        if (finance.kind !== "ready") return fail("denied");
        const snapshot: PricingStorageSnapshot = { currency, rooms, ownerReferences: { finance: finance.evidenceId } };
        const owners = await lockReplacementPricingDraftOwners(client, trustedContext, currentScope, snapshot, sources);
        if (owners.kind !== "awaiting_charge_confirmation") return fail("denied");
        await client.query("COMMIT"); return { sources, snapshot };
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async read(propertyId: string) { return store.read(scope(propertyId)); },
    async readDraft(propertyId: string, draftId: string) { return store.readDraft(scope(propertyId), draftId); },
    async saveDraft(propertyId: string, input: Parameters<Store["saveDraft"]>[1]) { return store.saveDraft(scope(propertyId), input); },
    async confirmCharges(propertyId: string, input: ChargeCommand) { return charges.confirm(trustedContext, scope(propertyId), input); },
    async publish(propertyId: string, input: Publication) {
      const currentScope = scope(propertyId);
      if (!pricingObject(input) || !pricingObject(input.draft)) return fail("invalid");
      // Retain the original complete command: no draft reload before historical receipt lookup.
      return store.save(currentScope, input);
    },
  };
}
