import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type IntelligenceChecks = NonNullable<ExpectedTarget["intelligenceChecks"]>;
type IntelligencePropertyCheck = IntelligenceChecks["properties"][number];

function addIntelligenceFinding(
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
    owner: "Ask Intelligence",
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

async function checkOwnershipAndPermissionBoundary(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const ownership = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_memberships membership
       JOIN identity.organization_resource_links booking_link
         ON booking_link.organization_id = membership.organization_id
        AND booking_link.product = 'booking'
        AND booking_link.resource_type = 'booking_hotel'
        AND booking_link.resource_id = $4
        AND booking_link.relationship = 'owner'
        AND booking_link.status = 'active'
       JOIN identity.organization_resource_links pms_link
         ON pms_link.organization_id = membership.organization_id
        AND pms_link.product = 'pms'
        AND pms_link.resource_type = 'pms_hotel'
        AND pms_link.resource_id = $5
        AND pms_link.relationship = 'operator'
        AND pms_link.status = 'active'
       JOIN identity.organization_resource_links marketplace_link
         ON marketplace_link.organization_id = membership.organization_id
        AND marketplace_link.product = 'marketplace'
        AND marketplace_link.resource_type = 'hotel_profile'
        AND marketplace_link.resource_id = $6
        AND marketplace_link.relationship = 'owner'
        AND marketplace_link.status = 'active'
       JOIN identity.product_entitlements booking_entitlement
         ON booking_entitlement.organization_id = membership.organization_id
        AND booking_entitlement.product = 'booking'
        AND booking_entitlement.entitlement_key = 'booking-engine'
        AND booking_entitlement.status = 'active'
        AND booking_entitlement.resource_product = 'booking'
        AND booking_entitlement.resource_type = 'booking_hotel'
        AND booking_entitlement.resource_id = $4
       JOIN identity.product_entitlements pms_entitlement
         ON pms_entitlement.organization_id = membership.organization_id
        AND pms_entitlement.product = 'pms'
        AND pms_entitlement.entitlement_key = 'pms-core'
        AND pms_entitlement.status = 'active'
        AND pms_entitlement.resource_product = 'pms'
        AND pms_entitlement.resource_type = 'pms_hotel'
        AND pms_entitlement.resource_id = $5
       JOIN hotel_catalog.property_source_links booking_source
         ON booking_source.property_id = $1
        AND booking_source.source_system = 'booking'
        AND booking_source.source_table = 'booking_hotels'
        AND booking_source.source_id = $4
        AND booking_source.relationship = 'canonical_input'
        AND booking_source.status = 'active'
       JOIN hotel_catalog.property_source_links pms_source
         ON pms_source.property_id = $1
        AND pms_source.source_system = 'pms'
        AND pms_source.source_table = 'hotels'
        AND pms_source.source_id = $5
        AND pms_source.relationship = 'operational_input'
        AND pms_source.status = 'active'
       JOIN hotel_catalog.property_source_links marketplace_source
         ON marketplace_source.property_id = $1
        AND marketplace_source.source_system = 'marketplace'
        AND marketplace_source.source_table = 'hotel_profiles'
        AND marketplace_source.source_id = $6
        AND marketplace_source.relationship = 'profile_input'
        AND marketplace_source.status = 'active'
       JOIN identity.role_permission_grants ask_grant
         ON ask_grant.organization_kind = 'hotel_group'
        AND ask_grant.role_key = membership.role_key
        AND ask_grant.permission_key = $7
       JOIN identity.role_permission_grants booking_grant
         ON booking_grant.organization_kind = 'hotel_group'
        AND booking_grant.role_key = membership.role_key
        AND booking_grant.permission_key = 'booking.analytics.read'
       JOIN identity.role_permission_grants setup_grant
         ON setup_grant.organization_kind = 'hotel_group'
        AND setup_grant.role_key = membership.role_key
        AND setup_grant.permission_key = 'booking.settings.read'
       WHERE membership.organization_id = $2
         AND membership.user_id = $3
         AND membership.status = 'active'
         AND membership.role_key = 'hotel_owner'
     ) AS exists`,
    [
      check.propertyId,
      check.organizationId,
      check.ownerUserId,
      check.bookingHotelResourceId,
      check.pmsHotelResourceId,
      check.marketplaceProfileResourceId,
      check.requiredAskPermissionKey,
    ],
  );

  if (!ownership.rows[0].exists) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_OWNERSHIP_LINK_MISMATCH",
      "identity.organization_resource_links",
      `Expected intelligence property ${check.propertyId} to be linked to one authorized hotel-owner organization`,
      "Active hotel-owner membership, booking/PMS/marketplace resource links, booking/PMS entitlements, property source links, and allowed Ask/booking/setup role grants",
      "relationship not found",
      "Check intelligence fixture prerequisite identity and hotel catalog rows before accepting Ask Intelligence evidence.",
    );
  }

  const financeGrant = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.role_permission_grants
       WHERE organization_kind = 'hotel_group'
         AND role_key = 'hotel_owner'
         AND permission_key = 'finance.summary.read'
     ) AS exists`,
  );

  if (financeGrant.rows[0].exists) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_FINANCE_PERMISSION_BOUNDARY_MISMATCH",
      "identity.role_permission_grants",
      "Expected finance summary permission to be absent for the denied Ask run",
      "No hotel_owner role grant for finance.summary.read in this fixture",
      "finance.summary.read grant exists",
      "Keep the finance run/tool-call path not_authorized unless the fixture expectations are updated.",
    );
  }
}

