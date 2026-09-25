import type pg from "pg";

export const AFFILIATE_CAPTURE_ROLE = "vayada_next_affiliate_capture";

/** Applies the shared account, DDL, direct-write and delegation boundary. */
async function assertAffiliateCaptureRoleBoundary(
  client: Pick<pg.Client, "query">,
  role: string,
  allowedUpdateRelations: readonly string[],
): Promise<void> {
  const fail = (reason: string): never => {
    throw new Error(`affiliate_capture_role_${reason}`);
  };
  const account = (
    await client.query(
      `SELECT oid, rolcanlogin AND NOT (
         rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication
       ) AS safe
       FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows[0];
  if (!account?.safe) fail("unsafe");
  const privileged = await client.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=$1 OR roleid=$1
     UNION ALL SELECT 1 FROM pg_catalog.pg_shdepend
       WHERE refclassid='pg_catalog.pg_authid'::pg_catalog.regclass
         AND refobjid=$1 AND deptype='o'`,
    [account.oid],
  );
  if (privileged.rowCount) fail("membership_or_owner");
  const ddl = await client.query(
    `SELECT 1 WHERE pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CREATE')
                OR pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'TEMP')
     UNION ALL SELECT 1 FROM pg_catalog.pg_namespace
       WHERE pg_catalog.left(nspname,3)<>'pg_'
         AND pg_catalog.has_schema_privilege($1,oid,'CREATE')
     UNION ALL SELECT 1 FROM pg_catalog.pg_class
       WHERE relkind='S' AND (
         pg_catalog.has_sequence_privilege($1,oid,'USAGE') OR
         pg_catalog.has_sequence_privilege($1,oid,'SELECT') OR
         pg_catalog.has_sequence_privilege($1,oid,'UPDATE')
       )
     UNION ALL SELECT 1 WHERE pg_catalog.has_parameter_privilege(
       $1,'session_replication_role','SET'
     )`,
    [role],
  );
  if (ddl.rowCount) fail("ddl_or_sequence");
  const version = Number(
    (await client.query("SHOW server_version_num")).rows[0]?.server_version_num,
  );
  const writes = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    ...(version >= 170000 ? ["MAINTAIN"] : []),
  ];
  const direct = await client.query(
    `SELECT 1 FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN pg_catalog.unnest($2::pg_catalog.text[]) privilege
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND NOT (privilege='UPDATE' AND relation.oid=ANY($3::pg_catalog.regclass[]))
       AND pg_catalog.has_table_privilege($1,relation.oid,privilege)
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN pg_catalog.unnest(ARRAY['INSERT','UPDATE','REFERENCES']) privilege
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND NOT (privilege='UPDATE' AND relation.oid=ANY($3::pg_catalog.regclass[]))
       AND pg_catalog.has_column_privilege($1,relation.oid,attribute.attname,privilege)
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND pg_catalog.has_table_privilege($1,relation.oid,'SELECT WITH GRANT OPTION')
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         $1,relation.oid,attribute.attname,'SELECT WITH GRANT OPTION'
       )
     UNION ALL
     SELECT 1 FROM pg_catalog.unnest($3::pg_catalog.regclass[]) relation
     WHERE pg_catalog.has_table_privilege($1,relation,'UPDATE WITH GRANT OPTION')
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid=ANY($3::pg_catalog.regclass[])
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         $1,attribute.attrelid,attribute.attname,'UPDATE WITH GRANT OPTION'
       )`,
    [role, writes, allowedUpdateRelations],
  );
  if (direct.rowCount) fail("direct_grant");
}

/** Deny-only preparation check. Passing does not authorize live capture. */
export async function assertAffiliateCaptureRoleHasNoWriteGrants(
  client: Pick<pg.Client, "query">,
  role = AFFILIATE_CAPTURE_ROLE,
): Promise<void> {
  await assertAffiliateCaptureRoleBoundary(client, role, []);
}

const guardedFunctions = [
  "marketplace.consume_affiliate_click_quota(text)",
  "marketplace.capture_affiliate_click(text,text,text)",
  "booking.admit_affiliate_click(text,uuid,uuid)",
  "booking.bind_live_affiliate_original(uuid,uuid)",
] as const;
const allowedGuardedFunctions = guardedFunctions.slice(0, 3);
const affiliateQuotaFunctionHash =
  "c17877ed6b486ede510e518baa777b1d14ea48879fe177ba0291307f9ae7fee5";

