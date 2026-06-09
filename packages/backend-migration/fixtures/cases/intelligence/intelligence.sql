-- Fixture: intelligence / intelligence.sql
-- Source: migration_source_intelligence schema.
--
-- Represents source-side Ask Intelligence inputs for one property-scoped owner
-- conversation slice. The rebuild command loads these migration-only source
-- rows, then packages/backend-migration transforms them into identity,
-- hotel_catalog, and intelligence target rows.

DROP SCHEMA IF EXISTS migration_source_intelligence CASCADE;
CREATE SCHEMA migration_source_intelligence;

CREATE TABLE migration_source_intelligence.owner_accounts (
  owner_user_id UUID PRIMARY KEY,
  owner_email TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_status TEXT NOT NULL
);

CREATE TABLE migration_source_intelligence.owner_organizations (
  org_id UUID PRIMARY KEY,
  org_kind TEXT NOT NULL,
  org_name TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  org_status TEXT NOT NULL,
  workos_org_id TEXT,
  workos_external_id TEXT
);

CREATE TABLE migration_source_intelligence.owner_memberships (
  membership_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  membership_status TEXT NOT NULL,
  role_key TEXT NOT NULL,
  workos_membership_id TEXT,
  workos_role_slugs TEXT[] NOT NULL
);

CREATE TABLE migration_source_intelligence.role_permission_inputs (
  org_kind TEXT NOT NULL,
  role_key TEXT NOT NULL,
  permission_key TEXT NOT NULL
);

CREATE TABLE migration_source_intelligence.organization_resource_inputs (
  link_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  product TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  link_status TEXT NOT NULL
);

CREATE TABLE migration_source_intelligence.product_entitlement_inputs (
  entitlement_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  product TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  entitlement_status TEXT NOT NULL,
  resource_product TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  source_metadata JSONB NOT NULL
);

CREATE TABLE migration_source_intelligence.property_profile_inputs (
  property_id UUID PRIMARY KEY,
  property_public_id TEXT NOT NULL,
  property_display_name TEXT NOT NULL,
  property_type TEXT,
  property_category TEXT,
  default_locale TEXT NOT NULL,
  supported_locales TEXT[] NOT NULL,
  profile_status TEXT NOT NULL,
  completeness_reasons TEXT[] NOT NULL
);

CREATE TABLE migration_source_intelligence.property_source_inputs (
  source_link_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  source_metadata JSONB NOT NULL
);