async function checkMetricSnapshots(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const metricResult = await client.query<{
    id: string;
    metric_key: string;
    product: string;
    metric_category: string;
    unit: string;
    default_resource_scope: string;
    required_permission_key: string;
    visibility: string;
    pii_policy: string;
    active: boolean;
  }>(
    `SELECT
       id::text,
       metric_key,
       product,
       metric_category,
       unit,
       default_resource_scope,
       required_permission_key,
       visibility,
       pii_policy,
       active
     FROM intelligence.metric_definitions
     WHERE id IN ($1, $2, $3)`,
    [
      check.bookingMetricDefinitionId,
      check.setupMetricDefinitionId,
      check.financeMetricDefinitionId,
    ],
  );

  const metricsById = new Map(metricResult.rows.map((row) => [row.id, row]));
  const bookingMetric = metricsById.get(check.bookingMetricDefinitionId);
  const setupMetric = metricsById.get(check.setupMetricDefinitionId);
  const financeMetric = metricsById.get(check.financeMetricDefinitionId);

  const metricsMatch =
    bookingMetric?.metric_key === "booking.direct_booking_share" &&
    bookingMetric.product === "booking" &&
    bookingMetric.metric_category === "performance" &&
    bookingMetric.unit === "percentage" &&
    bookingMetric.default_resource_scope === "property" &&
    bookingMetric.required_permission_key === "booking.analytics.read" &&
    bookingMetric.visibility === "owner" &&
    bookingMetric.pii_policy === "aggregate_only" &&
    bookingMetric.active === true &&
    setupMetric?.metric_key === "hotel_catalog.setup_completeness_score" &&
    setupMetric.product === "hotel_catalog" &&
    setupMetric.metric_category === "setup" &&
    setupMetric.unit === "score" &&
    setupMetric.required_permission_key === "booking.settings.read" &&
    setupMetric.visibility === "owner" &&
    setupMetric.pii_policy === "none" &&
    setupMetric.active === true &&
    financeMetric?.metric_key === "finance.net_revenue" &&
    financeMetric.product === "finance" &&
    financeMetric.metric_category === "finance" &&
    financeMetric.unit === "currency" &&
    financeMetric.required_permission_key === "finance.summary.read" &&
    financeMetric.visibility === "finance_restricted" &&
    financeMetric.pii_policy === "finance_restricted" &&
    financeMetric.active === true;

  if (!metricsMatch) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_METRIC_DEFINITION_MISMATCH",
      "intelligence.metric_definitions",
      "Expected booking, setup, and finance metric definitions were not found",
      "Active property-scoped metrics with correct products, categories, units, permissions, visibility, and PII policies",
      JSON.stringify({
        bookingMetric: bookingMetric ?? null,
        setupMetric: setupMetric ?? null,
        financeMetric: financeMetric ?? null,
      }),
      "Check intelligence metric definition fixture rows and finance visibility constraints.",
    );
  }

  const snapshotResult = await client.query<{
    id: string;
    metric_definition_id: string;
    metric_key: string;
    snapshot_key: string;
    run_status: string;
    resource_scope: string;
    organization_id: string | null;
    property_id: string | null;
    scope_key: string;
    source_owner: string;
    source_view: string;
    required_permission_key: string;
    freshness_status: string;
    quality: string;
    sample_size: number | null;
    aggregate_id: string | null;
    direct_share_pct: string | null;
    net_revenue_amount: string | null;
    source_fresh: boolean;
  }>(
    `SELECT
       id::text,
       metric_definition_id::text,
       metric_key,
       snapshot_key,
       run_status,
       resource_scope,
       organization_id::text,
       property_id::text,
       scope_key,
       source_owner,
       source_view,
       required_permission_key,
       freshness_status,
       quality,
       sample_size,
       aggregate_id,
       value_summary ->> 'directSharePct' AS direct_share_pct,
       value_summary ->> 'netRevenueAmount' AS net_revenue_amount,
       source_fresh_at IS NOT NULL AS source_fresh
     FROM intelligence.metric_snapshot_runs
     WHERE id IN ($1, $2)`,
    [check.bookingSnapshotRunId, check.financeSnapshotRunId],
  );

  const snapshotsById = new Map(snapshotResult.rows.map((row) => [row.id, row]));
  const bookingSnapshot = snapshotsById.get(check.bookingSnapshotRunId);
  const financeSnapshot = snapshotsById.get(check.financeSnapshotRunId);

  const commonSnapshotMatches = (row: (typeof snapshotResult.rows)[number] | undefined) =>
    row &&
    row.run_status === "succeeded" &&
    row.resource_scope === "property" &&
    row.organization_id === check.organizationId &&
    row.property_id === check.propertyId &&
    row.scope_key === check.scopeKey &&
    row.freshness_status === "fresh" &&
    row.quality === "complete" &&
    row.source_fresh === true;

  const snapshotsMatch =
    commonSnapshotMatches(bookingSnapshot) &&
    bookingSnapshot?.metric_definition_id === check.bookingMetricDefinitionId &&
    bookingSnapshot.metric_key === "booking.direct_booking_share" &&
    bookingSnapshot.snapshot_key === check.bookingSnapshotKey &&
    bookingSnapshot.source_owner === "booking" &&
    bookingSnapshot.source_view === "direct_booking_summary_read_model" &&
    bookingSnapshot.required_permission_key === "booking.analytics.read" &&
    bookingSnapshot.sample_size === 48 &&
    bookingSnapshot.aggregate_id === "booking-direct-share-f696-june" &&
    bookingSnapshot.direct_share_pct === "62.5" &&
    commonSnapshotMatches(financeSnapshot) &&
    financeSnapshot?.metric_definition_id === check.financeMetricDefinitionId &&
    financeSnapshot.metric_key === "finance.net_revenue" &&
    financeSnapshot.snapshot_key === check.financeSnapshotKey &&
    financeSnapshot.source_owner === "finance" &&
    financeSnapshot.source_view === "finance_visibility_read_model" &&
    financeSnapshot.required_permission_key === "finance.summary.read" &&
    financeSnapshot.sample_size === 12 &&
    financeSnapshot.aggregate_id === "finance-net-revenue-f696-june" &&
    financeSnapshot.net_revenue_amount === "17250";

  if (!snapshotsMatch) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_METRIC_SNAPSHOT_LINK_MISMATCH",
      "intelligence.metric_snapshot_runs",
      `Expected metric snapshots for property ${check.propertyId} were not found`,
      "Booking and finance snapshots linked to their metric definitions, stable keys, property scope, source views, permissions, freshness, and aggregate summaries",
      JSON.stringify({
        bookingSnapshot: bookingSnapshot ?? null,
        financeSnapshot: financeSnapshot ?? null,
      }),
      "Check metric snapshot fixture rows for metric FK/key preservation and property-scoped freshness metadata.",
    );
  }
}

