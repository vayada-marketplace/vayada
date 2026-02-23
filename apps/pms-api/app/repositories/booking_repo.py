import secrets
import string
from typing import Optional, List
from app.database import Database


def generate_booking_reference() -> str:
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(secrets.choice(chars) for _ in range(6))
    return f"VAY-{suffix}"


class BookingRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        # Generate unique reference
        for _ in range(10):
            ref = generate_booking_reference()
            existing = await Database.fetchval(
                "SELECT 1 FROM bookings WHERE booking_reference = $1", ref
            )
            if not existing:
                break
        else:
            raise RuntimeError("Could not generate unique booking reference")

        row = await Database.fetchrow(
            """
            INSERT INTO bookings (
                hotel_id, room_type_id, booking_reference,
                guest_first_name, guest_last_name, guest_email, guest_phone,
                special_requests, check_in, check_out,
                adults, children, nightly_rate, total_amount, currency,
                affiliate_id, referral_code
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
            ) RETURNING *
            """,
            data["hotel_id"],
            data["room_type_id"],
            ref,
            data["guest_first_name"],
            data["guest_last_name"],
            data["guest_email"],
            data["guest_phone"],
            data.get("special_requests", ""),
            data["check_in"],
            data["check_out"],
            data.get("adults", 1),
            data.get("children", 0),
            data["nightly_rate"],
            data["total_amount"],
            data["currency"],
            data.get("affiliate_id"),
            data.get("referral_code"),
        )
        return dict(row)

    @staticmethod
    async def get_by_id(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT b.*, rt.name AS room_name, h.name AS hotel_name
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            JOIN hotels h ON h.id = b.hotel_id
            WHERE b.id = $1
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def lookup(booking_reference: str, guest_email: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT b.*, rt.name AS room_name, h.name AS hotel_name
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            JOIN hotels h ON h.id = b.hotel_id
            WHERE b.booking_reference = $1
              AND LOWER(b.guest_email) = LOWER($2)
            """,
            booking_reference,
            guest_email,
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
        conditions = ["b.hotel_id = $1"]
        args: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"b.status = ${idx}")
            args.append(status)
            idx += 1

        where = " AND ".join(conditions)
        args.extend([limit, offset])
        rows = await Database.fetch(
            f"""
            SELECT b.*, rt.name AS room_name
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            WHERE {where}
            ORDER BY b.created_at DESC
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
                "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1 AND status = $2",
                hotel_id,
                status,
            )
        else:
            count = await Database.fetchval(
                "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1", hotel_id
            )
        return count or 0

    @staticmethod
    async def list_by_hotel_in_range(
        hotel_id: str, start_date, end_date
    ) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT b.*, rt.name AS room_name
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            WHERE b.hotel_id = $1
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
            ORDER BY b.check_in
            """,
            hotel_id,
            start_date,
            end_date,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_status(booking_id: str, new_status: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET status = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
            new_status,
        )
        return dict(row) if row else None