CREATE TABLE migration_source_intelligence.metric_catalog_inputs (
  metric_id UUID PRIMARY KEY,
  metric_key TEXT NOT NULL,
  label TEXT NOT NULL,
  metric_description TEXT NOT NULL,
  product TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  visibility TEXT NOT NULL,
  freshness_slo_seconds INTEGER NOT NULL,
  pii_policy TEXT NOT NULL,
  allowed_filters JSONB NOT NULL,
  metadata JSONB NOT NULL,
  active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.metric_snapshot_inputs (
  snapshot_run_id UUID PRIMARY KEY,
  metric_id UUID NOT NULL,
  metric_key TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  status TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  source_owner TEXT NOT NULL,
  source_view TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  period TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  source_fresh_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  freshness_status TEXT NOT NULL,
  quality TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  aggregate_id TEXT NOT NULL,
  value_summary JSONB NOT NULL,
  filters JSONB NOT NULL,
  source_freshness JSONB NOT NULL,
  unavailable_reasons TEXT[] NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.setup_snapshot_inputs (
  setup_snapshot_id UUID PRIMARY KEY,
  snapshot_key TEXT NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  setup_area TEXT NOT NULL,
  status TEXT NOT NULL,
  completeness_score NUMERIC NOT NULL,
  permission_key TEXT NOT NULL,
  source_snapshot_at TIMESTAMPTZ NOT NULL,
  source_fresh_at TIMESTAMPTZ NOT NULL,
  freshness_status TEXT NOT NULL,
  missing_items JSONB NOT NULL,
  blocking_items JSONB NOT NULL,
  stale_items JSONB NOT NULL,
  source_freshness JSONB NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.evidence_tool_inputs (
  evidence_tool_id UUID PRIMARY KEY,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  label TEXT NOT NULL,
  product TEXT NOT NULL,
  source_owner TEXT NOT NULL,
  source_view TEXT NOT NULL,
  metric_id UUID NOT NULL,
  read_only BOOLEAN NOT NULL,
  resource_scope TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  permission_keys TEXT[] NOT NULL,
  supported_intents TEXT[] NOT NULL,
  allowed_filters JSONB NOT NULL,
  freshness_slo_seconds INTEGER NOT NULL,
  pii_policy TEXT NOT NULL,
  unavailable_reasons TEXT[] NOT NULL,
  contract JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.ask_conversation_inputs (
  conversation_id UUID PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  resource_scope TEXT NOT NULL,
  state TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL,
  privacy_scope TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.ask_run_inputs (
  run_id UUID PRIMARY KEY,
  run_key TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  resource_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  intent TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  tool_plan JSONB NOT NULL,
  unavailable_data JSONB NOT NULL,
  caveats JSONB NOT NULL,
  token_usage JSONB NOT NULL,
  cost_metadata JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.ask_tool_call_inputs (
  tool_call_id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  call_sequence INTEGER NOT NULL,
  resource_scope TEXT NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  permission_key TEXT NOT NULL,
  authorization_status TEXT NOT NULL,
  result_status TEXT NOT NULL,
  input_scope JSONB NOT NULL,
  filters JSONB NOT NULL,
  evidence_references JSONB NOT NULL,
  unavailable_data JSONB NOT NULL,
  result_summary JSONB NOT NULL,
  latency_ms INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_intelligence.ask_answer_inputs (
  audit_id UUID PRIMARY KEY,
  answer_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  org_id UUID NOT NULL,
  property_id UUID NOT NULL,
  resource_scope TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  answer_status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  audit_revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  generated_answer JSONB NOT NULL,
  evidence_references JSONB NOT NULL,
  material_claims JSONB NOT NULL,
  suggested_actions JSONB NOT NULL,
  unavailable_data JSONB NOT NULL,
  caveats JSONB NOT NULL,
  review_status TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  privacy_scope TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO migration_source_intelligence.owner_accounts
  (owner_user_id, owner_email, owner_name, owner_status)
VALUES
  ('f6961000-0000-0000-0000-000000000001', 'owner.intelligence@example.test', 'Intelligence Hotel Owner', 'active');

INSERT INTO migration_source_intelligence.owner_organizations
  (org_id, org_kind, org_name, org_slug, org_status, workos_org_id, workos_external_id)
VALUES
  ('f6962000-0000-0000-0000-000000000001', 'hotel_group', 'Intelligence Alpenrose Group', 'intelligence-alpenrose-group', 'active', 'org_intelligence_alpenrose', 'intelligence-alpenrose-group');

INSERT INTO migration_source_intelligence.owner_memberships
  (membership_id, org_id, owner_user_id, membership_status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('f6962100-0000-0000-0000-000000000001', 'f6962000-0000-0000-0000-000000000001', 'f6961000-0000-0000-0000-000000000001', 'active', 'hotel_owner', 'membership_intelligence_owner', ARRAY['hotel_owner']);

INSERT INTO migration_source_intelligence.role_permission_inputs
  (org_kind, role_key, permission_key)
VALUES
  ('hotel_group', 'hotel_owner', 'intelligence.ask.read'),
  ('hotel_group', 'hotel_owner', 'booking.analytics.read'),
  ('hotel_group', 'hotel_owner', 'booking.settings.read'),
  ('hotel_group', 'hotel_owner', 'pms.analytics.read'),
  ('hotel_group', 'hotel_owner', 'marketplace.collaboration.read');

INSERT INTO migration_source_intelligence.organization_resource_inputs
  (link_id, org_id, product, resource_type, source_resource_id, relationship, link_status)
VALUES
  ('f6962200-0000-0000-0000-000000000001', 'f6962000-0000-0000-0000-000000000001', 'booking', 'booking_hotel', 'booking_hotel_intelligence_alpenrose', 'owner', 'active'),
  ('f6962200-0000-0000-0000-000000000002', 'f6962000-0000-0000-0000-000000000001', 'pms', 'pms_hotel', 'pms_hotel_intelligence_alpenrose', 'operator', 'active'),
  ('f6962200-0000-0000-0000-000000000003', 'f6962000-0000-0000-0000-000000000001', 'marketplace', 'hotel_profile', 'marketplace_hotel_profile_intelligence_alpenrose', 'owner', 'active');

INSERT INTO migration_source_intelligence.product_entitlement_inputs
  (entitlement_id, org_id, product, entitlement_key, entitlement_status, resource_product, resource_type, source_resource_id, starts_at, source_metadata)
VALUES
  ('f6962300-0000-0000-0000-000000000001', 'f6962000-0000-0000-0000-000000000001', 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', 'booking_hotel_intelligence_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "intelligence"}'),
  ('f6962300-0000-0000-0000-000000000002', 'f6962000-0000-0000-0000-000000000001', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_intelligence_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "intelligence"}'),
  ('f6962300-0000-0000-0000-000000000003', 'f6962000-0000-0000-0000-000000000001', 'marketplace', 'marketplace-hotel-profile', 'active', 'marketplace', 'hotel_profile', 'marketplace_hotel_profile_intelligence_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "intelligence"}');

INSERT INTO migration_source_intelligence.property_profile_inputs
  (property_id, property_public_id, property_display_name, property_type, property_category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('f6963000-0000-0000-0000-000000000001', 'prop_intelligence_alpenrose', 'Intelligence Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO migration_source_intelligence.property_source_inputs
  (source_link_id, property_id, source_system, source_table, source_id, relationship, source_metadata)
VALUES
  ('f6963100-0000-0000-0000-000000000001', 'f6963000-0000-0000-0000-000000000001', 'booking', 'booking_hotels', 'booking_hotel_intelligence_alpenrose', 'canonical_input', '{"fixture": "intelligence"}'),
  ('f6963100-0000-0000-0000-000000000002', 'f6963000-0000-0000-0000-000000000001', 'pms', 'hotels', 'pms_hotel_intelligence_alpenrose', 'operational_input', '{"fixture": "intelligence"}'),
  ('f6963100-0000-0000-0000-000000000003', 'f6963000-0000-0000-0000-000000000001', 'marketplace', 'hotel_profiles', 'marketplace_hotel_profile_intelligence_alpenrose', 'profile_input', '{"fixture": "intelligence"}');

INSERT INTO migration_source_intelligence.metric_catalog_inputs
  (
    metric_id,
    metric_key,
    label,
    metric_description,
    product,
    category,
    unit,
    resource_scope,
    permission_key,
    visibility,
    freshness_slo_seconds,
    pii_policy,
    allowed_filters,
    metadata,
    active,
    created_at,
    updated_at
  )
VALUES
  (
    'f6964000-0000-0000-0000-000000000001',
    'booking.direct_booking_share',
    'Direct booking share',
    'Share of bookings captured through direct booking channels.',
    'booking',
    'performance',
    'percentage',
    'property',
    'booking.analytics.read',
    'owner',
    86400,
    'aggregate_only',
    '{"dateRange": {"allowed": ["last_7_days", "last_30_days"]}, "channels": ["direct", "partner"]}',
    '{"contractVersion": "metric-definition.v1", "ownerFacing": true}',
    TRUE,
    '2026-06-09T08:00:00Z',
    '2026-06-09T08:00:00Z'
  ),
  (
    'f6964000-0000-0000-0000-000000000002',
    'hotel_catalog.setup_completeness_score',
    'Setup completeness score',
    'Owner-facing setup readiness score for Ask Intelligence.',
    'hotel_catalog',
    'setup',
    'score',
    'property',
    'booking.settings.read',
    'owner',
    43200,
    'none',
    '{"setupAreas": ["profile", "payment", "agent_readiness"]}',
    '{"contractVersion": "metric-definition.v1", "scoreBand": "0_to_100"}',
    TRUE,
    '2026-06-09T08:00:00Z',
    '2026-06-09T08:00:00Z'
  ),
  (
    'f6964000-0000-0000-0000-000000000003',
    'finance.net_revenue',
    'Net revenue',
    'Permissioned finance summary for owner-facing revenue questions.',
    'finance',
    'finance',
    'currency',
    'property',
    'finance.summary.read',
    'finance_restricted',
    86400,
    'finance_restricted',
    '{"dateRange": {"allowed": ["last_7_days", "last_30_days"]}, "currency": ["EUR"]}',
    '{"contractVersion": "metric-definition.v1", "restricted": true}',
    TRUE,
    '2026-06-09T08:00:00Z',
    '2026-06-09T08:00:00Z'
  );

INSERT INTO migration_source_intelligence.metric_snapshot_inputs
  (
    snapshot_run_id,
    metric_id,
    metric_key,
    snapshot_key,
    status,
    resource_scope,
    org_id,
    property_id,
    source_owner,
    source_view,
    permission_key,
    period,
    period_start,
    period_end,
    generated_at,
    source_fresh_at,
    expires_at,
    freshness_status,
    quality,
    sample_size,
    aggregate_id,
    value_summary,
    filters,
    source_freshness,
    unavailable_reasons,
    metadata,
    created_at
  )
VALUES
  (
    'f6964100-0000-0000-0000-000000000001',
    'f6964000-0000-0000-0000-000000000001',
    'booking.direct_booking_share',
    'intelligence.booking_direct_share.f696.2026_06',
    'succeeded',
    'property',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'booking',
    'direct_booking_summary_read_model',
    'booking.analytics.read',
    'month',
    '2026-06-01',
    '2026-06-30',
    '2026-06-09T08:30:00Z',
    '2026-06-09T08:25:00Z',
    '2026-06-10T08:30:00Z',
    'fresh',
    'complete',
    48,
    'booking-direct-share-f696-june',
    '{"directSharePct": 62.5, "directBookings": 30, "partnerBookings": 18, "currency": "EUR"}',
    '{"dateRange": "2026-06", "channels": ["direct", "partner"]}',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:25:00Z"}}',
    ARRAY[]::TEXT[],
    '{"fixture": "intelligence", "readModelVersion": "booking-summary.v1"}',
    '2026-06-09T08:30:00Z'
  ),
  (
    'f6964100-0000-0000-0000-000000000002',
    'f6964000-0000-0000-0000-000000000003',
    'finance.net_revenue',
    'intelligence.finance_net_revenue.f696.2026_06',
    'succeeded',
    'property',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'finance',
    'finance_visibility_read_model',
    'finance.summary.read',
    'month',
    '2026-06-01',
    '2026-06-30',
    '2026-06-09T08:35:00Z',
    '2026-06-09T08:20:00Z',
    '2026-06-10T08:35:00Z',
    'fresh',
    'complete',
    12,
    'finance-net-revenue-f696-june',
    '{"grossRevenueAmount": 18400, "netRevenueAmount": 17250, "currency": "EUR", "paymentCount": 12}',
    '{"dateRange": "2026-06", "currency": "EUR"}',
    '{"finance": {"status": "fresh", "generatedAt": "2026-06-09T08:20:00Z"}}',
    ARRAY[]::TEXT[],
    '{"fixture": "intelligence", "readModelVersion": "finance-visibility.v1"}',
    '2026-06-09T08:35:00Z'
  );

INSERT INTO migration_source_intelligence.setup_snapshot_inputs
  (
    setup_snapshot_id,
    snapshot_key,
    org_id,
    property_id,
    setup_area,
    status,
    completeness_score,
    permission_key,
    source_snapshot_at,
    source_fresh_at,
    freshness_status,
    missing_items,
    blocking_items,
    stale_items,
    source_freshness,
    metadata,
    created_at
  )
VALUES
  (
    'f6964200-0000-0000-0000-000000000001',
    'intelligence.setup_overall.f696.2026_06_09',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'overall',
    'complete',
    100.00,
    'booking.settings.read',
    '2026-06-09T08:40:00Z',
    '2026-06-09T08:38:00Z',
    'fresh',
    '[]',
    '[]',
    '[]',
    '{"hotel_catalog": {"status": "fresh", "generatedAt": "2026-06-09T08:38:00Z"}}',
    '{"fixture": "intelligence", "agentReady": true}',
    '2026-06-09T08:40:00Z'
  ),
  (
    'f6964200-0000-0000-0000-000000000002',
    'intelligence.setup_payment.f696.2026_06_09',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'payment',
    'incomplete',
    70.00,
    'booking.settings.read',
    '2026-06-09T08:40:00Z',
    '2026-06-09T08:38:00Z',
    'fresh',
    '[{"itemKey": "deposit_policy", "label": "Deposit policy needs confirmation"}]',
    '[{"itemKey": "online_payment", "label": "Online payment activation is pending"}]',
    '[]',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:38:00Z"}}',
    '{"fixture": "intelligence", "agentReady": false}',
    '2026-06-09T08:40:00Z'
  );

INSERT INTO migration_source_intelligence.evidence_tool_inputs
  (
    evidence_tool_id,
    tool_id,
    tool_version,
    label,
    product,
    source_owner,
    source_view,
    metric_id,
    read_only,
    resource_scope,
    permission_key,
    permission_keys,
    supported_intents,
    allowed_filters,
    freshness_slo_seconds,
    pii_policy,
    unavailable_reasons,
    contract,
    status,
    created_at,
    updated_at
  )
VALUES
  (
    'f6964300-0000-0000-0000-000000000001',
    'get_booking_performance',
    'v1',
    'Get booking performance',
    'booking',
    'booking',
    'direct_booking_summary_read_model',
    'f6964000-0000-0000-0000-000000000001',
    TRUE,
    'property',
    'booking.analytics.read',
    ARRAY['booking.analytics.read', 'intelligence.ask.read'],
    ARRAY['performance', 'funnel'],
    '{"dateRange": true, "channelBreakdown": true}',
    86400,
    'aggregate_only',
    ARRAY['missing_scope', 'not_linked_resource', 'missing_permission', 'source_unavailable', 'stale_source', 'empty_result'],
    '{"contractVersion": "evidence-tool.v1", "returns": ["directSharePct", "sampleSize", "freshnessStatus"]}',
    'active',
    '2026-06-09T08:45:00Z',
    '2026-06-09T08:45:00Z'
  ),
  (
    'f6964300-0000-0000-0000-000000000002',
    'get_setup_gaps',
    'v1',
    'Get setup gaps',
    'hotel_catalog',
    'hotel_catalog',
    'property_setup_status',
    'f6964000-0000-0000-0000-000000000002',
    TRUE,
    'property',
    'booking.settings.read',
    ARRAY['booking.settings.read', 'intelligence.ask.read'],
    ARRAY['setup', 'agent_readiness'],
    '{"setupArea": true, "includeBlockingItems": true}',
    43200,
    'none',
    ARRAY['missing_scope', 'not_linked_resource', 'missing_permission', 'source_unavailable', 'stale_source', 'empty_result'],
    '{"contractVersion": "evidence-tool.v1", "returns": ["completionStatus", "completenessScore", "blockingItems"]}',
    'active',
    '2026-06-09T08:45:00Z',
    '2026-06-09T08:45:00Z'
  ),
  (
    'f6964300-0000-0000-0000-000000000003',
    'get_finance_summary',
    'v1',
    'Get finance summary',
    'finance',
    'finance',
    'finance_visibility_read_model',
    'f6964000-0000-0000-0000-000000000003',
    TRUE,
    'property',
    'finance.summary.read',
    ARRAY['finance.summary.read', 'intelligence.ask.read'],
    ARRAY['finance', 'revenue'],
    '{"dateRange": true, "currency": true}',
    86400,
    'finance_restricted',
    ARRAY['missing_scope', 'not_linked_resource', 'missing_permission', 'pii_restricted', 'source_unavailable', 'stale_source', 'empty_result'],
    '{"contractVersion": "evidence-tool.v1", "returns": ["grossRevenueAmount", "netRevenueAmount", "currency"]}',
    'active',
    '2026-06-09T08:45:00Z',
    '2026-06-09T08:45:00Z'
  );

INSERT INTO migration_source_intelligence.ask_conversation_inputs
  (
    conversation_id,
    conversation_key,
    actor_user_id,
    org_id,
    property_id,
    resource_scope,
    state,
    locale,
    title,
    retention_policy,
    last_message_at,
    privacy_scope,
    metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6965000-0000-0000-0000-000000000001',
    'ask-intelligence-f696-direct-booking',
    'f6961000-0000-0000-0000-000000000001',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'property',
    'active',
    'en',
    'Direct booking performance',
    'standard',
    '2026-06-09T09:15:00Z',
    'confidential',
    '{"fixture": "intelligence", "scopeReason": "hotel_owner_selected_property"}',
    '2026-06-09T09:00:00Z',
    '2026-06-09T09:15:00Z'
  );

INSERT INTO migration_source_intelligence.ask_run_inputs
  (
    run_id,
    run_key,
    conversation_id,
    actor_user_id,
    org_id,
    property_id,
    resource_scope,
    request_id,
    correlation_id,
    question_text,
    question_hash,
    intent,
    permission_key,
    status,
    confidence,
    model_provider,
    model_name,
    prompt_version,
    schema_version,
    tool_plan,
    unavailable_data,
    caveats,
    token_usage,
    cost_metadata,
    started_at,
    finished_at,
    latency_ms,
    created_at
  )
VALUES
  (
    'f6965100-0000-0000-0000-000000000001',
    'ask-run-f696-direct-share',
    'f6965000-0000-0000-0000-000000000001',
    'f6961000-0000-0000-0000-000000000001',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'property',
    'req_intelligence_f696_001',
    'corr_intelligence_f696_001',
    'Why did direct bookings change this month?',
    'sha256:intelligence-f696-direct-share',
    'performance',
    'intelligence.ask.read',
    'answered',
    'high',
    'openai',
    'gpt-5-mini',
    'ask-owner.v1',
    'ask-answer.v1',
    '[{"toolId": "get_booking_performance", "purpose": "measure_direct_share"}, {"toolId": "get_setup_gaps", "purpose": "check_agent_readiness"}]',
    '[]',
    '[{"code": "internal_data_only", "message": "Answer uses current Vayada evidence only."}]',
    '{"inputTokens": 920, "outputTokens": 260}',
    '{"estimatedCost": "0.012", "currency": "USD"}',
    '2026-06-09T09:05:00Z',
    '2026-06-09T09:05:04Z',
    4100,
    '2026-06-09T09:05:00Z'
  ),
  (
    'f6965100-0000-0000-0000-000000000002',
    'ask-run-f696-finance-denied',
    'f6965000-0000-0000-0000-000000000001',
    'f6961000-0000-0000-0000-000000000001',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'property',
    'req_intelligence_f696_002',
    'corr_intelligence_f696_002',
    'Can I view restricted finance identifiers?',
    'sha256:intelligence-f696-finance-denied',
    'finance',
    'intelligence.ask.read',
    'not_authorized',
    'low',
    'openai',
    'gpt-5-mini',
    'ask-owner.v1',
    'ask-answer.v1',
    '[{"toolId": "get_finance_summary", "purpose": "check_permission_before_revenue_summary"}]',
    '[{"toolId": "get_finance_summary", "reason": "missing_permission", "requiredPermissionKey": "finance.summary.read"}]',
    '[{"code": "restricted_finance", "message": "Finance evidence requires an additional permission."}]',
    '{"inputTokens": 310, "outputTokens": 90}',
    '{"estimatedCost": "0.004", "currency": "USD"}',
    '2026-06-09T09:10:00Z',
    '2026-06-09T09:10:01Z',
    900,
    '2026-06-09T09:10:00Z'
  );

INSERT INTO migration_source_intelligence.ask_tool_call_inputs
  (
    tool_call_id,
    run_id,
    tool_id,
    tool_version,
    call_sequence,
    resource_scope,
    org_id,
    property_id,
    permission_key,
    authorization_status,
    result_status,
    input_scope,
    filters,
    evidence_references,
    unavailable_data,
    result_summary,
    latency_ms,
    started_at,
    finished_at,
    created_at
  )
VALUES
  (
    'f6965200-0000-0000-0000-000000000001',
    'f6965100-0000-0000-0000-000000000001',
    'get_booking_performance',
    'v1',
    1,
    'property',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'booking.analytics.read',
    'allowed',
    'available',
    '{"scopeKey": "property:f6962000-0000-0000-0000-000000000001:f6963000-0000-0000-0000-000000000001", "propertyId": "f6963000-0000-0000-0000-000000000001"}',
    '{"dateRange": "2026-06"}',
    '[{"kind": "metric_snapshot", "id": "f6964100-0000-0000-0000-000000000001", "metricKey": "booking.direct_booking_share"}]',
    '[]',
    '{"directSharePct": 62.5, "sampleSize": 48, "freshnessStatus": "fresh"}',
    820,
    '2026-06-09T09:05:00Z',
    '2026-06-09T09:05:01Z',
    '2026-06-09T09:05:00Z'
  ),
  (
    'f6965200-0000-0000-0000-000000000002',
    'f6965100-0000-0000-0000-000000000001',
    'get_setup_gaps',
    'v1',
    2,
    'property',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'booking.settings.read',
    'allowed',
    'available',
    '{"scopeKey": "property:f6962000-0000-0000-0000-000000000001:f6963000-0000-0000-0000-000000000001", "propertyId": "f6963000-0000-0000-0000-000000000001"}',
    '{"setupAreas": ["overall", "payment"]}',
    '[{"kind": "setup_snapshot", "id": "f6964200-0000-0000-0000-000000000001", "setupArea": "overall"}, {"kind": "setup_snapshot", "id": "f6964200-0000-0000-0000-000000000002", "setupArea": "payment"}]',
    '[]',
    '{"overallScore": 100, "paymentScore": 70, "blockingItemCount": 1}',
    760,
    '2026-06-09T09:05:01Z',
    '2026-06-09T09:05:02Z',
    '2026-06-09T09:05:01Z'
  ),
  (
    'f6965200-0000-0000-0000-000000000003',
    'f6965100-0000-0000-0000-000000000002',
    'get_finance_summary',
    'v1',
    1,
    'property',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'finance.summary.read',
    'denied',
    'not_authorized',
    '{"scopeKey": "property:f6962000-0000-0000-0000-000000000001:f6963000-0000-0000-0000-000000000001", "propertyId": "f6963000-0000-0000-0000-000000000001"}',
    '{"dateRange": "2026-06"}',
    '[]',
    '[{"reason": "missing_permission", "requiredPermissionKey": "finance.summary.read"}]',
    '{"authorizationStatus": "denied"}',
    420,
    '2026-06-09T09:10:00Z',
    '2026-06-09T09:10:01Z',
    '2026-06-09T09:10:00Z'
  );

INSERT INTO migration_source_intelligence.ask_answer_inputs
  (
    audit_id,
    answer_id,
    run_id,
    conversation_id,
    org_id,
    property_id,
    resource_scope,
    contract_version,
    answer_status,
    confidence,
    question_hash,
    audit_revision,
    summary,
    generated_answer,
    evidence_references,
    material_claims,
    suggested_actions,
    unavailable_data,
    caveats,
    review_status,
    retention_class,
    privacy_scope,
    metadata,
    created_at
  )
VALUES
  (
    'f6965300-0000-0000-0000-000000000001',
    'answer-f696-direct-share',
    'f6965100-0000-0000-0000-000000000001',
    'f6965000-0000-0000-0000-000000000001',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'property',
    'ask-answer.v1',
    'answered',
    'high',
    'sha256:intelligence-f696-direct-share',
    1,
    'Direct booking share is healthy, but payment readiness has one blocking setup item.',
    '{"status": "answered", "headline": "Direct share is healthy", "sections": [{"kind": "metric", "text": "Direct bookings represented 62.5 percent of captured bookings."}, {"kind": "setup", "text": "Payment readiness still has one blocking item."}]}',
    '[{"kind": "metric_snapshot", "id": "f6964100-0000-0000-0000-000000000001"}, {"kind": "setup_snapshot", "id": "f6964200-0000-0000-0000-000000000002"}]',
    '[{"claim": "Direct booking share is 62.5 percent for June.", "evidenceId": "f6964100-0000-0000-0000-000000000001"}, {"claim": "Payment readiness has one blocking item.", "evidenceId": "f6964200-0000-0000-0000-000000000002"}]',
    '[{"actionKey": "confirm_deposit_policy", "label": "Confirm deposit policy", "destructive": false}]',
    '[]',
    '[{"code": "internal_data_only", "message": "No external enrichment was used."}]',
    'not_reviewed',
    'guest_pii_excluded',
    'confidential',
    '{"fixture": "intelligence", "answerEnvelopeVersion": "ask-answer.v1"}',
    '2026-06-09T09:05:04Z'
  ),
  (
    'f6965300-0000-0000-0000-000000000002',
    'answer-f696-finance-denied',
    'f6965100-0000-0000-0000-000000000002',
    'f6965000-0000-0000-0000-000000000001',
    'f6962000-0000-0000-0000-000000000001',
    'f6963000-0000-0000-0000-000000000001',
    'property',
    'ask-answer.v1',
    'not_authorized',
    'low',
    'sha256:intelligence-f696-finance-denied',
    1,
    'Finance evidence was not returned because the selected role lacks the required permission.',
    '{"status": "not_authorized", "headline": "Finance evidence unavailable", "sections": [{"kind": "permission", "text": "This answer requires finance summary permission."}]}',
    '[]',
    '[]',
    '[]',
    '[{"toolId": "get_finance_summary", "reason": "missing_permission", "requiredPermissionKey": "finance.summary.read"}]',
    '[{"code": "restricted_finance", "message": "Finance evidence was not exposed."}]',
    'not_reviewed',
    'standard',
    'confidential',
    '{"fixture": "intelligence", "deniedToolId": "get_finance_summary"}',
    '2026-06-09T09:10:01Z'
  );