async function checkSetupSnapshots(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    id: string;
    snapshot_key: string;
    organization_id: string;
    property_id: string;
    scope_key: string;
    setup_area: string;
    completion_status: string;
    completeness_score: string;
    required_permission_key: string;
    freshness_status: string;
    missing_count: number;
    blocking_count: number;
    source_fresh: boolean;
  }>(
    `SELECT
       id::text,
       snapshot_key,
       organization_id::text,
       property_id::text,
       scope_key,
       setup_area,
       completion_status,
       completeness_score::text,
       required_permission_key,
       freshness_status,
       jsonb_array_length(missing_items) AS missing_count,
       jsonb_array_length(blocking_items) AS blocking_count,
       source_fresh_at IS NOT NULL AS source_fresh
     FROM intelligence.setup_completeness_snapshots
     WHERE id IN ($1, $2)`,
    [check.setupOverallSnapshotId, check.setupPaymentSnapshotId],
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const overall = byId.get(check.setupOverallSnapshotId);
  const payment = byId.get(check.setupPaymentSnapshotId);

  const sharedMatches = (row: (typeof result.rows)[number] | undefined) =>
    row &&
    row.organization_id === check.organizationId &&
    row.property_id === check.propertyId &&
    row.scope_key === check.scopeKey &&
    row.required_permission_key === "booking.settings.read" &&
    row.freshness_status === "fresh" &&
    row.source_fresh === true;

  const matches =
    sharedMatches(overall) &&
    overall?.snapshot_key === check.setupOverallSnapshotKey &&
    overall.setup_area === "overall" &&
    overall.completion_status === "complete" &&
    overall.completeness_score === "100.00" &&
    overall.missing_count === 0 &&
    overall.blocking_count === 0 &&
    sharedMatches(payment) &&
    payment?.snapshot_key === check.setupPaymentSnapshotKey &&
    payment.setup_area === "payment" &&
    payment.completion_status === "incomplete" &&
    payment.completeness_score === "70.00" &&
    payment.missing_count === 1 &&
    payment.blocking_count === 1;

  if (!matches) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_SETUP_SNAPSHOT_MISMATCH",
      "intelligence.setup_completeness_snapshots",
      `Expected setup completeness snapshots for property ${check.propertyId} were not found`,
      "One complete overall snapshot and one incomplete payment snapshot linked to the same property scope and settings permission",
      JSON.stringify({ overall: overall ?? null, payment: payment ?? null }),
      "Check setup completeness fixture rows for stable snapshot keys, property scope, scores, and missing/blocking item boundaries.",
    );
  }
}

