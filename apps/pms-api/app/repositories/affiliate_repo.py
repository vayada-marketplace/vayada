import secrets
import string
from typing import Optional, List
from app.database import Database
from app.repositories.affiliate_payout_settings_repo import AffiliatePayoutSettingsRepository
from app.utils import generate_unique_code


def _make_referral_code() -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(8))


# SELECT fragment that surfaces canonical payout settings under the
# same column names the codebase used to read off `affiliates`. Kept
# as a constant so every repo query joins the same way.
_PAYOUT_JOIN = """
LEFT JOIN affiliate_payout_settings apsf ON apsf.user_id = a.user_id
"""

_PAYOUT_COLUMNS = """
    COALESCE(apsf.payment_method, 'stripe') AS payment_method,
    COALESCE(apsf.paypal_email, '')         AS paypal_email,
    COALESCE(apsf.bank_iban, '')            AS bank_iban,
    COALESCE(apsf.bank_account_holder, '')  AS bank_account_holder,
    COALESCE(apsf.bank_swift_bic, '')       AS bank_swift_bic,
    COALESCE(apsf.bank_name, '')            AS bank_name,
    COALESCE(apsf.bank_country, '')         AS bank_country,
    apsf.xendit_channel_code,
    apsf.xendit_account_number,
    apsf.xendit_account_holder_name
"""


