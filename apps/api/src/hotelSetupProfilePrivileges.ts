import type { HotelSetupPrivilegeQueryable } from "./hotelSetupReaderPrivileges.js";

/** The only routines a property_profile login may execute (migration 0470/0472). */
export const HOTEL_SETUP_PROFILE_FUNCTIONS = [
  "platform.hotel_setup_profile_allowed(uuid,uuid,uuid)",
  "platform.hotel_setup_profile_bootstrap_proof_allowed(uuid,uuid,uuid)",
  "platform.hotel_setup_property_profile_snapshot(uuid,uuid,uuid)",
  "platform.hotel_setup_update_property_profile(uuid,uuid,uuid,bigint,jsonb,text,text,text)",
] as const;
const internal = [
  "platform.hotel_setup_profile_authority(uuid,uuid,uuid,boolean)",
  "platform.hotel_setup_property_profile_row(uuid)",
  "platform.hotel_setup_sync_property_read_models(uuid)",
] as const;

/** Inside BEGIN, before any profile read, write or replay. The login owns no table privilege. */
export async function assertHotelSetupProfilePrivileges(client: HotelSetupPrivilegeQueryable) {
  const result = await client.query<{ safe: boolean }>(
    `SELECT (
    current_user=session_user AND session_user::text ~ '^vayada_next_hotel_setup_profile_[a-z0-9_]+$'
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::pg_catalog.regprocedure[])
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION'))=$3
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=ANY($2::pg_catalog.regprocedure[])
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
      WHERE p.oid=ANY($1::pg_catalog.regprocedure[] || $2::pg_catalog.regprocedure[]) AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
        AND p.proowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::pg_catalog.regclass))=$3+$4
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid),'' ORDER BY p.oid::pg_catalog.regprocedure::text))
      FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::pg_catalog.regprocedure[] || $2::pg_catalog.regprocedure[]))='0ac3d81783c8334e994ff4fecb5e6130'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,'information_schema'::pg_catalog.regnamespace)
        AND pg_catalog.has_schema_privilege(current_user,c.relnamespace,'USAGE')
        AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE pg_catalog.has_schema_privilege(current_user,c.relnamespace,'USAGE')
        AND CASE WHEN c.relkind='S'
          THEN pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE') ELSE FALSE END)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.prosecdef
      AND p.oid<>ALL($1::pg_catalog.regprocedure[])
      AND pg_catalog.has_schema_privilege(current_user,p.pronamespace,'USAGE')
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE'))
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)=1
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
      WHERE m.member=r.oid AND parent.rolname='vayada_next_hotel_setup_profile_scope'
        AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members up WHERE up.member=parent.oid))
    AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='pg_catalog'::pg_catalog.regnamespace
      AND p.proname IN ('pg_read_file','pg_read_binary_file','pg_ls_dir','lo_import','lo_export')
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET')
  ) AS safe FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`,
    [
      HOTEL_SETUP_PROFILE_FUNCTIONS,
      internal,
      HOTEL_SETUP_PROFILE_FUNCTIONS.length,
      internal.length,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup profile native inventory mismatch");
}
