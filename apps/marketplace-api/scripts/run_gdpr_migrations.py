#!/usr/bin/env python3
"""
Standalone GDPR migration script - doesn't rely on app config
Usage: python scripts/run_gdpr_migrations.py <DATABASE_URL>
"""
import sys
import asyncio
import asyncpg

MIGRATIONS = [
    # Migration 024: User consent fields
    """
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS terms_version text,
    ADD COLUMN IF NOT EXISTS privacy_version text,
    ADD COLUMN IF NOT EXISTS marketing_consent boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS marketing_consent_at timestamp with time zone;
    """,

    # Migration 025: Cookie consent table
    """
    CREATE TABLE IF NOT EXISTS public.cookie_consent (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        visitor_id text NOT NULL,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        necessary boolean DEFAULT true NOT NULL,
        functional boolean DEFAULT false NOT NULL,
        analytics boolean DEFAULT false NOT NULL,
        marketing boolean DEFAULT false NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_cookie_consent_visitor_id ON public.cookie_consent(visitor_id);",
    "CREATE INDEX IF NOT EXISTS idx_cookie_consent_user_id ON public.cookie_consent(user_id);",

    # Migration 026: Consent history table
    """
    CREATE TABLE IF NOT EXISTS public.consent_history (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        consent_type text NOT NULL,
        consent_given boolean NOT NULL,
        version text,
        ip_address text,
        user_agent text,
        created_at timestamp with time zone DEFAULT now() NOT NULL
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_consent_history_user_id ON public.consent_history(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_consent_history_consent_type ON public.consent_history(consent_type);",
    "CREATE INDEX IF NOT EXISTS idx_consent_history_created_at ON public.consent_history(created_at);",

    # Migration 026: GDPR requests table
    """
    CREATE TABLE IF NOT EXISTS public.gdpr_requests (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id uuid REFERENCES users(id) ON DELETE SET NULL NOT NULL,
        request_type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        requested_at timestamp with time zone DEFAULT now() NOT NULL,
        processed_at timestamp with time zone,
        expires_at timestamp with time zone,
        download_token text,
        cancellation_reason text,
        ip_address text,
        CONSTRAINT valid_request_type CHECK (request_type IN ('export', 'deletion')),
        CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'expired'))
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_gdpr_requests_user_id ON public.gdpr_requests(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_gdpr_requests_status ON public.gdpr_requests(status);",
    "CREATE INDEX IF NOT EXISTS idx_gdpr_requests_download_token ON public.gdpr_requests(download_token);",

    # Migration 027: Backfill existing users
    """
    UPDATE public.users
    SET
        terms_accepted_at = created_at,
        privacy_accepted_at = created_at,
        terms_version = '2024-01-01',
        privacy_version = '2024-01-01'
    WHERE terms_accepted_at IS NULL;
    """,
]


async def run_migrations(database_url: str):
    print("🔗 Connecting to database...")

    try:
        conn = await asyncio.wait_for(
            asyncpg.connect(database_url, ssl='require'),
            timeout=10
        )
        print("✅ Connected!\n")

        for i, sql in enumerate(MIGRATIONS, 1):
            print(f"🔄 Running migration step {i}/{len(MIGRATIONS)}...")
            try:
                await conn.execute(sql)
                print(f"✅ Step {i} completed")
            except Exception as e:
                # Ignore "already exists" errors
                if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                    print(f"⏭️  Step {i} skipped (already exists)")
                else:
                    print(f"❌ Step {i} failed: {e}")
                    raise

        await conn.close()
        print("\n🎉 All GDPR migrations completed successfully!")

    except asyncio.TimeoutError:
        print("❌ Connection timed out - database not reachable from this network")
        print("   Your RDS security group likely blocks external connections.")
        print("   Options:")
        print("   1. Use AWS CloudShell to run this script")
        print("   2. Temporarily add your IP to the RDS security group")
        print("   3. Run the SQL manually via a bastion host")
        sys.exit(1)
    except asyncpg.exceptions.InvalidPasswordError:
        print("❌ Invalid database password")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/run_gdpr_migrations.py <DATABASE_URL>")
        print("Example: python scripts/run_gdpr_migrations.py 'postgresql://user:pass@host:5432/db'")
        sys.exit(1)

    database_url = sys.argv[1]
    asyncio.run(run_migrations(database_url))