async function checkEvidenceCatalog(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    id: string;
    tool_id: string;
    tool_version: string;
    product: string;
    source_owner: string;
    source_view: string;
    primary_metric_definition_id: string | null;
    read_only: boolean;
    required_resource_scope: string;
    primary_required_permission_key: string;
    required_permission_keys: string[];
    pii_policy: string;
    status: string;
  }>(
    `SELECT
       id::text,
       tool_id,
       tool_version,
       product,
       source_owner,
       source_view,
       primary_metric_definition_id::text,
       read_only,
       required_resource_scope,
       primary_required_permission_key,
       required_permission_keys,
       pii_policy,
       status
     FROM intelligence.ai_evidence_catalog
     WHERE id IN ($1, $2, $3)`,
    [
      check.bookingEvidenceCatalogId,
      check.setupEvidenceCatalogId,
      check.financeEvidenceCatalogId,
    ],
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const booking = byId.get(check.bookingEvidenceCatalogId);
  const setup = byId.get(check.setupEvidenceCatalogId);
  const finance = byId.get(check.financeEvidenceCatalogId);

  const activeReadOnlyPropertyTool = (row: (typeof result.rows)[number] | undefined) =>
    row &&
    row.tool_version === "v1" &&
    row.read_only === true &&
    row.required_resource_scope === "property" &&
    row.status === "active" &&
    includesAll(row.required_permission_keys, [
      row.primary_required_permission_key,
      check.requiredAskPermissionKey,
    ]);

  const matches =
    activeReadOnlyPropertyTool(booking) &&
    booking?.tool_id === check.bookingToolId &&
    booking.product === "booking" &&
    booking.source_owner === "booking" &&
    booking.source_view === "direct_booking_summary_read_model" &&
    booking.primary_metric_definition_id === check.bookingMetricDefinitionId &&
    booking.primary_required_permission_key === "booking.analytics.read" &&
    booking.pii_policy === "aggregate_only" &&
    activeReadOnlyPropertyTool(setup) &&
    setup?.tool_id === check.setupToolId &&
    setup.product === "hotel_catalog" &&
    setup.source_owner === "hotel_catalog" &&
    setup.source_view === "property_setup_status" &&
    setup.primary_metric_definition_id === check.setupMetricDefinitionId &&
    setup.primary_required_permission_key === "booking.settings.read" &&
    setup.pii_policy === "none" &&
    activeReadOnlyPropertyTool(finance) &&
    finance?.tool_id === check.financeToolId &&
    finance.product === "finance" &&
    finance.source_owner === "finance" &&
    finance.source_view === "finance_visibility_read_model" &&
    finance.primary_metric_definition_id === check.financeMetricDefinitionId &&
    finance.primary_required_permission_key === "finance.summary.read" &&
    finance.pii_policy === "finance_restricted";

  if (!matches) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_EVIDENCE_CATALOG_MISMATCH",
      "intelligence.ai_evidence_catalog",
      "Expected Ask Intelligence evidence catalog entries were not found",
      "Three active read-only property tools linked to approved source views, primary metrics, required permissions, and PII policies",
      JSON.stringify({
        booking: booking ?? null,
        setup: setup ?? null,
        finance: finance ?? null,
      }),
      "Check evidence catalog fixture rows for tool IDs, permissions, metric links, read-only state, and source-view constraints.",
    );
  }
}