const affiliateCaptureReadRelations = [
  "marketplace.affiliate_links",
  "marketplace.affiliate_agreement_activations",
  "marketplace.affiliate_agreement_lifecycle_events",
  "marketplace.affiliate_published_terms",
  "booking.affiliate_destination_versions",
  "hotel_catalog.properties",
  "hotel_catalog.property_slugs",
  "hotel_catalog.property_domains",
  "distribution.active_public_booking_revision",
  "distribution.public_booking_content_revisions",
  "booking.affiliate_referral_transport_certifications",
  "booking.affiliate_validation_probes",
  "booking.affiliate_validation_probe_revocations",
  "booking.affiliate_referral_production_preflights",
  "booking.affiliate_referral_production_preflight_revocations",
] as const;

// These security-barrier views are intentionally readable by every login and
// return rows only for assigned pricing-prefixed session users.
const publicBaselineReadRelations = [
  "booking.pricing_runtime_effective_property_scopes",
  "booking.pricing_runtime_effective_authority_scopes",
] as const;

const affiliateCaptureLockRelations = [
  "marketplace.affiliate_agreement_activations",
  "marketplace.affiliate_agreement_lifecycle_events",
  "marketplace.affiliate_published_terms",
  "booking.affiliate_destination_versions",
  "hotel_catalog.properties",
  "hotel_catalog.property_slugs",
  "booking.affiliate_referral_transport_certifications",
  "booking.affiliate_validation_probes",
  "booking.affiliate_referral_production_preflights",
] as const;

const immutableLockTriggers = [
  [
    "marketplace.affiliate_agreement_activations",
    "affiliate_agreement_activations_immutable",
    "marketplace.reject_affiliate_offer_draft_mutation()",
  ],
  [
    "marketplace.affiliate_agreement_lifecycle_events",
    "affiliate_agreement_lifecycle_events_immutable",
    "marketplace.reject_affiliate_offer_draft_mutation()",
  ],
  [
    "marketplace.affiliate_published_terms",
    "affiliate_published_terms_immutable",
    "marketplace.reject_affiliate_offer_draft_mutation()",
  ],
  [
    "booking.affiliate_destination_versions",
    "affiliate_destination_immutable",
    "platform.prevent_append_only_mutation()",
  ],
  [
    "booking.affiliate_referral_transport_certifications",
    "affiliate_referral_transport_certification_immutable",
    "platform.prevent_append_only_mutation()",
  ],
  [
    "booking.affiliate_validation_probes",
    "affiliate_validation_probe_immutable",
    "platform.prevent_append_only_mutation()",
  ],
  [
    "booking.affiliate_referral_production_preflights",
    "affiliate_referral_production_preflight_immutable",
    "platform.prevent_append_only_mutation()",
  ],
] as const;

const immutableTriggerFunctions = [
  [
    "marketplace.reject_affiliate_offer_draft_mutation()",
    `BEGIN
       RAISE EXCEPTION 'Affiliate offer drafts are append-only; insert a new revision'
         USING ERRCODE = '23514';
     END;`,
  ],
  [
    "platform.prevent_append_only_mutation()",
    `BEGIN
       RAISE EXCEPTION 'platform append-only table % cannot be %', TG_TABLE_NAME, TG_OP
         USING ERRCODE = '55000';
     END;`,
  ],
] as const;

