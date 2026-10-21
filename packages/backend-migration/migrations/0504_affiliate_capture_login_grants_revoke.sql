-- Migration: 0504_affiliate_capture_login_grants_revoke
-- Owner: platform / VAY-2272 (Marketplace removal step 5). Ships with W2 (0498, 0499) or in the
-- release right after, after the counts-0504 before-run.
--
-- vayada_next_affiliate_capture was made for the affiliate click capture, which never went live.
-- 0497 retired its policies and functions, and platform's retire-affiliate-capture-login drops the
-- login as vayada_admin. That script refuses while anyone else has granted the login something,
-- and only a grantor can revoke its grant: the migration owner gave the login table, routine and
-- schema privileges. This revokes every table, column, sequence, routine and schema privilege the
-- migration owner granted it in this database, whichever objects are left (31 before 0498 and
-- 0499, 13 after), and grants nothing. Since 0497 the login's UPDATE on hotel_catalog.properties
-- and property_slugs is a real write again.
-- Without the login (every database but production) it changes nothing.
--
-- Rollback: any image; no code uses the login.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  capture_login oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_affiliate_capture');
  migration_owner oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  revoke_statement text;
BEGIN
  IF capture_login IS NULL THEN
    RETURN;
  END IF;

  -- One REVOKE ALL per object; on a table it also revokes the login's column privileges.
  FOR revoke_statement IN
    SELECT format('REVOKE ALL ON %s %s FROM vayada_next_affiliate_capture',
                  CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, c.oid::regclass)
    FROM pg_catalog.pg_class c
    WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) acl
                  WHERE acl.grantee = capture_login AND acl.grantor = migration_owner)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
                  WHERE a.attrelid = c.oid AND acl.grantee = capture_login AND acl.grantor = migration_owner)
    UNION ALL
    SELECT format('REVOKE ALL ON ROUTINE %s FROM vayada_next_affiliate_capture', p.oid::regprocedure)
    FROM pg_catalog.pg_proc p
    WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl
                  WHERE acl.grantee = capture_login AND acl.grantor = migration_owner)
    UNION ALL
    SELECT format('REVOKE ALL ON SCHEMA %I FROM vayada_next_affiliate_capture', n.nspname)
    FROM pg_catalog.pg_namespace n
    WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(n.nspacl) acl
                  WHERE acl.grantee = capture_login AND acl.grantor = migration_owner)
  LOOP
    EXECUTE revoke_statement;
  END LOOP;

  -- Grants by other grantors stay: they cannot be revoked here, and platform's inspect lists them.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
    WHERE acl.grantee = capture_login AND acl.grantor = migration_owner
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
    WHERE acl.grantee = capture_login AND acl.grantor = migration_owner
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) acl
    WHERE acl.grantee = capture_login AND acl.grantor = migration_owner
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) acl
    WHERE acl.grantee = capture_login AND acl.grantor = migration_owner
  ) THEN
    RAISE EXCEPTION 'The migration owner still grants vayada_next_affiliate_capture a privilege';
  END IF;
END $$;