async function checkConversationRuns(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const conversation = await client.query<{
    id: string;
    conversation_key: string;
    actor_user_id: string;
    organization_id: string | null;
    property_id: string | null;
    resource_scope: string;
    scope_key: string;
    conversation_state: string;
    privacy_scope: string;
  }>(
    `SELECT
       id::text,
       conversation_key,
       actor_user_id::text,
       organization_id::text,
       property_id::text,
       resource_scope,
       scope_key,
       conversation_state,
       privacy_scope
     FROM intelligence.ask_conversations
     WHERE id = $1`,
    [check.conversationId],
  );

  const conversationRow = conversation.rows[0];
  const conversationMatches =
    conversationRow?.conversation_key === check.conversationKey &&
    conversationRow.actor_user_id === check.ownerUserId &&
    conversationRow.organization_id === check.organizationId &&
    conversationRow.property_id === check.propertyId &&
    conversationRow.resource_scope === "property" &&
    conversationRow.scope_key === check.scopeKey &&
    conversationRow.conversation_state === "active" &&
    conversationRow.privacy_scope === "confidential";

  if (!conversationMatches) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_CONVERSATION_SCOPE_MISMATCH",
      "intelligence.ask_conversations",
      `Expected Ask conversation ${check.conversationId} was not found`,
      "Active confidential conversation linked to the owner, organization, property, and generated property scope key",
      conversationRow ? JSON.stringify(conversationRow) : "row missing",
      "Check Ask conversation fixture row for actor/resource scope and retention/privacy boundaries.",
    );
  }

  const runs = await client.query<{
    id: string;
    run_key: string;
    conversation_id: string;
    actor_user_id: string;
    organization_id: string | null;
    property_id: string | null;
    resource_scope: string;
    scope_key: string;
    question_hash: string;
    required_permission_key: string;
    run_status: string;
    confidence_level: string;
    prompt_version: string;
    schema_version: string;
    tool_plan_count: number;
    unavailable_count: number;
    finished: boolean;
  }>(
    `SELECT
       id::text,
       run_key,
       conversation_id::text,
       actor_user_id::text,
       organization_id::text,
       property_id::text,
       resource_scope,
       scope_key,
       question_hash,
       required_permission_key,
       run_status,
       confidence_level,
       prompt_version,
       schema_version,
       jsonb_array_length(tool_plan) AS tool_plan_count,
       jsonb_array_length(unavailable_data) AS unavailable_count,
       finished_at IS NOT NULL AS finished
     FROM intelligence.ask_runs
     WHERE id IN ($1, $2)`,
    [check.answeredRunId, check.deniedRunId],
  );

  const byId = new Map(runs.rows.map((row) => [row.id, row]));
  const answered = byId.get(check.answeredRunId);
  const denied = byId.get(check.deniedRunId);

  const sharedRunMatches = (row: (typeof runs.rows)[number] | undefined) =>
    row &&
    row.conversation_id === check.conversationId &&
    row.actor_user_id === check.ownerUserId &&
    row.organization_id === check.organizationId &&
    row.property_id === check.propertyId &&
    row.resource_scope === "property" &&
    row.scope_key === check.scopeKey &&
    row.required_permission_key === check.requiredAskPermissionKey &&
    row.prompt_version === "ask-owner.v1" &&
    row.schema_version === "ask-answer.v1" &&
    row.finished === true;

  const runsMatch =
    sharedRunMatches(answered) &&
    answered?.run_key === check.answeredRunKey &&
    answered.question_hash === "sha256:intelligence-f696-direct-share" &&
    answered.run_status === "answered" &&
    answered.confidence_level === "high" &&
    answered.tool_plan_count === 2 &&
    answered.unavailable_count === 0 &&
    sharedRunMatches(denied) &&
    denied?.run_key === check.deniedRunKey &&
    denied.question_hash === "sha256:intelligence-f696-finance-denied" &&
    denied.run_status === "not_authorized" &&
    denied.confidence_level === "low" &&
    denied.tool_plan_count === 1 &&
    denied.unavailable_count === 1;

  if (!runsMatch) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_RUN_SCOPE_MISMATCH",
      "intelligence.ask_runs",
      "Expected answered and not_authorized Ask runs were not found",
      "Runs linked to the same conversation/actor/property scope, with terminal timestamps, stable keys, redacted question hashes, and correct answered/denied state",
      JSON.stringify({ answered: answered ?? null, denied: denied ?? null }),
      "Check Ask run fixture rows for conversation scope, terminal status, required Ask permission, and unavailable-data handling.",
    );
  }
}

