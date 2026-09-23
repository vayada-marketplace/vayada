"""Local migration proof only; starts a disposable PostgreSQL cluster, no URLs.

Usage: python3 scripts/pricing-property-boundary-proof.py /path/to/postgres/bin
No production connection, credential provisioning, or application wiring.
"""

import getpass
import os
import re
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

BIN = Path(sys.argv[1])
ROOT = Path(__file__).resolve().parents[1]
OWNER = getpass.getuser()
A = "00000000-0000-4000-8000-000000000001"
B = "00000000-0000-4000-8000-000000000002"
ORG = "00000000-0000-4000-8000-000000000003"
OTHER_ORG = "00000000-0000-4000-8000-000000000009"
ACTOR = "00000000-0000-4000-8000-000000000004"
R1 = "00000000-0000-4000-8000-000000000005"
R2 = "00000000-0000-4000-8000-000000000006"
OWNER_A = "vayada_next_pricing_owner_a"
OWNER_B = "vayada_next_pricing_owner_b"
PUBLIC_A = "vayada_next_pricing_public_a"
PUBLIC_B = "vayada_next_pricing_public_b"
READER_A = "vayada_next_pricing_reader_a"
LEGACY = "legacy_runtime"
passwords = {
    r: secrets.token_hex(32) for r in (OWNER_A, OWNER_B, PUBLIC_A, PUBLIC_B, READER_A, LEGACY)
}
roles = ", ".join(passwords)


def run(args, **kwargs):
    kwargs.setdefault("timeout", 300)
    try:
        return subprocess.run(args, text=True, capture_output=True, **kwargs)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"command timed out: {args!r}") from error