const hotelLockPolicies = [
  [
    "hotel_catalog.properties",
    "affiliate_capture_destination_lock_only",
    "w",
    false,
    "true",
    "(CURRENT_USER <> 'vayada_next_affiliate_capture'::name)",
  ],
  ["hotel_catalog.properties", "channex_management_worker_compat", "*", true, "true", "NULL"],
  [
    "hotel_catalog.properties",
    "channex_management_worker_lock_only",
    "w",
    false,
    "true",
    "(CURRENT_USER <> 'vayada_next_channex_management_worker'::name)",
  ],
  [
    "hotel_catalog.properties",
    "channex_management_worker_scope",
    "*",
    false,
    "((CURRENT_USER <> 'vayada_next_channex_management_worker'::name) OR platform.channex_management_worker_scope('property'::text, (id)::text))",
    "NULL",
  ],
  ["hotel_catalog.properties", "finance_expense_worker_compat", "*", true, "true", "NULL"],
  [
    "hotel_catalog.properties",
    "finance_expense_worker_lock_only",
    "w",
    false,
    "true",
    "(CURRENT_USER <> 'vayada_next_finance_expense_worker'::name)",
  ],
  [
    "hotel_catalog.properties",
    "finance_expense_worker_scope",
    "*",
    false,
    "((CURRENT_USER <> 'vayada_next_finance_expense_worker'::name) OR platform.finance_expense_worker_scope('property'::text, (id)::text))",
    "NULL",
  ],
  [
    "hotel_catalog.properties",
    "finance_export_worker_scope",
    "*",
    false,
    "((CURRENT_USER <> 'vayada_next_finance_export_worker'::name) OR platform.finance_export_worker_scope('property'::text, (id)::text))",
    "NULL",
  ],
  [
    "hotel_catalog.properties",
    "pricing_runtime_property_lock_only",
    "w",
    false,
    "true",
    "(((SESSION_USER)::text !~ '^vayada_next_pricing_'::text) AND ((CURRENT_USER)::text !~ '^vayada_next_pricing_'::text) AND (NOT (EXISTS ( SELECT 1\n   FROM pg_roles pricing_role\n  WHERE ((pricing_role.rolname ~ '^vayada_next_pricing_'::text) AND pg_has_role(SESSION_USER, pricing_role.oid, 'member'::text))))))",
  ],
  ["hotel_catalog.property_slugs", "affiliate_capture_compat", "*", true, "true", "NULL"],
  [
    "hotel_catalog.property_slugs",
    "affiliate_capture_destination_lock_only",
    "w",
    false,
    "true",
    "(CURRENT_USER <> 'vayada_next_affiliate_capture'::name)",
  ],
] as const;

/** Guarded-write capability only. Direct/read/transitive grants remain separate gates. */
export async function assertAffiliateCaptureRoleHasGuardedWriteCapabilities(
  client: Pick<pg.Client, "query">,
  role = AFFILIATE_CAPTURE_ROLE,
): Promise<void> {
  await assertAffiliateCaptureRoleHasGuardedWriteCapabilitiesInternal(client, role, []);
}

/** Validates guarded commands while allowing only the supplied row-lock relations. */
async function assertAffiliateCaptureRoleHasGuardedWriteCapabilitiesInternal(
  client: Pick<pg.Client, "query">,
  role: string,
  allowedUpdateRelations: readonly string[],
  quotaRequired = false,
): Promise<void> {
  await assertAffiliateCaptureRoleBoundary(client, role, allowedUpdateRelations);
  const fail = (reason: string): never => {
    throw new Error(`affiliate_capture_role_${reason}`);
  };
  const schemas = await client.query(
    `SELECT pg_catalog.has_schema_privilege($1,'marketplace','USAGE') AS marketplace,
            pg_catalog.has_schema_privilege($1,'booking','USAGE') AS booking`,
    [role],
  );
  if (!schemas.rows[0]?.marketplace || !schemas.rows[0]?.booking) fail("schema_usage");
  const functions = await client.query(
    `SELECT routine,
            pg_catalog.has_function_privilege($1,routine,'EXECUTE') AS execute,
            pg_catalog.has_function_privilege($1,routine,'EXECUTE WITH GRANT OPTION') AS delegate,
            pg_catalog.has_function_privilege('public',routine,'EXECUTE') AS public_execute
     FROM pg_catalog.unnest($2::pg_catalog.text[]) routine`,
    [role, guardedFunctions],
  );
  const capability = new Map(
    functions.rows.map((row) => [
      row.routine,
      {
        execute: row.execute === true,
        delegate: row.delegate === true,
        public: row.public_execute,
      },
    ]),
  );
  const quota = capability.get(guardedFunctions[0]);
  const capture = capability.get(guardedFunctions[1]);
  const admission = capability.get(guardedFunctions[2]);
  const binding = capability.get(guardedFunctions[3]);
  if ([quota, capture, admission, binding].some((entry) => !entry || entry.public))
    fail("public_execute");
  if (
    (quotaRequired && !quota!.execute) ||
    !capture!.execute ||
    !admission!.execute ||
    binding!.execute
  )
    fail("function_allowlist");
  if ([quota, capture, admission, binding].some((entry) => entry!.delegate))
    fail("function_delegation");
  if (quota!.execute) {
    const quotaBoundary = await client.query(
      `SELECT 1 FROM pg_catalog.pg_proc procedure
       WHERE procedure.oid=$1::pg_catalog.regprocedure
         AND procedure.prosecdef AND procedure.provolatile='v'
         AND procedure.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc,'UTF8')),'hex'
             )=$2
         AND procedure.proowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$3)`,
      [guardedFunctions[0], affiliateQuotaFunctionHash, role],
    );
    if (quotaBoundary.rowCount !== 1) fail("quota_function_boundary");
  }
  const extraSecurityDefiners = await client.query(
    `SELECT 1
     FROM pg_catalog.pg_proc procedure
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
     WHERE procedure.prosecdef
       AND procedure.prokind IN ('f','p','w')
       AND procedure.prorettype NOT IN (
         'pg_catalog.trigger'::pg_catalog.regtype,
         'pg_catalog.event_trigger'::pg_catalog.regtype
       )
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND NOT (procedure.oid = ANY($2::pg_catalog.regprocedure[]))
       AND pg_catalog.has_function_privilege($1,procedure.oid,'EXECUTE')`,
    [role, allowedGuardedFunctions],
  );
  if (extraSecurityDefiners.rowCount) fail("extra_security_definer");
}