async function checkToolCallsAndAudits(
  client: pg.Client,
  check: IntelligencePropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const toolCalls = await client.query<{
    id: string;
    run_id: string;
    tool_id: string;
    call_sequence: number;
    scope_key: string;
    required_permission_key: string;
    authorization_status: string;
    result_status: string;
    evidence_count: number;
    unavailable_count: number;
    evidence_document: string;
    finished: boolean;
  }>(
    `SELECT
       id::text,
       run_id::text,
       tool_id,
       call_sequence,
       scope_key,
       required_permission_key,
       authorization_status,
       result_status,
       jsonb_array_length(evidence_references) AS evidence_count,
       jsonb_array_length(unavailable_data) AS unavailable_count,
       evidence_references::text AS evidence_document,
       finished_at IS NOT NULL AS finished
     FROM intelligence.ask_tool_calls
     WHERE id IN ($1, $2, $3)`,
    [check.bookingToolCallId, check.setupToolCallId, check.deniedFinanceToolCallId],
  );

  const callsById = new Map(toolCalls.rows.map((row) => [row.id, row]));
  const bookingCall = callsById.get(check.bookingToolCallId);
  const setupCall = callsById.get(check.setupToolCallId);
  const financeCall = callsById.get(check.deniedFinanceToolCallId);

  const toolCallsMatch =
    bookingCall?.run_id === check.answeredRunId &&
    bookingCall.tool_id === check.bookingToolId &&
    bookingCall.call_sequence === 1 &&
    bookingCall.scope_key === check.scopeKey &&
    bookingCall.required_permission_key === "booking.analytics.read" &&
    bookingCall.authorization_status === "allowed" &&
    bookingCall.result_status === "available" &&
    bookingCall.evidence_count === 1 &&
    bookingCall.unavailable_count === 0 &&
    bookingCall.evidence_document.includes(check.bookingSnapshotRunId) &&
    bookingCall.finished === true &&
    setupCall?.run_id === check.answeredRunId &&
    setupCall.tool_id === check.setupToolId &&
    setupCall.call_sequence === 2 &&
    setupCall.scope_key === check.scopeKey &&
    setupCall.required_permission_key === "booking.settings.read" &&
    setupCall.authorization_status === "allowed" &&
    setupCall.result_status === "available" &&
    setupCall.evidence_count === 2 &&
    setupCall.unavailable_count === 0 &&
    setupCall.evidence_document.includes(check.setupOverallSnapshotId) &&
    setupCall.evidence_document.includes(check.setupPaymentSnapshotId) &&
    setupCall.finished === true &&
    financeCall?.run_id === check.deniedRunId &&
    financeCall.tool_id === check.financeToolId &&
    financeCall.call_sequence === 1 &&
    financeCall.scope_key === check.scopeKey &&
    financeCall.required_permission_key === "finance.summary.read" &&
    financeCall.authorization_status === "denied" &&
    financeCall.result_status === "not_authorized" &&
    financeCall.evidence_count === 0 &&
    financeCall.unavailable_count === 1 &&
    financeCall.finished === true;

  if (!toolCallsMatch) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_TOOL_CALL_LINK_MISMATCH",
      "intelligence.ask_tool_calls",
      "Expected Ask tool-call traces were not found",
      "Two allowed available calls linked to booking/setup evidence plus one denied finance call with no evidence leakage",
      JSON.stringify({
        bookingCall: bookingCall ?? null,
        setupCall: setupCall ?? null,
        financeCall: financeCall ?? null,
      }),
      "Check Ask tool-call fixture rows for run sequence, tool catalog permission FKs, evidence references, authorization status, and scope keys.",
    );
  }

  const audits = await client.query<{
    id: string;
    answer_id: string;
    run_id: string;
    conversation_id: string;
    scope_key: string;
    answer_status: string;
    confidence_level: string;
    question_hash: string;
    audit_revision: number;
    evidence_count: number;
    material_claim_count: number;
    suggested_action_count: number;
    unavailable_count: number;
    evidence_document: string;
    review_status: string;
    retention_class: string;
    privacy_scope: string;
  }>(
    `SELECT
       id::text,
       answer_id,
       run_id::text,
       conversation_id::text,
       scope_key,
       answer_status,
       confidence_level,
       question_hash,
       audit_revision,
       jsonb_array_length(evidence_references) AS evidence_count,
       jsonb_array_length(material_claims) AS material_claim_count,
       jsonb_array_length(suggested_actions) AS suggested_action_count,
       jsonb_array_length(unavailable_data) AS unavailable_count,
       evidence_references::text AS evidence_document,
       review_status,
       retention_class,
       privacy_scope
     FROM intelligence.ask_answer_audits
     WHERE id IN ($1, $2)`,
    [check.answeredAuditId, check.deniedAuditId],
  );

  const auditsById = new Map(audits.rows.map((row) => [row.id, row]));
  const answeredAudit = auditsById.get(check.answeredAuditId);
  const deniedAudit = auditsById.get(check.deniedAuditId);

  const sharedAuditMatches = (row: (typeof audits.rows)[number] | undefined) =>
    row &&
    row.conversation_id === check.conversationId &&
    row.scope_key === check.scopeKey &&
    row.audit_revision === 1 &&
    row.review_status === "not_reviewed" &&
    row.privacy_scope === "confidential";

  const auditsMatch =
    sharedAuditMatches(answeredAudit) &&
    answeredAudit?.answer_id === check.answeredAnswerId &&
    answeredAudit.run_id === check.answeredRunId &&
    answeredAudit.answer_status === "answered" &&
    answeredAudit.confidence_level === "high" &&
    answeredAudit.question_hash === "sha256:intelligence-f696-direct-share" &&
    answeredAudit.evidence_count === 2 &&
    answeredAudit.evidence_document.includes(check.bookingSnapshotRunId) &&
    answeredAudit.evidence_document.includes(check.setupPaymentSnapshotId) &&
    answeredAudit.material_claim_count === 2 &&
    answeredAudit.suggested_action_count === 1 &&
    answeredAudit.unavailable_count === 0 &&
    answeredAudit.retention_class === "guest_pii_excluded" &&
    sharedAuditMatches(deniedAudit) &&
    deniedAudit?.answer_id === check.deniedAnswerId &&
    deniedAudit.run_id === check.deniedRunId &&
    deniedAudit.answer_status === "not_authorized" &&
    deniedAudit.confidence_level === "low" &&
    deniedAudit.question_hash === "sha256:intelligence-f696-finance-denied" &&
    deniedAudit.evidence_count === 0 &&
    deniedAudit.material_claim_count === 0 &&
    deniedAudit.suggested_action_count === 0 &&
    deniedAudit.unavailable_count === 1 &&
    deniedAudit.retention_class === "standard";

  if (!auditsMatch) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_ANSWER_AUDIT_LINK_MISMATCH",
      "intelligence.ask_answer_audits",
      "Expected Ask answer audits were not found",
      "Answered audit linked to evidence/material claims and denied audit with unavailable data but no evidence references",
      JSON.stringify({
        answeredAudit: answeredAudit ?? null,
        deniedAudit: deniedAudit ?? null,
      }),
      "Check Ask answer audit fixture rows for run/conversation scope, evidence references, review state, retention, and denied-output boundary.",
    );
  }
}

