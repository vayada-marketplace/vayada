import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type pg from "pg";
import { createBookingPricingOfferTermsStore } from "./bookingPricingOfferTerms.js";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";

const flexible = {
  kind: "flexible",
  terms: {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  },
};

/** VAY-2304 tests: a hotel that publishes through the real "Save prices" commands, with a payment
 * setup to change. Card hotels get a ready synthetic Stripe account; cardOn() is Vayada's approval. */
export async function paymentRepublishFixture(pool: pg.Pool, methods: string[], card = false) {
  const actorUserId = randomUUID(),
    organizationId = randomUUID(),
    propertyId = randomUUID(),
    roomTypeId = randomUUID(),
    membershipId = randomUUID(),
    accountId = randomUUID(),
    roleKey = `republish_test_${randomUUID()}`,
    scope = { actorUserId, organizationId, propertyId };
  await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Republish test')", [
    actorUserId,
    `${actorUserId}@example.test`,
  ]);
  await pool.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Republish test',$2)",
    [organizationId, organizationId],
  );
  await pool.query(
    "INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES($1::uuid,$1::text,'Republish test','active')",
    [propertyId],
  );
  await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Garden room')", [
    roomTypeId,
    propertyId,
  ]);
  await pool.query(
    `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
    VALUES($1,$2,$3,$4,'all','agency')`,
    [membershipId, organizationId, actorUserId, roleKey],
  );
  for (const permission of ["pms.rooms_rates.read", "pms.rooms_rates.manage"])
    await pool.query(
      `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
      VALUES('hotel_group',$1,$2)`,
      [roleKey, permission],
    );
  for (const [product, type] of [
    ["pms", "pms_property"],
    ["hotel_catalog", "property"],
  ])
    await pool.query(
      `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship) VALUES($1,$2,$3,$4,'owner')`,
      [organizationId, product, type, propertyId],
    );
  await pool.query(
    "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
    [organizationId],
  );
  const context: RequestContext = {
    actor: {
      internalUserId: actorUserId,
      email: "republish@example.test",
      status: "active",
      providerIdentity: { provider: "workos", providerUserId: "test-user" },
    },
    selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
    membership: {
      membershipId,
      roleKey,
      status: "active",
      permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"],
      workosRoleSlugs: [],
    },
    linkedResources: [
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
    ],
    entitlements: [{ product: "pms", key: "property-management", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
  };
  if (card)
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,
        onboarding_status,charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
      VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,
        '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}')`,
      [accountId, propertyId, `acct_synthetic_${accountId}`],
    );
  await pool.query(
    `INSERT INTO finance.payment_settings(property_id,provider_account_id,payments_enabled,accepted_methods,default_currency)
    VALUES($1,$2,true,$3,'EUR')`,
    [propertyId, card ? accountId : null, methods],
  );
  const booking = createBookingPricingOfferTermsStore(pool);
  const termsInput = {
    roomTypeId,
    offerId: "flex",
    cancellation: flexible,
    payment: {
      kind: "full",
      acceptedMethods: card ? ["card", "pay_at_property"] : ["pay_at_property"],
    },
  };
  const terms = await booking.save(context, scope, {
    requestId: randomUUID(),
    expectedRevision: null,
    terms: termsInput,
  });
  /** A rate terms edit saved straight to the rate (not through "Save prices"). */
  const changeTerms = () =>
    booking.save(context, scope, {
      requestId: randomUUID(),
      expectedRevision: terms.revision,
      terms: {
        ...termsInput,
        cancellation: {
          ...flexible,
          terms: { ...flexible.terms, freeCancellationDeadlineDays: 3 },
        },
      },
    });
  const commands = createReplacementPricingCommands(pool, context);
  const prices = (revision: number, amountMinor = "10000") => ({
    currency: "EUR",
    rooms: [
      {
        version: "pricing.v2",
        propertyId,
        roomTypeId,
        revision,
        currency: "EUR",
        capacity: { total: 2, adults: 2, children: 0 },
        children: {
          adultFromAge: 12,
          bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
        },
        offers: [
          {
            id: "flex",
            termsRevision: terms.revision,
            meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
            price: {
              kind: "independent",
              calendar: {
                base: { mode: "flat", amountMinor },
                months: [],
                seasons: [],
                weekdays: [],
                dates: [],
              },
            },
            restrictions: {
              kind: "own",
              rules: {
                minArrivalNights: 1,
                maxStayNights: null,
                closedToArrival: false,
                closedToDeparture: false,
                stopSell: false,
              },
              seasons: [],
              dates: [],
            },
          },
        ],
      },
    ],
  });
  /** A hotel's "Save prices": prepare, draft, declare the charges, attach, publish. */
  async function save(baseRevision: number, amountMinor = "10000") {
    const prepared = await commands.prepare(propertyId, prices(baseRevision + 1, amountMinor));
    const draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision, ...prepared };
    await commands.saveDraft(propertyId, draft);
    const charges = await commands.confirmCharges(propertyId, {
      draftId,
      expectedDraftRevision: 1,
      claimedFingerprint: replacementChargeFingerprint(
        propertyId,
        prepared.snapshot,
        prepared.sources,
      )!,
      declaration: "all_mandatory_charges_included",
      requestId: randomUUID(),
    });
    const snapshot = {
      ...prepared.snapshot,
      ownerReferences: { ...prepared.snapshot.ownerReferences, charges: charges.id },
    };
    await commands.saveDraft(propertyId, { ...draft, expectedDraftRevision: 1, snapshot });
    return () =>
      commands.publish(propertyId, {
        requestId: randomUUID(),
        expectedRevision: baseRevision,
        sources: prepared.sources,
        snapshot,
        draft: { id: draftId, revision: 2 },
      });
  }
  async function cardOn() {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO finance.online_card_execution_evidence
        (id,property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,
          property_readiness_revision,evidence_fingerprint_hash,executed_at,accepted_at,
          accepted_by_organization_id,accepted_by_user_id)
      SELECT $1,s.property_id,s.provider_account_id,'finance-online-card-execution-evidence.v1','onb-25a',
        a.card_capability_revision,s.online_card_readiness_revision,$2,now(),now(),$3,$4
      FROM finance.payment_settings s JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id
      WHERE s.property_id=$5`,
      [id, id.replaceAll("-", "").repeat(2), organizationId, actorUserId, propertyId],
    );
    return id;
  }
  // The card switch's revoke (financeOnlineCardExecutionEvidenceRepository).
  const cardOff = (id: string) =>
    pool.query(
      "UPDATE finance.online_card_execution_evidence SET revoked_at=now(), updated_at=now() WHERE id=$1",
      [id],
    );
  /** What the booking page reads: the publication, if it serves. */
  async function served() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockCurrentPricingPublication(client, { propertyId, organizationId });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  return { propertyId, organizationId, commands, save, cardOn, cardOff, served, changeTerms };
}
