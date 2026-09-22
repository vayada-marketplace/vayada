"""Local feasibility proof only; starts a disposable PostgreSQL cluster, no URLs.

Usage: python3 scripts/pricing-property-boundary-proof.py /path/to/postgres/bin
No production migration, credential provisioning, or application wiring.
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
passwords = {r: secrets.token_hex(32) for r in ("pricing_a", "pricing_b", "public_a", "public_b")}
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

    def sql(query, role=OWNER, denied=False):
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
            assert result.returncode != 0 and "42501" in result.stderr, result.stderr
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
        for role, password in passwords.items():
            sql(
                f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '{password}';"
            )
        sql(f"""
        INSERT INTO identity.organizations(id,kind,name,slug) VALUES ('{ORG}','hotel_group','Proof','proof');
        INSERT INTO identity.organizations(id,kind,name,slug) VALUES ('{OTHER_ORG}','hotel_group','Other','other');
        INSERT INTO identity.users(id,email) VALUES ('{ACTOR}','proof@example.invalid');
        INSERT INTO hotel_catalog.properties(id,public_id,display_name)
          VALUES ('{A}','proof-a','Proof A'),('{B}','proof-b','Proof B');
        CREATE SCHEMA proof_scope;
        REVOKE ALL ON SCHEMA proof_scope FROM PUBLIC;
        CREATE TABLE proof_scope.assignments(login name PRIMARY KEY, property_id uuid NOT NULL, organization_id uuid NOT NULL);
        INSERT INTO proof_scope.assignments VALUES ('pricing_a','{A}','{ORG}'),('pricing_b','{B}','{ORG}'),
          ('public_a','{A}','{ORG}'),('public_b','{B}','{ORG}');
        GRANT USAGE ON SCHEMA booking, proof_scope TO {roles};
        GRANT SELECT ON proof_scope.assignments TO {roles};
        """)
        # session_user is the authenticated DB login, not a caller-set property GUC.
        # Restrictive policies cannot be bypassed by a later permissive policy.
        head_organization_check = """AND EXISTS (SELECT 1 FROM booking.pricing_authority_revisions r
          WHERE r.property_id = pricing_authority_heads.property_id AND r.revision = pricing_authority_heads.revision
          AND r.organization_id = (SELECT organization_id FROM proof_scope.assignments WHERE login = session_user))"""
        for table in ("pricing_quotes", "pricing_authority_revisions", "pricing_authority_heads"):
            writers = "public_a, public_b" if table == "pricing_quotes" else "pricing_a, pricing_b"
            organization_check = (
                head_organization_check
                if table == "pricing_authority_heads"
                else "AND organization_id = (SELECT organization_id FROM proof_scope.assignments WHERE login = session_user)"
            )
            sql(f"""
            ALTER TABLE booking.{table} ENABLE ROW LEVEL SECURITY;
            GRANT SELECT ON booking.{table} TO {roles};
            GRANT INSERT ON booking.{table} TO {writers};
            CREATE POLICY proof_existing_access ON booking.{table} USING (true) WITH CHECK (true);
            CREATE POLICY proof_write_scope ON booking.{table} AS RESTRICTIVE FOR INSERT
              TO {roles} WITH CHECK (property_id =
                (SELECT property_id FROM proof_scope.assignments WHERE login = session_user) {organization_check});
            """)
        sql(f"""
        GRANT UPDATE(revision) ON booking.pricing_authority_heads TO pricing_a, pricing_b;
        CREATE POLICY proof_update_scope ON booking.pricing_authority_heads AS RESTRICTIVE FOR UPDATE
          TO pricing_a, pricing_b USING (true) WITH CHECK (property_id =
            (SELECT property_id FROM proof_scope.assignments WHERE login = session_user) {head_organization_check});
        GRANT UPDATE(revision) ON booking.pricing_authority_heads TO public_a, public_b;
        CREATE POLICY proof_public_lock_only ON booking.pricing_authority_heads AS RESTRICTIVE FOR UPDATE
          TO public_a, public_b USING (true) WITH CHECK (false);
        """)
        assert (
            sql(
                "SELECT session_user = current_user AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls FROM pg_roles WHERE rolname = session_user",
                "pricing_a",
            )
            == "t"
        )
        sql(quote(A, 1), "public_a")
        sql(quote(B, 2), "public_b")
        sql(quote(B, 3), "public_a", denied=True)
        sql(f"SET app.property_id = '{B}';" + quote(B, 4), "public_a", denied=True)
        sql(quote(A, 9, OTHER_ORG), "public_a", denied=True)
        sql(quote(A, 10), "pricing_a", denied=True)
        sql("SET SESSION AUTHORIZATION pricing_b", "pricing_a", denied=True)
        sql("SET ROLE pricing_b", "pricing_a", denied=True)
        sql(
            f"UPDATE proof_scope.assignments SET property_id = '{B}' WHERE login = session_user",
            "pricing_a",
            denied=True,
        )
        sql(
            "ALTER TABLE booking.pricing_quotes DISABLE ROW LEVEL SECURITY",
            "pricing_a",
            denied=True,
        )
        sql("SET row_security = off;" + quote(B, 5), "public_a", denied=True)
        sql(
            "BEGIN;"
            + revision(A, R1, "a1")
            + f"INSERT INTO booking.pricing_authority_heads VALUES ('{A}','{R1}'); COMMIT;",
            "pricing_a",
        )
        foreign_revision = "00000000-0000-4000-8000-000000000011"
        sql(revision(A, foreign_revision, "other-organization").replace(ORG, OTHER_ORG))
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{foreign_revision}' WHERE property_id='{A}'",
            "pricing_a",
            denied=True,
        )
        sql(
            "BEGIN;"
            + revision(A, R2, "a2")
            + f"UPDATE booking.pricing_authority_heads SET revision='{R2}' WHERE property_id='{A}'; COMMIT;",
            "pricing_a",
        )
        sql(
            revision(B, "00000000-0000-4000-8000-000000000007", "wrong-property"),
            "pricing_a",
            denied=True,
        )
        sql(
            revision(A, "00000000-0000-4000-8000-000000000010", "public-owner-escalation"),
            "public_a",
            denied=True,
        )
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{R1}' WHERE property_id='{A}'",
            "public_a",
            denied=True,
        )
        sql("SET ROLE pricing_a", "public_a", denied=True)
        assert (
            sql(
                f"BEGIN; SELECT property_id FROM booking.pricing_authority_heads WHERE property_id='{A}' FOR SHARE; ROLLBACK",
                "public_a",
            )
            == A
        )
        # Seed a valid second-property head to distinguish policy denial from FK errors.
        r3 = "00000000-0000-4000-8000-000000000008"
        sql(
            revision(B, r3, "b1")
            + f"INSERT INTO booking.pricing_authority_heads VALUES ('{B}','{r3}');",
            "pricing_b",
        )
        sql(
            f"UPDATE booking.pricing_authority_heads SET revision='{r3}' WHERE property_id='{B}'",
            "pricing_a",
            denied=True,
        )
        # Only revision is updatable: NEW-row RLS alone would allow reparenting
        # B's head into A when A has no head. Remove the conflicting target so
        # this denial cannot be credited to a unique/FK constraint.
        sql(f"DELETE FROM booking.pricing_authority_heads WHERE property_id='{A}'")
        sql(
            f"UPDATE booking.pricing_authority_heads SET property_id='{A}',revision='{R2}' WHERE property_id='{B}'",
            "pricing_a",
            denied=True,
        )
        assert (
            sql(f"SELECT revision FROM booking.pricing_authority_heads WHERE property_id='{B}'")
            == r3
        )
        sql(f"INSERT INTO booking.pricing_authority_heads VALUES ('{A}','{R2}')", "pricing_a")
        sql(
            f"DELETE FROM booking.pricing_authority_heads WHERE property_id='{A}'",
            "pricing_a",
            denied=True,
        )
        sql("UPDATE booking.pricing_quotes SET request_id='tampered'", "pricing_a", denied=True)
        sql("DELETE FROM booking.pricing_authority_revisions", "pricing_a", denied=True)
        # Cross-property locking visibility is intentional, not tenant read isolation.
        for role in ("pricing_a", "public_a"):
            assert (
                sql(
                    f"BEGIN; SELECT property_id FROM booking.pricing_authority_heads WHERE property_id='{B}' FOR SHARE; ROLLBACK",
                    role,
                )
                == B
            )
        # Demonstrate that a failed write rolls back an earlier allowed write.
        sql("BEGIN;" + quote(A, 6) + quote(B, 7) + "COMMIT;", "public_a", denied=True)
        assert sql("SELECT count(*) FROM booking.pricing_quotes") == "2"
        assert (
            sql(f"SELECT revision FROM booking.pricing_authority_heads WHERE property_id='{A}'")
            == R2
        )
        # Revocation is DB-owned; the same authenticated login immediately loses writes.
        sql("DELETE FROM proof_scope.assignments WHERE login='public_a'")
        sql(quote(A, 8), "public_a", denied=True)
        print(
            f"PASS PostgreSQL {sql('SHOW server_version')}: {len(migrations)} migrations through {migrations[-1].name}"
        )
        print(
            "PASS owner/public role separation; property/org/GUC/role/ACL/RLS-bypass denials; head reparent denial; locks; rollback; scope revocation"
        )
        print(
            "LIMIT: DB primitive only; no request identity issuer, actor binding, full route/lock matrix, or live rollout proof"
        )
    finally:
        stopped = run([str(BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "stop"])
        assert stopped.returncode == 0, stopped.stderr