async function checkPrivateJsonBoundary(
  client: pg.Client,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ target_object: string; row_id: string }>(
    `SELECT target_object, row_id
     FROM (
       SELECT
         'intelligence.metric_definitions' AS target_object,
         id::text AS row_id,
         (
           intelligence.text_has_forbidden_evidence_value(display_name)
           OR intelligence.text_has_forbidden_evidence_value(description)
           OR intelligence.jsonb_has_forbidden_evidence_key(allowed_filters)
           OR intelligence.jsonb_has_forbidden_evidence_key(definition_metadata)
         ) AS has_private_boundary
       FROM intelligence.metric_definitions
       UNION ALL
       SELECT
         'intelligence.metric_snapshot_runs',
         id::text,
         (
           intelligence.jsonb_has_forbidden_evidence_key(value_summary)
           OR intelligence.jsonb_has_forbidden_evidence_key(filters)
           OR intelligence.jsonb_has_forbidden_evidence_key(source_freshness)
           OR intelligence.jsonb_has_forbidden_evidence_key(snapshot_metadata)
         )
       FROM intelligence.metric_snapshot_runs
       UNION ALL
       SELECT
         'intelligence.setup_completeness_snapshots',
         id::text,
         (
           intelligence.jsonb_has_forbidden_evidence_key(missing_items)
           OR intelligence.jsonb_has_forbidden_evidence_key(blocking_items)
           OR intelligence.jsonb_has_forbidden_evidence_key(stale_items)
           OR intelligence.jsonb_has_forbidden_evidence_key(source_freshness)
           OR intelligence.jsonb_has_forbidden_evidence_key(setup_metadata)
         )
       FROM intelligence.setup_completeness_snapshots
       UNION ALL
       SELECT
         'intelligence.ai_evidence_catalog',
         id::text,
         (
           intelligence.jsonb_has_forbidden_evidence_key(allowed_filters)
           OR intelligence.jsonb_has_forbidden_evidence_key(evidence_contract)
         )
       FROM intelligence.ai_evidence_catalog
       UNION ALL
       SELECT
         'intelligence.ask_conversations',
         id::text,
         (
           intelligence.text_has_forbidden_evidence_value(title)
           OR intelligence.jsonb_has_forbidden_evidence_key(conversation_metadata)
         )
       FROM intelligence.ask_conversations
       UNION ALL
       SELECT
         'intelligence.ask_runs',
         id::text,
         (
           intelligence.text_has_forbidden_evidence_value(question_redacted_text)
           OR intelligence.jsonb_has_forbidden_evidence_key(tool_plan)
           OR intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
           OR intelligence.jsonb_has_forbidden_evidence_key(caveats)
           OR intelligence.jsonb_has_forbidden_evidence_key(token_usage)
           OR intelligence.jsonb_has_forbidden_evidence_key(cost_metadata)
         )
       FROM intelligence.ask_runs
       UNION ALL
       SELECT
         'intelligence.ask_tool_calls',
         id::text,
         (
           intelligence.jsonb_has_forbidden_evidence_key(input_scope)
           OR intelligence.jsonb_has_forbidden_evidence_key(filters)
           OR intelligence.jsonb_has_forbidden_evidence_key(evidence_references)
           OR intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
           OR intelligence.jsonb_has_forbidden_evidence_key(result_summary)
         )
       FROM intelligence.ask_tool_calls
       UNION ALL
       SELECT
         'intelligence.ask_answer_audits',
         id::text,
         (
           intelligence.text_has_forbidden_evidence_value(summary)
           OR intelligence.jsonb_has_forbidden_evidence_key(generated_answer)
           OR intelligence.jsonb_has_forbidden_evidence_key(evidence_references)
           OR intelligence.jsonb_has_forbidden_evidence_key(material_claims)
           OR intelligence.jsonb_has_forbidden_evidence_key(suggested_actions)
           OR intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
           OR intelligence.jsonb_has_forbidden_evidence_key(caveats)
           OR intelligence.jsonb_has_forbidden_evidence_key(audit_metadata)
         )
       FROM intelligence.ask_answer_audits
     ) AS boundary_rows
     WHERE has_private_boundary`,
  );

  for (const row of result.rows) {
    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_PRIVATE_BOUNDARY_VALUE",
      row.target_object,
      `Intelligence row ${row.row_id} contains a forbidden private key or value`,
      "No guest PII, private prompts, provider identifiers, raw request bodies, or SQL fragments in intelligence evidence/answer JSON or redacted question text",
      row.row_id,
      "Filter private values before inserting intelligence evidence, prompt, tool-call, run, or answer-audit rows.",
    );
  }
}