with tempfile.TemporaryDirectory(prefix="vay1543-pg-", dir="/tmp") as directory:
    base = Path(directory)
    data = base / "data"
    initialized = run([str(BIN / "initdb"), "-D", str(data), "--auth-local=peer"])
    assert initialized.returncode == 0, initialized.stderr
    (data / "pg_hba.conf").write_text(f"local all {OWNER} peer\nlocal all all scram-sha-256\n")
    with (data / "postgresql.conf").open("a") as config:
        config.write(f"\nlisten_addresses = ''\nunix_socket_directories = '{base}'\n")
    started = run([str(BIN / "pg_ctl"), "-D", str(data), "-l", str(base / "log"), "-w", "start"])
    assert started.returncode == 0, started.stderr

    def sql(query, role=OWNER, denied=False, state="42501"):
        result = run(
            [
                str(BIN / "psql"),
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-v",
                "VERBOSITY=verbose",
                "-h",
                str(base),
                "-U",
                role,
                "-d",
                "postgres",
            ],
            input=query,
            env={
                **{k: v for k, v in os.environ.items() if not k.startswith("PG")},
                "PGPASSWORD": passwords.get(role, ""),
            },
        )
        if denied:
            assert result.returncode != 0 and state in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def quote(property_id, number, organization=ORG):
        quote_id = f"10000000-0000-4000-8000-{number:012d}"
        return f"""INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
        VALUES ('{quote_id}','{property_id}','{organization}','proof-{number}',repeat('a',64),
        jsonb_build_object('quote',jsonb_build_object('quoteId','{quote_id}',
        'stay',jsonb_build_object('propertyId','{property_id}'))));"""

    def revision(property_id, revision_id, request):
        return f"""INSERT INTO booking.pricing_authority_revisions
        (property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash)
        VALUES ('{property_id}','{revision_id}','vayada','{ORG}','{ACTOR}','{request}',repeat('a',64));"""

    try:
        migrations = sorted((ROOT / "packages/backend-migration/migrations").glob("*.sql"))
        runner = (ROOT / "packages/backend-migration/src/runner.ts").read_text()
        ledger = re.search(
            r"CREATE TABLE IF NOT EXISTS platform.schema_migrations .*?\n    \)", runner, re.S
        )
        assert ledger, "migration ledger definition changed"
        sql("CREATE SCHEMA platform;" + ledger.group())
        sql(
            "\n".join(
                content
                if "-- vayada:no-transaction" in content
                else "BEGIN;\n" + content + "\nCOMMIT;"
                for content in (path.read_text() for path in migrations)
            )
        )
        assert (
            sql("""SELECT count(*) FROM pg_catalog.pg_proc routine
              JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname IN ('booking','platform')
                AND routine.proname LIKE 'pricing_runtime_%' AND routine.prosecdef""")
            == "0"
        )
        for role, password in passwords.items():
            inheritance = "INHERIT" if role == LEGACY else "NOINHERIT"
            sql(
                f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE {inheritance} NOBYPASSRLS PASSWORD '{password}';"
            )
        sql(f"""
        INSERT INTO identity.organizations(id,kind,name,slug) VALUES ('{ORG}','hotel_group','Proof','proof');
        INSERT INTO identity.organizations(id,kind,name,slug) VALUES ('{OTHER_ORG}','hotel_group','Other','other');
        INSERT INTO identity.users(id,email) VALUES ('{ACTOR}','proof@example.invalid');
        INSERT INTO hotel_catalog.properties(id,public_id,display_name)
          VALUES ('{A}','proof-a','Proof A'),('{B}','proof-b','Proof B');
        INSERT INTO platform.pricing_runtime_property_scopes
          (database_login,operation_class,property_id,organization_id) VALUES
          ('{OWNER_A}','owner_manage','{A}','{ORG}'),
          ('{OWNER_B}','owner_manage','{B}','{ORG}'),
          ('{PUBLIC_A}','public','{A}','{ORG}'),
          ('{PUBLIC_B}','public','{B}','{ORG}'),
          ('{READER_A}','owner_read','{A}','{ORG}');
        GRANT USAGE ON SCHEMA booking, platform, identity TO {roles};
        GRANT SELECT, UPDATE ON identity.organizations TO {roles};
        GRANT SELECT ON booking.pricing_quotes,booking.pricing_authority_revisions,
          booking.pricing_authority_heads TO {roles};
        GRANT INSERT ON booking.pricing_quotes TO {PUBLIC_A},{PUBLIC_B};
        GRANT INSERT ON booking.pricing_authority_revisions,
          booking.pricing_authority_heads TO {OWNER_A},{OWNER_B};
        GRANT UPDATE(revision) ON booking.pricing_authority_heads TO {roles};
        GRANT UPDATE(revision) ON booking.pricing_authority_revisions TO {roles};
        GRANT INSERT ON booking.pricing_quotes TO {LEGACY};
        """)
        assert (
            sql(
                "SELECT session_user = current_user AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls FROM pg_roles WHERE rolname = session_user",
                OWNER_A,
            )
            == "t"
        )
        for role in (OWNER_A, PUBLIC_A, READER_A):
            assert (
                sql(
                    f"BEGIN; SELECT id FROM identity.organizations WHERE id='{ORG}' FOR UPDATE; ROLLBACK;",
                    role,
                )
                == ORG
            )
            sql(
                f"UPDATE identity.organizations SET name='tampered' WHERE id='{ORG}'",
                role,
                denied=True,
            )
        assert (
            sql(
                f"BEGIN; UPDATE identity.organizations SET name='legacy-write' WHERE id='{ORG}' RETURNING name; ROLLBACK;",
                LEGACY,
            )
            == "legacy-write"
        )
        assert sql(f"SELECT name FROM identity.organizations WHERE id='{ORG}'") == "Proof"
        sql(quote(A, 1), PUBLIC_A)
        sql(quote(B, 2), PUBLIC_B)
        sql(quote(B, 3), PUBLIC_A, denied=True)
        sql(f"SET app.property_id = '{B}';" + quote(B, 4), PUBLIC_A, denied=True)
        sql(quote(A, 9, OTHER_ORG), PUBLIC_A, denied=True)
        sql(quote(A, 10), OWNER_A, denied=True)
        sql(quote(A, 14), READER_A, denied=True)
        sql(
            revision(A, "00000000-0000-4000-8000-000000000014", "reader-escalation"),
            READER_A,
            denied=True,
        )
        # Non-pricing roles retain their prior policy behavior. Switching into
        # a pricing role cannot acquire its DB-owned assignment. The legacy
        # role deliberately has no access to the scope table.
        sql("SELECT 1 FROM platform.pricing_runtime_property_scopes", LEGACY, denied=True)
        sql("BEGIN;" + quote(B, 11) + "ROLLBACK", LEGACY)
        sql(f"GRANT {OWNER_B} TO {OWNER_A},{LEGACY}")
        sql(
            f"UPDATE identity.organizations SET name='role-hop' WHERE id='{ORG}'",
            LEGACY,
            denied=True,
        )
        sql(
            revision(B, "00000000-0000-4000-8000-000000000015", "inherited-owner"),
            LEGACY,
            denied=True,
        )
        # Revoking the parent role's property scope must not reclassify an
        # inherited pricing member as an unrestricted legacy writer.
        sql(
            f"DELETE FROM platform.pricing_runtime_property_scopes WHERE database_login='{OWNER_B}'"
        )
        sql(
            revision(B, "00000000-0000-4000-8000-000000000016", "inherited-after-revoke"),
            LEGACY,
            denied=True,
        )
        sql(f"""INSERT INTO platform.pricing_runtime_property_scopes
          (database_login,operation_class,property_id,organization_id)
          VALUES ('{OWNER_B}','owner_manage','{B}','{ORG}')""")
        sql(
            f"SET ROLE {OWNER_B};"
            + revision(B, "00000000-0000-4000-8000-000000000012", "role-hop-owner"),
            OWNER_A,
            denied=True,
        )
        sql(
            f"SET ROLE {OWNER_B};"
            + revision(B, "00000000-0000-4000-8000-000000000013", "role-hop-legacy"),
            LEGACY,
            denied=True,
        )
        sql(f"SET SESSION AUTHORIZATION {OWNER_B}", OWNER_A, denied=True)
        sql(
            f"UPDATE platform.pricing_runtime_property_scopes SET property_id = '{B}' WHERE database_login = session_user",
            OWNER_A,
            denied=True,
        )
        sql(
            "ALTER TABLE booking.pricing_quotes DISABLE ROW LEVEL SECURITY",
            OWNER_A,
            denied=True,
        )
        sql("SET row_security = off;" + quote(B, 5), PUBLIC_A, denied=True)
        sql(
            "BEGIN;"
            + revision(A, R1, "a1")
            + f"INSERT INTO booking.pricing_authority_heads VALUES ('{A}','{R1}'); COMMIT;",
            OWNER_A,
        )
        foreign_revision = "00000000-0000-4000-8000-000000000011"
        sql(revision(A, foreign_revision, "other-organization").replace(ORG, OTHER_ORG))
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{foreign_revision}' WHERE property_id='{A}'",
            OWNER_A,
            denied=True,
        )
        sql(
            "BEGIN;"
            + revision(A, R2, "a2")
            + f"UPDATE booking.pricing_authority_heads SET revision='{R2}' WHERE property_id='{A}'; COMMIT;",
            OWNER_A,
        )
        sql(
            revision(B, "00000000-0000-4000-8000-000000000007", "wrong-property"),
            OWNER_A,
            denied=True,
        )
        sql(
            revision(A, "00000000-0000-4000-8000-000000000010", "public-owner-escalation"),
            PUBLIC_A,
            denied=True,
        )
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{R1}' WHERE property_id='{A}'",
            PUBLIC_A,
            denied=True,
        )
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{R1}' WHERE property_id='{A}'",
            READER_A,
            denied=True,
        )
        sql(f"SET ROLE {OWNER_A}", PUBLIC_A, denied=True)
        assert (
            sql(
                f"BEGIN; SELECT property_id FROM booking.pricing_authority_heads WHERE property_id='{A}' FOR SHARE; ROLLBACK",
                PUBLIC_A,
            )
            == A
        )
        # Seed a valid second-property head to distinguish policy denial from FK errors.
        r3 = "00000000-0000-4000-8000-000000000008"
        sql(
            revision(B, r3, "b1")
            + f"INSERT INTO booking.pricing_authority_heads VALUES ('{B}','{r3}');",
            OWNER_B,
        )
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{r3}' WHERE property_id='{B}'",
            OWNER_A,
            denied=True,
        )
        # Only revision is updatable: NEW-row RLS alone would allow reparenting
        # B's head into A when A has no head. Remove the conflicting target so
        # this denial cannot be credited to a unique/FK constraint.
        sql(f"DELETE FROM booking.pricing_authority_heads WHERE property_id='{A}'")
        sql(
            f"UPDATE booking.pricing_authority_heads SET property_id='{A}',revision='{R2}' WHERE property_id='{B}'",
            OWNER_A,
            denied=True,
        )
        assert (
            sql(f"SELECT revision FROM booking.pricing_authority_heads WHERE property_id='{B}'")
            == r3
        )
        sql(f"INSERT INTO booking.pricing_authority_heads VALUES ('{A}','{R2}')", OWNER_A)
        sql(
            f"DELETE FROM booking.pricing_authority_heads WHERE property_id='{A}'",
            OWNER_A,
            denied=True,
        )
        sql("UPDATE booking.pricing_quotes SET request_id='tampered'", OWNER_A, denied=True)
        sql(
            f"UPDATE booking.pricing_authority_revisions SET revision=revision WHERE property_id='{A}'",
            OWNER_A,
            denied=True,
            state="55000",
        )
        sql("DELETE FROM booking.pricing_authority_revisions", OWNER_A, denied=True)
        # This is the application's exact joined lock shape. Cross-property
        # locking visibility is intentional, not tenant read isolation.
        for role in (OWNER_A, PUBLIC_A, READER_A):
            assert (
                sql(
                    f"""BEGIN;
                    SELECT h.property_id FROM booking.pricing_authority_heads h
                    JOIN booking.pricing_authority_revisions r
                      USING(property_id,revision)
                    WHERE h.property_id='{B}' FOR SHARE OF h,r;
                    ROLLBACK;""",
                    role,
                )
                == B
            )
        # Demonstrate that a failed write rolls back an earlier allowed write.
        sql("BEGIN;" + quote(A, 6) + quote(B, 7) + "COMMIT;", PUBLIC_A, denied=True)
        assert sql("SELECT count(*) FROM booking.pricing_quotes") == "2"
        assert (
            sql(f"SELECT revision FROM booking.pricing_authority_heads WHERE property_id='{A}'")
            == R2
        )
        # Revocation is DB-owned; the same authenticated login immediately loses writes.
        sql(
            f"DELETE FROM platform.pricing_runtime_property_scopes WHERE database_login='{PUBLIC_A}'"
        )
        sql(quote(A, 8), PUBLIC_A, denied=True)
        print(
            f"PASS PostgreSQL {sql('SHOW server_version')}: {len(migrations)} migrations through {migrations[-1].name}"
        )
        print(
            "PASS owner/public separation; organization lock-only denial; attestation-safe scope views; property/org/GUC/inherited-role/ACL/RLS-bypass denials; exact joined locks; rollback; scope revocation"
        )
        print(
            "LIMIT: DB primitive only; no request identity issuer, actor binding, full route/lock matrix, or live rollout proof"
        )
    finally:
        stopped = run([str(BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "stop"])
        assert stopped.returncode == 0, stopped.stderr