/** Known visit-path reads and lock-only updates. Production activation remains a separate gate. */
export async function assertAffiliateCaptureRoleHasVisitReadCapabilities(
  client: Pick<pg.Client, "query">,
  role = AFFILIATE_CAPTURE_ROLE,
  quotaRequired = false,
): Promise<void> {
  if (role !== AFFILIATE_CAPTURE_ROLE) throw new Error("affiliate_capture_role_identity");
  await assertAffiliateCaptureRoleHasGuardedWriteCapabilitiesInternal(
    client,
    role,
    affiliateCaptureLockRelations,
    quotaRequired,
  );
  const fail = (reason: string): never => {
    throw new Error(`affiliate_capture_role_${reason}`);
  };
  if (
    !(
      await client.query(
        `SELECT pg_catalog.has_schema_privilege($1,'hotel_catalog','USAGE')
            AND pg_catalog.has_schema_privilege($1,'distribution','USAGE') AS ok`,
        [role],
      )
    ).rows[0]?.ok
  )
    fail("schema_usage");

  const required = await client.query(
    `SELECT relation,
            pg_catalog.has_table_privilege($1,relation,'SELECT') AS read
     FROM pg_catalog.unnest($2::pg_catalog.text[]) relation`,
    [role, affiliateCaptureReadRelations],
  );
  if (required.rows.some((row) => !row.read)) fail("read_allowlist");
  const extraReads = await client.query(
    `SELECT 1 FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND NOT (relation.oid=ANY($2::pg_catalog.regclass[]))
       AND pg_catalog.has_table_privilege($1,relation.oid,'SELECT')
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
     JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND NOT (relation.oid=ANY($2::pg_catalog.regclass[]))
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege($1,relation.oid,attribute.attname,'SELECT')`,
    [role, [...affiliateCaptureReadRelations, ...publicBaselineReadRelations]],
  );
  if (extraReads.rowCount) fail("read_allowlist");

  const locks = await client.query(
    `SELECT relation,pg_catalog.has_table_privilege($1,relation,'UPDATE') AS locked
     FROM pg_catalog.unnest($2::pg_catalog.text[]) relation`,
    [role, affiliateCaptureLockRelations],
  );
  if (locks.rows.some((row) => !row.locked)) fail("lock_allowlist");

  const triggers = await client.query(
    `SELECT expected.relation,expected.trigger_name
     FROM (
       SELECT ($1::pg_catalog.text[])[position] AS relation,
              ($2::pg_catalog.text[])[position] AS trigger_name,
              ($3::pg_catalog.text[])[position] AS function_name
       FROM pg_catalog.generate_subscripts($1::pg_catalog.text[],1) position
     ) expected
     LEFT JOIN pg_catalog.pg_trigger trigger
      ON trigger.tgrelid=expected.relation::pg_catalog.regclass
      AND trigger.tgname=expected.trigger_name
      AND trigger.tgfoid=expected.function_name::pg_catalog.regprocedure
      AND trigger.tgenabled='A' AND NOT trigger.tgisinternal
      AND trigger.tgtype=27 AND trigger.tgqual IS NULL AND trigger.tgattr::text=''
     WHERE trigger.oid IS NULL`,
    [
      immutableLockTriggers.map(([relation]) => relation),
      immutableLockTriggers.map(([, trigger]) => trigger),
      immutableLockTriggers.map(([, , fn]) => fn),
    ],
  );
  if (triggers.rowCount) fail("lock_protection");

  const triggerFunctions = await client.query(
    `SELECT expected.function_name
     FROM (
       SELECT ($1::pg_catalog.text[])[position] AS function_name,
              ($2::pg_catalog.text[])[position] AS expected_source
       FROM pg_catalog.generate_subscripts($1::pg_catalog.text[],1) position
     ) expected
     LEFT JOIN pg_catalog.pg_proc procedure
       ON procedure.oid=expected.function_name::pg_catalog.regprocedure
      AND procedure.prorettype='pg_catalog.trigger'::pg_catalog.regtype
      AND pg_catalog.regexp_replace(procedure.prosrc,'[[:space:]]+','','g')=
          pg_catalog.regexp_replace(expected.expected_source,'[[:space:]]+','','g')
     WHERE procedure.oid IS NULL`,
    [
      immutableTriggerFunctions.map(([fn]) => fn),
      immutableTriggerFunctions.map(([, source]) => source),
    ],
  );
  if (triggerFunctions.rowCount) fail("lock_protection");

  const rowPolicies = await client.query(
    `WITH expected AS (
       SELECT ($1::pg_catalog.text[])[position] AS relation,
              ($2::pg_catalog.text[])[position] AS policy_name,
              ($3::pg_catalog.text[])[position] AS command,
              ($4::pg_catalog.bool[])[position] AS permissive,
              ($5::pg_catalog.text[])[position] AS using_expression,
              ($6::pg_catalog.text[])[position] AS check_expression
       FROM pg_catalog.generate_subscripts($1::pg_catalog.text[],1) position
     ), actual AS (
       SELECT policy.polrelid::pg_catalog.regclass::pg_catalog.text AS relation,
              policy.polname AS policy_name,policy.polcmd AS command,
              policy.polpermissive AS permissive,policy.polroles AS roles,
              COALESCE(
                pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),'NULL'
              ) AS using_expression,
              COALESCE(
                pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),'NULL'
              ) AS check_expression
       FROM pg_catalog.pg_policy policy
       WHERE policy.polrelid IN (
         'hotel_catalog.properties'::pg_catalog.regclass,
         'hotel_catalog.property_slugs'::pg_catalog.regclass
       ) AND (
         0=ANY(policy.polroles) OR
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$7)=ANY(policy.polroles)
       )
     )
     SELECT 1 FROM expected FULL JOIN actual USING (relation,policy_name)
     WHERE expected.policy_name IS NULL OR actual.policy_name IS NULL
       OR expected.command<>actual.command
       OR expected.permissive<>actual.permissive
       OR actual.roles<>ARRAY[0]::pg_catalog.oid[]
       OR expected.using_expression<>actual.using_expression
       OR expected.check_expression<>actual.check_expression
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_class relation
     WHERE relation.oid IN (
       'hotel_catalog.properties'::pg_catalog.regclass,
       'hotel_catalog.property_slugs'::pg_catalog.regclass
     ) AND NOT relation.relrowsecurity`,
    [
      hotelLockPolicies.map(([relation]) => relation),
      hotelLockPolicies.map(([, policy]) => policy),
      hotelLockPolicies.map(([, , command]) => command),
      hotelLockPolicies.map(([, , , permissive]) => permissive),
      hotelLockPolicies.map(([, , , , usingExpression]) => usingExpression),
      hotelLockPolicies.map(([, , , , , checkExpression]) => checkExpression),
      role,
    ],
  );
  if (rowPolicies.rowCount) fail("lock_protection");
}
