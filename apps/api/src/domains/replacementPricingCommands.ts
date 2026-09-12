import type { RequestContext } from "@vayada/backend-auth";
import { parsePricingConfiguration, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool } from "pg";
import { createBookingPricingOfferTermsStore, lockBookingPricingOfferTerms, projectBookingPricingDraftTerms, type BookingPricingDraft } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { createReplacementChargeDeclarationStore, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
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
  const booking = createBookingPricingOfferTermsStore(pool);
  const charges = createReplacementChargeDeclarationStore(pool);
  function scope(propertyId: string): PricingStorageScope {
    if (!uuid(propertyId)) return fail("invalid");
    const actorUserId = trustedContext?.actor.internalUserId, organizationId = trustedContext?.selectedOrganization?.organizationId;
    if (!uuid(actorUserId) || !uuid(organizationId)) return fail("denied");
    return { propertyId: propertyId.toLowerCase(), actorUserId: actorUserId.toLowerCase(), organizationId: organizationId.toLowerCase() };
  }
  return {
    /** Read-only preparation. Returned evidence can become stale; saves revalidate it. */
    async prepare(propertyId: string, input: unknown, draft?: BookingPricingDraft) {
      const currentScope = scope(propertyId);
      draft = structuredClone(draft);
      if (!pricingObject(input) || !pricingKeys(input, ["currency", "rooms"]) || typeof input.currency !== "string" ||
          !Array.isArray(input.rooms) || !input.rooms.length) return fail("invalid");
      const parsed = Array.from(input.rooms, parsePricingConfiguration), revision = parsed[0]?.revision, currency = input.currency;
      if (!revision || revision > 2147483647 || parsed.some((room) => !room || !uuid(room.roomTypeId) ||
          room.propertyId !== currentScope.propertyId || room.currency !== currency || room.revision !== revision) ||
          new Set(parsed.map((room) => room!.roomTypeId.toLowerCase())).size !== parsed.length) return fail("invalid");
      if (draft !== undefined && (!pricingObject(draft) || !pricingKeys(draft, ["draftId", "baseRevision"]) || !uuid(draft.draftId) || draft.baseRevision !== revision - 1)) return fail("invalid");
      const rooms = parsed.map((room) => room!);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const sources = await lockReplacementPricingSources(client, trustedContext, currentScope, "manage");
        if (!sources) return fail("denied");
        const references = rooms.flatMap((room) => room.offers.map((offer) => ({ roomTypeId: room.roomTypeId, offerId: offer.id, revision: offer.termsRevision })));
        const projected = draft ? await projectBookingPricingDraftTerms(client, trustedContext, currentScope, draft, references) : null;
        const terms = draft ? projected?.terms : await lockBookingPricingOfferTerms(client, currentScope.propertyId, references);
        const effectiveSources = draft && projected ? { ...sources, terms: projected.source } : sources;
        if (!terms) return fail("denied");
        const finance = await lockFinanceReplacementPricingReadiness(client, { propertyId: currentScope.propertyId, currency, pricingRevision: revision, terms });
        if (finance.kind !== "ready") return fail("denied");
        const snapshot: PricingStorageSnapshot = { currency, rooms, ownerReferences: { finance: finance.evidenceId } };
        const owners = await lockReplacementPricingDraftOwners(client, trustedContext, currentScope, snapshot, effectiveSources, draft);
        if (owners.kind !== "awaiting_charge_confirmation") return fail("denied");
        await client.query("COMMIT"); return { sources, snapshot, ...(draft ? { effectiveSources } : {}) };
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async stageTerms(propertyId: string, input: Parameters<typeof booking.stage>[2], draft: BookingPricingDraft) {
      return booking.stage(trustedContext, scope(propertyId), input, draft);
    },
    async readTerms(propertyId: string, roomTypeId: string, offerId: string) {
      return booking.read(trustedContext, scope(propertyId), roomTypeId, offerId);
    },
    async saveTerms(propertyId: string, input: Parameters<typeof booking.save>[2]) {
      return booking.save(trustedContext, scope(propertyId), input);
    },
    async reviewCharges(propertyId: string, draftId: string) {
      const currentScope = scope(propertyId), draft = await store.readDraft(currentScope, draftId);
      if (!draft) return null;
      if (draft.stale) throw new PricingStorageError("stale");
      const fingerprint = replacementChargeFingerprint(currentScope.propertyId, draft.snapshot, draft.effectiveSources ?? draft.sources);
      if (!fingerprint) return fail("invalid");
      return { draftId: draftId.toLowerCase(), ...draft, fingerprint, declaration: "all_mandatory_charges_included" as const };
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