class AffiliateRepository:

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        # Generate unique referral code
        async def code_exists(code: str) -> bool:
            return bool(await Database.fetchval(
                "SELECT 1 FROM affiliates WHERE hotel_id = $1 AND referral_code = $2",
                hotel_id,
                code,
            ))

        code = await generate_unique_code(_make_referral_code, code_exists, entity_name="referral code")

        row = await Database.fetchrow(
            f"""
            WITH inserted AS (
                INSERT INTO affiliates (
                    hotel_id, referral_code, full_name, email,
                    social_media, user_type
                ) VALUES (
                    $1, $2, $3, $4, $5, $6
                ) RETURNING *
            )
            SELECT inserted.*,
                   h.default_affiliate_commission_pct AS default_commission_pct,
                   COALESCE(inserted.commission_pct_override, h.default_affiliate_commission_pct)
                       AS effective_commission_pct,
                   {_PAYOUT_COLUMNS}
              FROM inserted
              JOIN hotels h ON h.id = inserted.hotel_id
              LEFT JOIN affiliate_payout_settings apsf ON apsf.user_id = inserted.user_id
            """,
            hotel_id,
            code,
            data["full_name"],
            data["email"],
            data.get("social_media", ""),
            data.get("user_type", "guest"),
        )
        return dict(row)

    @staticmethod
    async def get_by_code(hotel_id: str, referral_code: str) -> Optional[dict]:
        row = await Database.fetchrow(
            f"""
            SELECT a.*,
                   h.default_affiliate_commission_pct AS default_commission_pct,
                   COALESCE(a.commission_pct_override, h.default_affiliate_commission_pct)
                       AS effective_commission_pct,
                   {_PAYOUT_COLUMNS}
              FROM affiliates a
              JOIN hotels h ON h.id = a.hotel_id
              {_PAYOUT_JOIN}
             WHERE a.hotel_id = $1 AND a.referral_code = $2
            """,
            hotel_id,
            referral_code,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(affiliate_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            f"""
            SELECT a.*,
                   h.default_affiliate_commission_pct AS default_commission_pct,
                   COALESCE(a.commission_pct_override, h.default_affiliate_commission_pct)
                       AS effective_commission_pct,
                   {_PAYOUT_COLUMNS}
              FROM affiliates a
              JOIN hotels h ON h.id = a.hotel_id
              {_PAYOUT_JOIN}
             WHERE a.id = $1
            """,
            affiliate_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_user_id(user_id: str) -> List[dict]:
        """List all affiliate records linked to a given auth user."""
        rows = await Database.fetch(
            f"""
            SELECT a.*,
                   h.name AS hotel_name,
                   h.slug AS hotel_slug,
                   h.default_affiliate_commission_pct AS default_commission_pct,
                   COALESCE(a.commission_pct_override, h.default_affiliate_commission_pct)
                       AS effective_commission_pct,
                   {_PAYOUT_COLUMNS},
                   COALESCE(s.booking_count, 0) AS booking_count,
                   COALESCE(s.total_revenue, 0) AS total_revenue,
                   COALESCE(c.click_count, 0) AS click_count
            FROM affiliates a
            JOIN hotels h ON h.id = a.hotel_id
            {_PAYOUT_JOIN}
            LEFT JOIN (
                SELECT affiliate_id,
                       COUNT(*) AS booking_count,
                       SUM(total_amount) AS total_revenue
                FROM bookings
                WHERE affiliate_id IS NOT NULL
                GROUP BY affiliate_id
            ) s ON s.affiliate_id = a.id
            LEFT JOIN (
                SELECT affiliate_id,
                       COUNT(*) AS click_count
                FROM affiliate_clicks
                GROUP BY affiliate_id
            ) c ON c.affiliate_id = a.id
            WHERE a.user_id = $1 AND a.status = 'approved'
            ORDER BY a.created_at DESC
            """,
            user_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_by_hotel_id(
        hotel_id: str,
        *,
        status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[dict]:
        conditions = ["a.hotel_id = $1"]
        args: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"a.status = ${idx}")
            args.append(status)
            idx += 1

        where = " AND ".join(conditions)
        args.extend([limit, offset])
        rows = await Database.fetch(
            f"""
            SELECT a.*,
                   h.default_affiliate_commission_pct AS default_commission_pct,
                   COALESCE(a.commission_pct_override, h.default_affiliate_commission_pct)
                       AS effective_commission_pct,
                   {_PAYOUT_COLUMNS},
                   COALESCE(s.booking_count, 0) AS booking_count,
                   COALESCE(s.total_revenue, 0) AS total_revenue,
                   COALESCE(c.click_count, 0) AS click_count
            FROM affiliates a
            JOIN hotels h ON h.id = a.hotel_id
            {_PAYOUT_JOIN}
            LEFT JOIN (
                SELECT affiliate_id,
                       COUNT(*) AS booking_count,
                       SUM(total_amount) AS total_revenue
                FROM bookings
                WHERE affiliate_id IS NOT NULL
                GROUP BY affiliate_id
            ) s ON s.affiliate_id = a.id
            LEFT JOIN (
                SELECT affiliate_id,
                       COUNT(*) AS click_count
                FROM affiliate_clicks
                GROUP BY affiliate_id
            ) c ON c.affiliate_id = a.id
            WHERE {where}
            ORDER BY a.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *args,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def record_click(
        affiliate_id: str,
        hotel_id: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> None:
        await Database.execute(
            """
            INSERT INTO affiliate_clicks (affiliate_id, hotel_id, ip_address, user_agent)
            VALUES ($1, $2, $3, $4)
            """,
            affiliate_id,
            hotel_id,
            ip_address,
            user_agent,
        )

    @staticmethod
    async def count_by_hotel_id(
        hotel_id: str, *, status: Optional[str] = None
    ) -> int:
        if status:
            count = await Database.fetchval(
                "SELECT COUNT(*) FROM affiliates WHERE hotel_id = $1 AND status = $2",
                hotel_id,
                status,
            )
        else:
            count = await Database.fetchval(
                "SELECT COUNT(*) FROM affiliates WHERE hotel_id = $1", hotel_id
            )
        return count or 0

    @staticmethod
    async def update_status(affiliate_id: str, new_status: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE affiliates SET status = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            affiliate_id,
            new_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def set_commission_override(
        affiliate_id: str, commission_pct: Optional[float]
    ) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE affiliates SET commission_pct_override = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            affiliate_id,
            commission_pct,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_effective_commission_pct(affiliate_id: str) -> Optional[float]:
        """Return the affiliate's effective commission (override, else hotel default)."""
        row = await Database.fetchrow(
            """
            SELECT COALESCE(a.commission_pct_override, h.default_affiliate_commission_pct)
                   AS effective_pct
              FROM affiliates a
              JOIN hotels h ON h.id = a.hotel_id
             WHERE a.id = $1
            """,
            affiliate_id,
        )
        return float(row["effective_pct"]) if row else None

    @staticmethod
    async def update_stripe_connect(affiliate_id: str, account_id: str) -> Optional[dict]:
        """Set the Stripe Connect account on the affiliate row, and flip the
        canonical payment_method to 'stripe' for the owning user."""
        row = await Database.fetchrow(
            """
            UPDATE affiliates
            SET stripe_connect_account_id = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            affiliate_id,
            account_id,
        )
        if not row:
            return None
        if row["user_id"]:
            await AffiliatePayoutSettingsRepository.upsert(
                str(row["user_id"]), {"payment_method": "stripe"}
            )
        return dict(row)

    @staticmethod
    async def mark_stripe_onboarded(stripe_connect_account_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE affiliates
            SET stripe_connect_onboarded = true, updated_at = now()
            WHERE stripe_connect_account_id = $1
            RETURNING *
            """,
            stripe_connect_account_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_stripe_account_id(account_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            f"""
            SELECT a.*, {_PAYOUT_COLUMNS}
              FROM affiliates a
              {_PAYOUT_JOIN}
             WHERE a.stripe_connect_account_id = $1
            """,
            account_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_xendit_details(
        affiliate_id: str,
        channel_code: str,
        account_number: str,
        account_holder_name: str,
    ) -> Optional[dict]:
        """Write Xendit bank details to the canonical payout settings for
        the owning user. The affiliate row is unchanged — these fields no
        longer live there."""
        affiliate = await Database.fetchrow(
            "SELECT * FROM affiliates WHERE id = $1", affiliate_id
        )
        if not affiliate:
            return None
        if not affiliate["user_id"]:
            raise ValueError(
                "Affiliate has no linked user_id; cannot save payout settings"
            )
        await AffiliatePayoutSettingsRepository.upsert(
            str(affiliate["user_id"]),
            {
                "payment_method": "xendit",
                "xendit_channel_code": channel_code,
                "xendit_account_number": account_number,
                "xendit_account_holder_name": account_holder_name,
            },
        )
        return await AffiliateRepository.get_by_id(affiliate_id)