async function checkExpectedForbiddenValues(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenValues = expected.intelligenceChecks?.forbiddenPrivateBoundaryValues ?? [];
  if (forbiddenValues.length === 0) return;

  const result = await client.query<{
    target_object: string;
    row_id: string;
    boundary_surface: string;
  }>(
    `SELECT target_object, row_id, boundary_surface
     FROM (
       SELECT
         'intelligence.metric_definitions' AS target_object,
         id::text AS row_id,
         concat_ws(' ', metric_key, display_name, description, allowed_filters::text, definition_metadata::text) AS boundary_surface
       FROM intelligence.metric_definitions
       UNION ALL
       SELECT
         'intelligence.metric_snapshot_runs',
         id::text,
         concat_ws(' ', metric_key, snapshot_key, aggregate_id, value_summary::text, filters::text, source_freshness::text, snapshot_metadata::text)
       FROM intelligence.metric_snapshot_runs
       UNION ALL
       SELECT
         'intelligence.setup_completeness_snapshots',
         id::text,
         concat_ws(' ', snapshot_key, missing_items::text, blocking_items::text, stale_items::text, source_freshness::text, setup_metadata::text)
       FROM intelligence.setup_completeness_snapshots
       UNION ALL
       SELECT
         'intelligence.ai_evidence_catalog',
         id::text,
         concat_ws(' ', tool_id, display_name, allowed_filters::text, evidence_contract::text)
       FROM intelligence.ai_evidence_catalog
       UNION ALL
       SELECT
         'intelligence.ask_conversations',
         id::text,
         concat_ws(' ', conversation_key, title, conversation_metadata::text)
       FROM intelligence.ask_conversations
       UNION ALL
       SELECT
         'intelligence.ask_runs',
         id::text,
         concat_ws(' ', run_key, request_id, correlation_id, question_redacted_text, question_hash, prompt_version, schema_version, tool_plan::text, unavailable_data::text, caveats::text, token_usage::text, cost_metadata::text)
       FROM intelligence.ask_runs
       UNION ALL
       SELECT
         'intelligence.ask_tool_calls',
         id::text,
         concat_ws(' ', tool_id, input_scope::text, filters::text, evidence_references::text, unavailable_data::text, result_summary::text, error_code, error_summary)
       FROM intelligence.ask_tool_calls
       UNION ALL
       SELECT
         'intelligence.ask_answer_audits',
         id::text,
         concat_ws(' ', answer_id, question_hash, summary, generated_answer::text, evidence_references::text, material_claims::text, suggested_actions::text, unavailable_data::text, caveats::text, audit_metadata::text)
       FROM intelligence.ask_answer_audits
     ) AS intelligence_surfaces`,
  );

  for (const row of result.rows) {
    const matchedValue = forbiddenValues.find((value) => row.boundary_surface.includes(value));
    if (!matchedValue) continue;

    addIntelligenceFinding(
      findings,
      "INTELLIGENCE_EXPECTED_FORBIDDEN_VALUE_LEAK",
      row.target_object,
      `Intelligence row ${row.row_id} contains forbidden private fixture value ${matchedValue}`,
      "Expected private fixture values must not appear in intelligence evidence, prompt, tool-call, run, or answer-audit output surfaces",
      matchedValue,
      "Keep raw private data in source/owned domain tables and store only redacted aggregate evidence references in intelligence rows.",
    );
  }
}

async function checkIntelligenceFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.intelligenceChecks;
  if (!checks) return;

  for (const check of checks.properties) {
    await checkOwnershipAndPermissionBoundary(client, check, findings);
    await checkMetricSnapshots(client, check, findings);
    await checkSetupSnapshots(client, check, findings);
    await checkEvidenceCatalog(client, check, findings);
    await checkConversationRuns(client, check, findings);
    await checkToolCallsAndAudits(client, check, findings);
  }

  await checkPrivateJsonBoundary(client, findings);
  await checkExpectedForbiddenValues(client, expected, findings);
}

export async function checkIntelligenceParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkIntelligenceFixtures(client, expected, findings);
}
