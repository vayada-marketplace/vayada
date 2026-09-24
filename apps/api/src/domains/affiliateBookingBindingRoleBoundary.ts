import type pg from "pg";

const requiredReads = [
  "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions",
  "hotel_catalog.property_slugs",
] as const;

const protectedEvidence = [
  "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions",
  "booking.affiliate_original_booking_bindings",
] as const;

const bindingFunction = "booking.bind_live_affiliate_original(uuid,uuid)";
const bindingFunctionHash = "333b574d8111272f17e3841818851ba9d72bb7931698e0cc528c1cf25c6f9486";
const captureFunctions = [
  "marketplace.capture_affiliate_click(text,text,text)",
  "booking.admit_affiliate_click(text,uuid,uuid)",
] as const;
const requiredTriggers = [
  [
    "booking.guest_bookings",
    "guest_bookings_affiliate_creation_xid_no_update",
    "booking.reject_affiliate_booking_creation_xid_mutation()",
    19,
    "affiliate_binding_created_xid",
    "f1a804b3c024402278d2d8f97af84da2b5d076e3975bbd88151c57fdd99d9979",
  ],
  [
    "booking.affiliate_original_booking_bindings",
    "affiliate_original_booking_bindings_no_mutation",
    "booking.reject_affiliate_original_binding_mutation()",
    27,
    "",
    "9096899df9ee85b53e1ba5a3938a2ccdcce45dc328944685631ff9f1cb47b0fc",
  ],
  [
    "booking.affiliate_original_booking_bindings",
    "affiliate_original_booking_bindings_no_truncate",
    "booking.reject_affiliate_original_binding_mutation()",
    34,
    "",
    "9096899df9ee85b53e1ba5a3938a2ccdcce45dc328944685631ff9f1cb47b0fc",
  ],
  [
    "booking.affiliate_original_booking_bindings",
    "affiliate_original_booking_binding_reject_earning",
    "booking.reject_synthetic_binding_with_earning()",
    7,
    "",
    "d453fff393385c318a95c08d64b4b57e3ed7b0971ef8626008eb3937b592510c",
  ],
] as const;

