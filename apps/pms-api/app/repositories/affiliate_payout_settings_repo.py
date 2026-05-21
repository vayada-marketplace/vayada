from app.database import Database

# Columns we treat as the canonical payout configuration. Exposed here so
# the route layer and the affiliates-mirror update use the same list.
PAYOUT_COLUMNS = (
    "payment_method",
    "paypal_email",
    "bank_iban",
    "bank_account_holder",
    "bank_swift_bic",
    "bank_name",
    "bank_country",
    "xendit_channel_code",
    "xendit_account_number",
    "xendit_account_holder_name",
)

# When no row exists yet (new affiliate before first save) we return
# this so the settings page can render without a special-case.
DEFAULT_SETTINGS = {
    "payment_method": "stripe",
    "paypal_email": "",
    "bank_iban": "",
    "bank_account_holder": "",
    "bank_swift_bic": "",
    "bank_name": "",
    "bank_country": "",
    "xendit_channel_code": None,
    "xendit_account_number": None,
    "xendit_account_holder_name": None,
}


class AffiliatePayoutSettingsRepository:
    @staticmethod
    async def get_by_user_id(user_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM affiliate_payout_settings WHERE user_id = $1",
            user_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_or_default(user_id: str) -> dict:
        row = await AffiliatePayoutSettingsRepository.get_by_user_id(user_id)
        if row:
            return row
        return {"user_id": user_id, **DEFAULT_SETTINGS}

    @staticmethod
    async def upsert(user_id: str, updates: dict) -> dict:
        """Insert or update the canonical payout settings for a user.

        `updates` may contain any subset of PAYOUT_COLUMNS. Missing
        columns keep their current value (or default on first insert).
        """
        if not updates:
            return await AffiliatePayoutSettingsRepository.get_or_default(user_id)

        unknown = set(updates) - set(PAYOUT_COLUMNS)
        if unknown:
            raise ValueError(f"Unknown payout settings columns: {sorted(unknown)}")

        cols = list(updates.keys())
        col_list = ", ".join(cols)
        placeholders = ", ".join(f"${i + 2}" for i in range(len(cols)))
        set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)

        row = await Database.fetchrow(
            f"""
            INSERT INTO affiliate_payout_settings (user_id, {col_list})
            VALUES ($1, {placeholders})
            ON CONFLICT (user_id) DO UPDATE
                SET {set_clause}, updated_at = now()
            RETURNING *
            """,
            user_id,
            *(updates[c] for c in cols),
        )
        return dict(row)
