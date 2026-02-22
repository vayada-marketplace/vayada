import secrets
import string
from typing import Optional, List
from app.database import Database


def generate_referral_code() -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(8))


class AffiliateRepository:

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        # Generate unique referral code
        for _ in range(10):
            code = generate_referral_code()
            existing = await Database.fetchval(
                "SELECT 1 FROM affiliates WHERE hotel_id = $1 AND referral_code = $2",
                hotel_id,
                code,
            )
            if not existing:
                break
        else:
            raise RuntimeError("Could not generate unique referral code")

        row = await Database.fetchrow(
            """
            INSERT INTO affiliates (
                hotel_id, referral_code, full_name, email,
                social_media, user_type, payment_method,
                paypal_email, bank_iban
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9
            ) RETURNING *
            """,
            hotel_id,
            code,
            data["full_name"],
            data["email"],
            data.get("social_media", ""),
            data.get("user_type", "guest"),
            data.get("payment_method", "paypal"),
            data.get("paypal_email", ""),
            data.get("bank_iban", ""),
        )
        return dict(row)

    @staticmethod
    async def get_by_code(hotel_id: str, referral_code: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM affiliates WHERE hotel_id = $1 AND referral_code = $2",
            hotel_id,
            referral_code,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(affiliate_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM affiliates WHERE id = $1",
            affiliate_id,
        )
        return dict(row) if row else None

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
                   COALESCE(s.booking_count, 0) AS booking_count,
                   COALESCE(s.total_revenue, 0) AS total_revenue
            FROM affiliates a
            LEFT JOIN (
                SELECT affiliate_id,
                       COUNT(*) AS booking_count,
                       SUM(total_amount) AS total_revenue
                FROM bookings
                WHERE affiliate_id IS NOT NULL
                GROUP BY affiliate_id
            ) s ON s.affiliate_id = a.id
            WHERE {where}
            ORDER BY a.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *args,
        )
        return [dict(r) for r in rows]

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
    async def update_commission(affiliate_id: str, commission_pct: float) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE affiliates SET commission_pct = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            affiliate_id,
            commission_pct,
        )
        return dict(row) if row else None