/** Prove the connected Booking writer can bind live evidence without direct evidence writes. */
export async function assertAffiliateBookingBindingCapabilities(
  client: Pick<pg.Client, "query">,
): Promise<void> {
  const fail = (reason: string): never => {
    throw new Error(`affiliate_booking_binding_role_${reason}`);
  };
  const account = (
    await client.query(
      `SELECT role.oid,role.rolname,
              role.rolcanlogin AND NOT (
                role.rolsuper OR role.rolcreaterole OR role.rolcreatedb OR role.rolinherit OR
                role.rolbypassrls OR role.rolreplication
              ) AS safe
       FROM pg_catalog.pg_roles role WHERE role.rolname=current_user`,
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
    `SELECT 1 WHERE pg_catalog.has_database_privilege(
                      current_user,pg_catalog.current_database(),'CREATE'
                    )
                    OR pg_catalog.has_database_privilege(
                      current_user,pg_catalog.current_database(),'TEMP'
                    )
                    OR pg_catalog.has_parameter_privilege(
                      current_user,'session_replication_role','SET'
                    )
     UNION ALL SELECT 1 FROM pg_catalog.pg_namespace
       WHERE pg_catalog.left(nspname,3)<>'pg_'
         AND pg_catalog.has_schema_privilege(current_user,oid,'CREATE')`,
  );
  if (ddl.rowCount) fail("ddl");
  const schemas = (
    await client.query(
      `SELECT pg_catalog.has_schema_privilege(current_user,'booking','USAGE')
                AS booking,
              pg_catalog.has_schema_privilege(current_user,'hotel_catalog','USAGE')
                AS hotel_catalog`,
    )
  ).rows[0];
  if (!schemas?.booking || !schemas.hotel_catalog) fail("schema_usage");
  const reads = await client.query(
    `SELECT relation,
            pg_catalog.has_table_privilege(current_user,relation,'SELECT') AS allowed
     FROM pg_catalog.unnest($1::pg_catalog.text[]) relation`,
    [requiredReads],
  );
  if (reads.rows.some((row) => !row.allowed)) fail("read_capability");
  const delegatedReads = await client.query(
    `SELECT 1 FROM pg_catalog.unnest($1::pg_catalog.text[]) relation
     WHERE pg_catalog.has_table_privilege(current_user,relation,'SELECT WITH GRANT OPTION')
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid=ANY($1::pg_catalog.regclass[])
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         current_user,attribute.attrelid,attribute.attname,'SELECT WITH GRANT OPTION'
       )`,
    [requiredReads],
  );
  if (delegatedReads.rowCount) fail("read_delegation");
  const directEvidenceWrites = await client.query(
    `SELECT 1
     FROM pg_catalog.unnest($1::pg_catalog.text[]) relation
     CROSS JOIN pg_catalog.unnest(
       ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
     ) privilege
     WHERE pg_catalog.has_table_privilege(current_user,relation,privilege)
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid=ANY($1::pg_catalog.regclass[])
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND (
         pg_catalog.has_column_privilege(
           current_user,attribute.attrelid,attribute.attname,'INSERT'
         ) OR pg_catalog.has_column_privilege(
           current_user,attribute.attrelid,attribute.attname,'UPDATE'
         ) OR pg_catalog.has_column_privilege(
           current_user,attribute.attrelid,attribute.attname,'REFERENCES'
         )
       )`,
    [protectedEvidence],
  );
  if (directEvidenceWrites.rowCount) fail("direct_evidence_write");
  const capabilities = await client.query(
    `WITH expected(schema_name,function_name,argument_types,routine) AS (VALUES
       ('booking','bind_live_affiliate_original','uuid uuid',$1::pg_catalog.text),
       ('marketplace','capture_affiliate_click','text text text',$2::pg_catalog.text),
       ('booking','admit_affiliate_click','text uuid uuid',$3::pg_catalog.text)
     )
     SELECT expected.routine,
            pg_catalog.has_function_privilege(current_user,procedure.oid,'EXECUTE') AS execute,
            pg_catalog.has_function_privilege(
              current_user,procedure.oid,'EXECUTE WITH GRANT OPTION'
            ) AS delegate,
            pg_catalog.has_function_privilege('public',procedure.oid,'EXECUTE') AS public_execute
     FROM expected
     JOIN pg_catalog.pg_namespace namespace ON namespace.nspname=expected.schema_name
     JOIN pg_catalog.pg_proc procedure
      ON procedure.pronamespace=namespace.oid
      AND procedure.proname=expected.function_name
      AND (
        expected.argument_types='uuid uuid' AND procedure.pronargs=2
          AND procedure.proargtypes[0]='uuid'::pg_catalog.regtype
          AND procedure.proargtypes[1]='uuid'::pg_catalog.regtype
        OR expected.argument_types='text text text' AND procedure.pronargs=3
          AND procedure.proargtypes[0]='text'::pg_catalog.regtype
          AND procedure.proargtypes[1]='text'::pg_catalog.regtype
          AND procedure.proargtypes[2]='text'::pg_catalog.regtype
        OR expected.argument_types='text uuid uuid' AND procedure.pronargs=3
          AND procedure.proargtypes[0]='text'::pg_catalog.regtype
          AND procedure.proargtypes[1]='uuid'::pg_catalog.regtype
          AND procedure.proargtypes[2]='uuid'::pg_catalog.regtype
      )`,
    [bindingFunction, ...captureFunctions],
  );
  const capability = new Map(capabilities.rows.map((row) => [row.routine, row]));
  const binding = capability.get(bindingFunction);
  if (!binding?.execute) fail("function_execute");
  if (capabilities.rows.some((row) => row.delegate)) fail("function_delegation");
  if (capabilities.rows.some((row) => row.public_execute)) fail("public_execute");
  if (captureFunctions.some((routine) => capability.get(routine)?.execute))
    fail("capture_function_execute");
  const functionBoundary = await client.query(
    `SELECT 1 FROM pg_catalog.pg_proc procedure
     WHERE procedure.oid=$1::pg_catalog.regprocedure
       AND procedure.prosecdef AND procedure.provolatile='v'
       AND procedure.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
       AND pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc,'UTF8')),'hex'
           )=$2
       AND procedure.proowner<>(SELECT oid FROM pg_catalog.pg_roles
                                WHERE rolname=current_user)`,
    [bindingFunction, bindingFunctionHash],
  );
  if (functionBoundary.rowCount !== 1) fail("function_boundary");
  const triggers = await client.query(
    `SELECT expected.relation,expected.trigger_name
     FROM (
       SELECT ($1::pg_catalog.text[])[position] AS relation,
              ($2::pg_catalog.text[])[position] AS trigger_name,
              ($3::pg_catalog.text[])[position] AS function_name,
              ($4::pg_catalog.int2[])[position] AS trigger_type,
              ($5::pg_catalog.text[])[position] AS update_column,
              ($6::pg_catalog.text[])[position] AS function_hash
       FROM pg_catalog.generate_subscripts($1::pg_catalog.text[],1) position
     ) expected
     LEFT JOIN pg_catalog.pg_trigger trigger
       ON trigger.tgrelid=expected.relation::pg_catalog.regclass
      AND trigger.tgname=expected.trigger_name AND NOT trigger.tgisinternal
      AND trigger.tgfoid=expected.function_name::pg_catalog.regprocedure
      AND trigger.tgtype=expected.trigger_type AND trigger.tgenabled IN ('O','A')
      AND trigger.tgqual IS NULL
      AND trigger.tgattr::pg_catalog.text=COALESCE((
        SELECT attribute.attnum::pg_catalog.text
        FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid=trigger.tgrelid
          AND attribute.attname=expected.update_column
          AND NOT attribute.attisdropped
      ),'')
     LEFT JOIN pg_catalog.pg_proc procedure
       ON procedure.oid=trigger.tgfoid
      AND pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc,'UTF8')),'hex'
          )=expected.function_hash
     WHERE trigger.oid IS NULL OR procedure.oid IS NULL`,
    [
      requiredTriggers.map(([relation]) => relation),
      requiredTriggers.map(([, trigger]) => trigger),
      requiredTriggers.map(([, , fn]) => fn),
      requiredTriggers.map(([, , , type]) => type),
      requiredTriggers.map(([, , , , column]) => column),
      requiredTriggers.map(([, , , , , hash]) => hash),
    ],
  );
  if (triggers.rowCount) fail("trigger_boundary");
}
