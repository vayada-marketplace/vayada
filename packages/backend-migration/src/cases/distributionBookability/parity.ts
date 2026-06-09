import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type DistributionBookabilityPropertyCheck = NonNullable<
  ExpectedTarget["distributionBookabilityChecks"]
>["properties"][number];

function addDistributionFinding(
  findings: ParityFinding[],
  code: string,
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
  suggestedAction: string,
): void {
  findings.push({
    severity: "fail",
    code,
    owner: "Distribution bookability",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction,
  });
}

function includesAll(actual: string[] | null, expected: string[]): boolean {
  return actual !== null && expected.every((value) => actual.includes(value));
}

function equalsStringSet(actual: string[] | null, expected: string[]): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

async function checkOwnershipAndResourceLinks(
  client: pg.Client,
  check: DistributionBookabilityPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_memberships membership
       JOIN identity.organization_resource_links booking_link
         ON booking_link.organization_id = membership.organization_id
        AND booking_link.product = 'booking'
        AND booking_link.resource_type = 'booking_hotel'
        AND booking_link.resource_id = $3
        AND booking_link.relationship = 'owner'
        AND booking_link.status = 'active'
       JOIN identity.organization_resource_links pms_link
         ON pms_link.organization_id = membership.organization_id
        AND pms_link.product = 'pms'
        AND pms_link.resource_type = 'pms_hotel'
        AND pms_link.resource_id = $4
        AND pms_link.relationship = 'operator'
        AND pms_link.status = 'active'
       JOIN identity.product_entitlements booking_entitlement
         ON booking_entitlement.organization_id = membership.organization_id
        AND booking_entitlement.product = 'booking'
        AND booking_entitlement.entitlement_key = 'booking-engine'
        AND booking_entitlement.status = 'active'
        AND booking_entitlement.resource_product = 'booking'
        AND booking_entitlement.resource_type = 'booking_hotel'
        AND booking_entitlement.resource_id = $3
       JOIN identity.product_entitlements pms_entitlement
         ON pms_entitlement.organization_id = membership.organization_id
        AND pms_entitlement.product = 'pms'
        AND pms_entitlement.entitlement_key = 'pms-core'
        AND pms_entitlement.status = 'active'
        AND pms_entitlement.resource_product = 'pms'
        AND pms_entitlement.resource_type = 'pms_hotel'
        AND pms_entitlement.resource_id = $4
       JOIN hotel_catalog.property_source_links booking_source
         ON booking_source.property_id = $5
        AND booking_source.source_system = 'booking'
        AND booking_source.source_table = 'booking_hotels'
        AND booking_source.source_id = $3
        AND booking_source.relationship = 'canonical_input'
        AND booking_source.status = 'active'
       JOIN hotel_catalog.property_source_links pms_source
         ON pms_source.property_id = $5
        AND pms_source.source_system = 'pms'
        AND pms_source.source_table = 'hotels'
        AND pms_source.source_id = $4
        AND pms_source.relationship = 'operational_input'
        AND pms_source.status = 'active'
       JOIN finance.payment_provider_accounts account
         ON account.id = $6
        AND account.property_id = $5
        AND account.account_scope = 'property'
        AND account.provider_account_id = $7
        AND account.status = 'active'
        AND account.charges_enabled = TRUE
        AND account.payouts_enabled = TRUE
       JOIN finance.payment_settings settings
         ON settings.property_id = $5
        AND settings.provider_account_id = account.id
        AND settings.payments_enabled = TRUE
       WHERE membership.organization_id = $1
         AND membership.user_id = $2
         AND membership.status = 'active'
         AND membership.role_key = 'hotel_owner'
     ) AS exists`,
    [
      check.organizationId,
      check.ownerUserId,
      check.bookingHotelResourceId,
      check.pmsHotelResourceId,
      check.propertyId,
      check.providerAccountId,
      check.providerAccountRef,
    ],
  );

  if (!result.rows[0].exists) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_BOOKABILITY_OWNERSHIP_LINK_MISMATCH",
      "identity.organization_resource_links",
      `Expected distribution property ${check.propertyId} to be linked to booking, PMS, finance, and hotel-owner authorization rows`,
      "Active hotel-owner membership, booking owner link, PMS operator link, booking/PMS entitlements, catalog source links, and enabled finance payment settings",
      "relationship not found",
      "Check distribution fixture prerequisite ownership/resource rows before accepting public bookability projections.",
    );
  }
}

async function checkBookabilityProfile(
  client: pg.Client,
  check: DistributionBookabilityPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    finance_payment_settings_property_id: string | null;
    contract_version: string;
    public_visibility: string;
    public_id: string;
    canonical_slug: string;
    canonical_url: string;
    booking_base_url: string;
    timezone: string;
    default_locale: string;
    supported_locales: string[];
    default_currency: string;
    supported_currencies: string[];
    profile_status: string;
    freshness_status: string;
    data_sources: string[];
    setup_status: string | null;
    instant_book: boolean | null;
    online_payment: boolean | null;
    booking_deep_links: boolean | null;
    min_rooms: number | null;
    max_rooms: number | null;
    catalog_public_id: string | null;
    catalog_slug: string | null;
    catalog_status: string | null;
    payment_settings_property_id: string | null;
  }>(
    `SELECT
       profile.finance_payment_settings_property_id::text,
       profile.contract_version,
       profile.public_visibility,
       profile.public_id,
       profile.canonical_slug,
       profile.canonical_url,
       profile.booking_base_url,
       profile.timezone,
       profile.default_locale,
       profile.supported_locales,
       profile.default_currency,
       profile.supported_currencies,
       profile.profile_status,
       profile.freshness_status,
       profile.data_sources,
       profile.public_setup_completeness ->> 'status' AS setup_status,
       (profile.capabilities ->> 'instantBook')::boolean AS instant_book,
       (profile.capabilities ->> 'onlinePayment')::boolean AS online_payment,
       (profile.capabilities ->> 'bookingDeepLinks')::boolean AS booking_deep_links,
       (profile.supported_quote_parameters ->> 'minRooms')::integer AS min_rooms,
       (profile.supported_quote_parameters ->> 'maxRooms')::integer AS max_rooms,
       catalog.public_id AS catalog_public_id,
       catalog.canonical_slug AS catalog_slug,
       catalog.profile_status AS catalog_status,
       settings.property_id::text AS payment_settings_property_id
     FROM distribution.public_hotel_bookability_profiles profile
     LEFT JOIN hotel_catalog.property_public_profile_read_model catalog
       ON catalog.property_id = profile.property_id
     LEFT JOIN finance.payment_settings settings
       ON settings.property_id = profile.finance_payment_settings_property_id
     WHERE profile.property_id = $1`,
    [check.propertyId],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.finance_payment_settings_property_id === check.propertyId &&
    row.contract_version === "public-bookability.v1" &&
    row.public_visibility === "public_safe" &&
    row.public_id === check.publicId &&
    row.canonical_slug === check.canonicalSlug &&
    row.canonical_url === check.canonicalUrl &&
    row.booking_base_url === check.bookingBaseUrl &&
    row.timezone === check.timezone &&
    row.default_locale === check.defaultLocale &&
    includesAll(row.supported_locales, [check.defaultLocale, "de"]) &&
    row.default_currency === check.defaultCurrency &&
    includesAll(row.supported_currencies, [check.defaultCurrency, "USD"]) &&
    row.profile_status === "public" &&
    row.freshness_status === "fresh" &&
    includesAll(row.data_sources, ["hotel_catalog", "booking", "pms", "finance", "distribution"]) &&
    row.setup_status === "ready" &&
    row.instant_book === true &&
    row.online_payment === true &&
    row.booking_deep_links === true &&
    row.min_rooms === 1 &&
    row.max_rooms === 4 &&
    row.catalog_public_id === check.publicId &&
    row.catalog_slug === check.canonicalSlug &&
    row.catalog_status === "complete" &&
    row.payment_settings_property_id === check.propertyId;

  if (!matches) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_BOOKABILITY_PROFILE_MISMATCH",
      "distribution.public_hotel_bookability_profiles",
      `Expected public bookability profile for property ${check.propertyId} was not found`,
      "Public-safe v1 profile linked to catalog read model and enabled finance payment settings with complete freshness/capability projection",
      row ? JSON.stringify(row) : "row missing",
      "Check distribution profile fixture values, profile/catalog relationship, and finance payment-settings linkage.",
    );
  }
}

async function checkRoomOfferSnapshots(
  client: pg.Client,
  check: DistributionBookabilityPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    id: string;
    property_id: string;
    room_type_id: string;
    rate_plan_id: string | null;
    stay_date: string;
    public_offer_key: string;
    contract_version: string;
    public_visibility: string;
    availability_status: string;
    sellable_publicly: boolean;
    available_rooms: number;
    base_price_amount: string;
    taxes_and_fees_amount: string;
    discounts_amount: string;
    currency: string;
    payment_options: string[];
    accepted_methods: string[];
    unavailable_reasons: string[];
    freshness_status: string;
    data_sources: string[];
    inventory_available_count: number;
    inventory_status: string;
    rate_plan_code: string | null;
    room_type_name: string | null;
  }>(
    `SELECT
       offer.id::text,
       offer.property_id::text,
       offer.room_type_id::text,
       offer.rate_plan_id::text,
       offer.stay_date::text,
       offer.public_offer_key,
       offer.contract_version,
       offer.public_visibility,
       offer.availability_status,
       offer.sellable_publicly,
       offer.available_rooms,
       offer.base_price_amount::text,
       offer.taxes_and_fees_amount::text,
       offer.discounts_amount::text,
       offer.currency,
       offer.payment_options,
       settings.accepted_methods,
       offer.unavailable_reasons,
       offer.freshness_status,
       offer.data_sources,
       inventory.available_count AS inventory_available_count,
       inventory.status AS inventory_status,
       rate_plan.code AS rate_plan_code,
       room_type.name AS room_type_name
     FROM distribution.public_room_offer_snapshots offer
     JOIN pms.inventory_days inventory
       ON inventory.property_id = offer.property_id
      AND inventory.room_type_id = offer.room_type_id
      AND inventory.stay_date = offer.stay_date
     JOIN pms.rate_plans rate_plan
       ON rate_plan.id = offer.rate_plan_id
      AND rate_plan.property_id = offer.property_id
      AND rate_plan.room_type_id = offer.room_type_id
     JOIN pms.room_types room_type
       ON room_type.id = offer.room_type_id
      AND room_type.property_id = offer.property_id
     JOIN finance.payment_settings settings
       ON settings.property_id = offer.property_id
     WHERE offer.id IN ($1, $2)`,
    [check.availableRoomOfferSnapshotId, check.soldOutRoomOfferSnapshotId],
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const available = byId.get(check.availableRoomOfferSnapshotId);
  const soldOut = byId.get(check.soldOutRoomOfferSnapshotId);
  const sharedFieldsMatch = (row: (typeof result.rows)[number] | undefined) =>
    row &&
    row.property_id === check.propertyId &&
    row.room_type_id === check.roomTypeId &&
    row.rate_plan_id === check.ratePlanId &&
    row.contract_version === "public-bookability.v1" &&
    row.public_visibility === "public_safe" &&
    row.currency === check.defaultCurrency &&
    equalsStringSet(row.accepted_methods, ["card", "pay_at_property"]) &&
    equalsStringSet(row.payment_options, row.accepted_methods) &&
    row.freshness_status === "fresh" &&
    includesAll(row.data_sources, ["booking", "pms", "finance", "distribution"]) &&
    row.rate_plan_code === "DIRECT-FLEX" &&
    row.room_type_name === "Alpine Suite";

  const availableMatches =
    sharedFieldsMatch(available) &&
    available?.stay_date === check.availableStayDate &&
    available.public_offer_key === check.availableOfferKey &&
    available.availability_status === "available" &&
    available.sellable_publicly === true &&
    available.available_rooms === check.availableRooms &&
    available.inventory_available_count === check.availableRooms &&
    available.inventory_status === "open" &&
    available.base_price_amount === "340.00" &&
    available.taxes_and_fees_amount === "34.00" &&
    available.discounts_amount === "20.00";

  const soldOutMatches =
    sharedFieldsMatch(soldOut) &&
    soldOut?.stay_date === check.soldOutStayDate &&
    soldOut.public_offer_key === check.soldOutOfferKey &&
    soldOut.availability_status === "sold_out" &&
    soldOut.sellable_publicly === false &&
    soldOut.available_rooms === 0 &&
    soldOut.inventory_available_count === 0 &&
    soldOut.inventory_status === "closed" &&
    soldOut.unavailable_reasons.includes("sold_out");

  if (!availableMatches || !soldOutMatches) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_ROOM_OFFER_SNAPSHOT_MISMATCH",
      "distribution.public_room_offer_snapshots",
      `Expected public room offer snapshots for property ${check.propertyId} were not found`,
      "One public available offer and one sold-out offer linked to PMS inventory/rate rows with public-safe payment and policy fields",
      JSON.stringify({
        available: available ?? null,
        soldOut: soldOut ?? null,
      }),
      "Check room offer fixture rows and PMS inventory/rate relationship preservation.",
    );
  }
}

async function checkQuoteAndDeepLink(
  client: pg.Client,
  check: DistributionBookabilityPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    quote_session_id: string;
    property_id: string;
    public_quote_reference: string;
    quote_hash: string;
    quote_status: string;
    quote_currency: string;
    quote_freshness_status: string;
    quote_data_sources: string[];
    deep_link_url: string | null;
    price_guarantee: string;
    request_check_in: string | null;
    request_check_out: string | null;
    request_adults: number | null;
    request_children: number | null;
    request_rooms: number | null;
    request_locale: string | null;
    request_currency: string | null;
    first_offer_key: string | null;
    offer_count: number;
    total_amount: string | null;
    booking_quote_status: string | null;
    booking_quote_reference: string | null;
    booking_check_in: string | null;
    booking_check_out: string | null;
    booking_adults: number | null;
    booking_children: number | null;
    booking_rooms: number | null;
    booking_currency: string | null;
    promo_code: string | null;
    referral_code: string | null;
    checkout_context_id: string | null;
    checkout_status: string | null;
    deep_link_context_id: string | null;
    deep_link_status: string | null;
    context_token_hash: string | null;
    context_public_quote_reference: string | null;
    context_deep_link_url: string | null;
    context_locale: string | null;
    context_currency: string | null;
    context_check_in: string | null;
    context_check_out: string | null;
    context_adults: number | null;
    context_children: number | null;
    context_rooms: number | null;
    context_preserves: string[] | null;
  }>(
    `SELECT
       read_model.quote_session_id::text,
       read_model.property_id::text,
       read_model.public_quote_reference,
       read_model.quote_hash,
       read_model.quote_status,
       read_model.currency AS quote_currency,
       read_model.freshness_status AS quote_freshness_status,
       read_model.data_sources AS quote_data_sources,
       read_model.deep_link_url,
       read_model.price_guarantee,
       read_model.request_snapshot ->> 'checkIn' AS request_check_in,
       read_model.request_snapshot ->> 'checkOut' AS request_check_out,
       (read_model.request_snapshot ->> 'adults')::integer AS request_adults,
       (read_model.request_snapshot ->> 'children')::integer AS request_children,
       (read_model.request_snapshot ->> 'rooms')::integer AS request_rooms,
       read_model.request_snapshot ->> 'locale' AS request_locale,
       read_model.request_snapshot ->> 'currency' AS request_currency,
       read_model.offers #>> '{0,publicOfferKey}' AS first_offer_key,
       jsonb_array_length(read_model.offers) AS offer_count,
       read_model.totals ->> 'total' AS total_amount,
       quote.status AS booking_quote_status,
       quote.public_quote_reference AS booking_quote_reference,
       quote.requested_check_in::text AS booking_check_in,
       quote.requested_check_out::text AS booking_check_out,
       quote.adults AS booking_adults,
       quote.children AS booking_children,
       quote.requested_room_count AS booking_rooms,
       quote.currency AS booking_currency,
       quote.promo_code,
       quote.referral_code,
       checkout.id::text AS checkout_context_id,
       checkout.status AS checkout_status,
       deep_link.id::text AS deep_link_context_id,
       deep_link.status AS deep_link_status,
       deep_link.context_token_hash,
       deep_link.public_quote_reference AS context_public_quote_reference,
       deep_link.deep_link_url AS context_deep_link_url,
       deep_link.locale AS context_locale,
       deep_link.currency AS context_currency,
       deep_link.check_in::text AS context_check_in,
       deep_link.check_out::text AS context_check_out,
       deep_link.adults AS context_adults,
       deep_link.children AS context_children,
       deep_link.rooms AS context_rooms,
       deep_link.preserves AS context_preserves
     FROM distribution.public_quote_read_models read_model
     JOIN booking.quote_sessions quote
       ON quote.id = read_model.quote_session_id
      AND quote.property_id = read_model.property_id
     LEFT JOIN booking.checkout_contexts checkout
       ON checkout.id = $3
      AND checkout.quote_session_id = quote.id
      AND checkout.property_id = quote.property_id
     LEFT JOIN distribution.booking_deep_link_contexts deep_link
       ON deep_link.id = $4
      AND deep_link.quote_session_id = quote.id
      AND deep_link.checkout_context_id = checkout.id
      AND deep_link.property_id = quote.property_id
     WHERE read_model.quote_session_id = $1
       AND read_model.property_id = $2`,
    [check.quoteSessionId, check.propertyId, check.checkoutContextId, check.deepLinkContextId],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.quote_session_id === check.quoteSessionId &&
    row.property_id === check.propertyId &&
    row.public_quote_reference === check.publicQuoteReference &&
    row.quote_hash === check.quoteHash &&
    row.quote_status === "bookable" &&
    row.quote_currency === check.defaultCurrency &&
    row.quote_freshness_status === "fresh" &&
    includesAll(row.quote_data_sources, ["booking", "pms", "finance", "distribution"]) &&
    row.deep_link_url === check.deepLinkUrl &&
    row.price_guarantee === "expires_at" &&
    row.request_check_in === check.checkIn &&
    row.request_check_out === check.checkOut &&
    row.request_adults === check.adults &&
    row.request_children === check.children &&
    row.request_rooms === check.rooms &&
    row.request_locale === check.defaultLocale &&
    row.request_currency === check.defaultCurrency &&
    row.first_offer_key === check.availableOfferKey &&
    row.offer_count === 1 &&
    row.total_amount === check.totalAmount &&
    row.booking_quote_status === "active" &&
    row.booking_quote_reference === check.publicQuoteReference &&
    row.booking_check_in === check.checkIn &&
    row.booking_check_out === check.checkOut &&
    row.booking_adults === check.adults &&
    row.booking_children === check.children &&
    row.booking_rooms === check.rooms &&
    row.booking_currency === check.defaultCurrency &&
    row.promo_code === "SUMMER689" &&
    row.referral_code === "AFF-DIST-689" &&
    row.checkout_context_id === check.checkoutContextId &&
    row.checkout_status === "active" &&
    row.deep_link_context_id === check.deepLinkContextId &&
    row.deep_link_status === "active" &&
    row.context_token_hash === check.contextTokenHash &&
    row.context_public_quote_reference === check.publicQuoteReference &&
    row.context_deep_link_url === check.deepLinkUrl &&
    row.context_locale === check.defaultLocale &&
    row.context_currency === check.defaultCurrency &&
    row.context_check_in === check.checkIn &&
    row.context_check_out === check.checkOut &&
    row.context_adults === check.adults &&
    row.context_children === check.children &&
    row.context_rooms === check.rooms &&
    includesAll(row.context_preserves, [
      "dates",
      "guests",
      "rooms",
      "currency",
      "locale",
      "promo_code",
      "referral_code",
      "quote_id",
    ]);

  if (!matches) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_QUOTE_DEEP_LINK_MISMATCH",
      "distribution.public_quote_read_models",
      `Expected public quote/deep-link projection ${check.publicQuoteReference} was not found`,
      "Bookable public quote read model linked to matching booking quote session, checkout context, and active deep-link context preserving request parameters",
      row ? JSON.stringify(row) : "row missing",
      "Check distribution quote and deep-link fixture rows for stable IDs, request preservation, and booking relationship integrity.",
    );
  }
}

async function checkExternalApiClientAndUsage(
  client: pg.Client,
  check: DistributionBookabilityPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const clientResult = await client.query<{
    id: string;
    public_client_id: string;
    status: string;
    allowed_surfaces: string[];
    rate_limit_tier: string;
    terms_version: string;
    has_credential_ref: boolean;
    created_by_user_id: string | null;
    revoked_by_user_id: string | null;
    revoked_at: string | null;
    revocation_reason: string | null;
  }>(
    `SELECT
       id::text,
       public_client_id,
       status,
       allowed_surfaces,
       rate_limit_tier,
       terms_version,
       credential_hash_ref IS NOT NULL AS has_credential_ref,
       created_by_user_id::text,
       revoked_by_user_id::text,
       revoked_at::text,
       revocation_reason
     FROM distribution.external_api_clients
     WHERE id IN ($1, $2)`,
    [check.activeApiClientId, check.revokedApiClientId],
  );

  const clientsById = new Map(clientResult.rows.map((row) => [row.id, row]));
  const activeClient = clientsById.get(check.activeApiClientId);
  const revokedClient = clientsById.get(check.revokedApiClientId);
  const activeClientMatches =
    activeClient &&
    activeClient.public_client_id === check.activePublicClientId &&
    activeClient.status === "active" &&
    equalsStringSet(activeClient.allowed_surfaces, [
      "public_profile",
      "public_quote",
      "deep_link",
    ]) &&
    activeClient.rate_limit_tier === "partner" &&
    activeClient.terms_version === "public-ai-terms-2026-06" &&
    activeClient.has_credential_ref === true &&
    activeClient.created_by_user_id === check.ownerUserId &&
    activeClient.revoked_by_user_id === null &&
    activeClient.revoked_at === null &&
    activeClient.revocation_reason === null;

  const revokedClientMatches =
    revokedClient &&
    revokedClient.public_client_id === check.revokedPublicClientId &&
    revokedClient.status === "revoked" &&
    revokedClient.rate_limit_tier === "blocked" &&
    revokedClient.has_credential_ref === true &&
    revokedClient.revoked_by_user_id !== null &&
    revokedClient.revoked_at !== null &&
    revokedClient.revocation_reason !== null;

  if (!activeClientMatches || !revokedClientMatches) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_EXTERNAL_API_CLIENT_MISMATCH",
      "distribution.external_api_clients",
      "Expected active and revoked external API client rows were not found",
      "Active partner client with public profile/quote/deep-link surfaces and revoked client with explicit revocation state",
      JSON.stringify({ activeClient: activeClient ?? null, revokedClient: revokedClient ?? null }),
      "Check external API client fixture rows for status, surface allowlist, rate-limit tier, credential reference, and revocation integrity.",
    );
  }

  const usageResult = await client.query<{
    id: string;
    client_id: string | null;
    property_id: string | null;
    quote_session_id: string | null;
    deep_link_context_id: string | null;
    surface: string;
    request_method: string;
    route_template: string;
    response_status: number;
    rate_limit_policy: string;
    rate_limit_tier: string;
    cache_status: string | null;
    public_visibility: string | null;
  }>(
    `SELECT
       id::text,
       client_id::text,
       property_id::text,
       quote_session_id::text,
       deep_link_context_id::text,
       surface,
       request_method,
       route_template,
       response_status,
       rate_limit_policy,
       rate_limit_tier,
       cache_status,
       usage_metadata ->> 'publicVisibility' AS public_visibility
     FROM distribution.external_api_usage_events
     WHERE id IN ($1, $2, $3)`,
    [check.profileUsageEventId, check.quoteUsageEventId, check.deepLinkUsageEventId],
  );

  const usageById = new Map(usageResult.rows.map((row) => [row.id, row]));
  const profileEvent = usageById.get(check.profileUsageEventId);
  const quoteEvent = usageById.get(check.quoteUsageEventId);
  const deepLinkEvent = usageById.get(check.deepLinkUsageEventId);
  const baseUsageMatches = (row: (typeof usageResult.rows)[number] | undefined) =>
    row &&
    row.client_id === check.activeApiClientId &&
    row.property_id === check.propertyId &&
    row.request_method === "GET" &&
    row.rate_limit_tier === "partner" &&
    row.public_visibility === "public_safe";

  const profileEventMatches =
    baseUsageMatches(profileEvent) &&
    profileEvent?.quote_session_id === null &&
    profileEvent.deep_link_context_id === null &&
    profileEvent.surface === "public_profile" &&
    profileEvent.route_template === "/api/ai/hotels/{slug}" &&
    profileEvent.response_status === 200 &&
    profileEvent.rate_limit_policy === "public-ai-profile-read" &&
    profileEvent.cache_status === "hit";

  const quoteEventMatches =
    baseUsageMatches(quoteEvent) &&
    quoteEvent?.quote_session_id === check.quoteSessionId &&
    quoteEvent.deep_link_context_id === null &&
    quoteEvent.surface === "public_quote" &&
    quoteEvent.route_template === "/api/ai/hotels/{slug}/quote" &&
    quoteEvent.response_status === 200 &&
    quoteEvent.rate_limit_policy === "public-ai-quote-read" &&
    quoteEvent.cache_status === "miss";

  const deepLinkEventMatches =
    baseUsageMatches(deepLinkEvent) &&
    deepLinkEvent?.quote_session_id === check.quoteSessionId &&
    deepLinkEvent.deep_link_context_id === check.deepLinkContextId &&
    deepLinkEvent.surface === "deep_link" &&
    deepLinkEvent.route_template === "/api/ai/hotels/{slug}/quote/deep-link" &&
    deepLinkEvent.response_status === 302 &&
    deepLinkEvent.rate_limit_policy === "public-ai-deep-link" &&
    deepLinkEvent.cache_status === "bypass";

  if (!profileEventMatches || !quoteEventMatches || !deepLinkEventMatches) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_EXTERNAL_API_USAGE_MISMATCH",
      "distribution.external_api_usage_events",
      "Expected public profile, quote, and deep-link API usage events were not found",
      "Three usage events linked to the active client and property, with quote/deep-link relationships only where appropriate",
      JSON.stringify({
        profileEvent: profileEvent ?? null,
        quoteEvent: quoteEvent ?? null,
        deepLinkEvent: deepLinkEvent ?? null,
      }),
      "Check usage event fixture rows for client/property/quote/deep-link relationship integrity and public rate-limit metadata.",
    );
  }
}

async function checkDistributionJsonPrivateKeyBoundary(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ target_object: string; row_id: string }>(
    `SELECT target_object, row_id
     FROM (
       SELECT
         'distribution.public_hotel_bookability_profiles' AS target_object,
         property_id::text AS row_id,
         (
           distribution.jsonb_has_distribution_private_key(public_identity)
           OR distribution.jsonb_has_distribution_private_key(location)
           OR distribution.jsonb_has_distribution_private_key(media)
           OR distribution.jsonb_has_distribution_private_key(amenities)
           OR distribution.jsonb_has_distribution_private_key(policies)
           OR distribution.jsonb_has_distribution_private_key(capabilities)
           OR distribution.jsonb_has_distribution_private_key(supported_quote_parameters)
           OR distribution.jsonb_has_distribution_private_key(public_setup_completeness)
           OR distribution.jsonb_has_distribution_private_key(source_freshness)
         ) AS has_private_key
       FROM distribution.public_hotel_bookability_profiles
       UNION ALL
       SELECT
         'distribution.public_room_offer_snapshots',
         id::text,
         (
           distribution.jsonb_has_distribution_private_key(occupancy)
           OR distribution.jsonb_has_distribution_private_key(room_summary)
           OR distribution.jsonb_has_distribution_private_key(rate_summary)
           OR distribution.jsonb_has_distribution_private_key(public_policy)
           OR distribution.jsonb_has_distribution_private_key(source_freshness)
         )
       FROM distribution.public_room_offer_snapshots
       UNION ALL
       SELECT
         'distribution.public_quote_read_models',
         quote_session_id::text,
         (
           distribution.jsonb_has_distribution_private_key(request_snapshot)
           OR distribution.jsonb_has_distribution_private_key(unavailable_reasons)
           OR distribution.jsonb_has_distribution_private_key(offers)
           OR distribution.jsonb_has_distribution_private_key(totals)
           OR distribution.jsonb_has_distribution_private_key(source_freshness)
         )
       FROM distribution.public_quote_read_models
       UNION ALL
       SELECT
         'distribution.booking_deep_link_contexts',
         id::text,
         (
           distribution.jsonb_has_distribution_private_key(request_context)
           OR distribution.jsonb_has_distribution_private_key(source_freshness)
         )
       FROM distribution.booking_deep_link_contexts
       UNION ALL
       SELECT
         'distribution.external_api_clients',
         id::text,
         distribution.jsonb_has_distribution_private_key(client_metadata)
       FROM distribution.external_api_clients
       UNION ALL
       SELECT
         'distribution.external_api_usage_events',
         id::text,
         distribution.jsonb_has_distribution_private_key(usage_metadata)
       FROM distribution.external_api_usage_events
     ) AS checked_documents
     WHERE has_private_key`,
  );

  for (const row of result.rows) {
    addDistributionFinding(
      findings,
      "DISTRIBUTION_PUBLIC_JSON_PRIVATE_KEY",
      row.target_object,
      `Distribution public JSON row ${row.row_id} contains a forbidden private key`,
      "No guest PII, provider/private finance keys, PMS operational keys, raw source keys, or token/secret keys in public JSON projections",
      row.row_id,
      "Filter private fields before inserting distribution public-safe JSON read models.",
    );
  }
}

async function checkForbiddenPublicOutputValues(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenValues = expected.distributionBookabilityChecks?.forbiddenPublicOutputValues ?? [];
  if (forbiddenValues.length === 0) return;

  const result = await client.query<{
    target_object: string;
    row_id: string;
    public_document: string;
  }>(
    `SELECT target_object, row_id, public_document
     FROM (
       SELECT
         'distribution.public_hotel_bookability_profiles' AS target_object,
         property_id::text AS row_id,
         concat_ws(
           ' ',
           public_id,
           canonical_slug,
           canonical_url,
           booking_base_url,
           custom_domain_url,
           timezone,
           default_locale,
           array_to_string(supported_locales, ' '),
           default_currency,
           array_to_string(supported_currencies, ' '),
           public_identity::text,
           location::text,
           media::text,
           amenities::text,
           policies::text,
           capabilities::text,
           supported_quote_parameters::text,
           public_setup_completeness::text,
           source_freshness::text,
           array_to_string(data_sources, ' ')
         ) AS public_document
       FROM distribution.public_hotel_bookability_profiles
       UNION ALL
       SELECT
         'distribution.public_room_offer_snapshots',
         id::text,
         concat_ws(
           ' ',
           public_offer_key,
           availability_status,
           currency,
           occupancy::text,
           room_summary::text,
           rate_summary::text,
           array_to_string(payment_options, ' '),
           public_policy::text,
           array_to_string(unavailable_reasons, ' '),
           source_freshness::text,
           array_to_string(data_sources, ' ')
         )
       FROM distribution.public_room_offer_snapshots
       UNION ALL
       SELECT
         'distribution.public_quote_read_models',
         quote_session_id::text,
         concat_ws(
           ' ',
           public_quote_reference,
           quote_hash,
           request_snapshot::text,
           unavailable_reasons::text,
           offers::text,
           totals::text,
           deep_link_url,
           currency,
           source_freshness::text,
           array_to_string(data_sources, ' ')
         )
       FROM distribution.public_quote_read_models
       UNION ALL
       SELECT
         'distribution.booking_deep_link_contexts',
         id::text,
         concat_ws(
           ' ',
           public_quote_reference,
           deep_link_url,
           status,
           locale,
           currency,
           check_in::text,
           check_out::text,
           promo_code,
           referral_code,
           array_to_string(preserves, ' '),
           request_context::text,
           source_freshness::text
         )
       FROM distribution.booking_deep_link_contexts
       UNION ALL
       SELECT
         'distribution.external_api_clients',
         id::text,
         concat_ws(
           ' ',
           public_client_id,
           client_name,
           status,
           array_to_string(allowed_surfaces, ' '),
           rate_limit_tier,
           terms_version,
           client_metadata::text
         )
       FROM distribution.external_api_clients
       UNION ALL
       SELECT
         'distribution.external_api_usage_events',
         id::text,
         concat_ws(
           ' ',
           surface,
           request_method,
           route_template,
           response_status::text,
           rate_limit_policy,
           rate_limit_tier,
           cache_status,
           client_visible_error_code,
           array_to_string(abuse_flags, ' '),
           usage_metadata::text
         )
       FROM distribution.external_api_usage_events
     ) AS public_outputs`,
  );

  for (const row of result.rows) {
    const matchedValue = forbiddenValues.find((value) => row.public_document.includes(value));
    if (!matchedValue) continue;

    addDistributionFinding(
      findings,
      "DISTRIBUTION_PUBLIC_OUTPUT_PRIVATE_VALUE_LEAK",
      row.target_object,
      `Distribution public output ${row.row_id} contains forbidden private value ${matchedValue}`,
      "No guest PII, private checkout input, provider IDs, credential refs, PMS room numbers, or private operational values in public-safe bookability output",
      matchedValue,
      "Filter private prerequisite fields before projecting distribution public bookability rows.",
    );
  }
}

async function checkDistributionBookabilityFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.distributionBookabilityChecks;
  if (!checks) return;

  for (const check of checks.properties) {
    await checkOwnershipAndResourceLinks(client, check, findings);
    await checkBookabilityProfile(client, check, findings);
    await checkRoomOfferSnapshots(client, check, findings);
    await checkQuoteAndDeepLink(client, check, findings);
    await checkExternalApiClientAndUsage(client, check, findings);
  }

  await checkDistributionJsonPrivateKeyBoundary(client, findings);
  await checkForbiddenPublicOutputValues(client, expected, findings);
}

export async function checkDistributionBookabilityParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkDistributionBookabilityFixtures(client, expected, findings);
}
