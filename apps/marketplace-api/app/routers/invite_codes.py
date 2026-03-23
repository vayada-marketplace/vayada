"""
Invite codes for hotel onboarding.

vayada admins create invite codes pre-filled with hotel setup data.
Hotel owners enter the code on the setup page to prefill all fields.
"""

import json
import logging
import secrets
import string
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status as http_status, Depends
from pydantic import BaseModel
from typing import Optional

from app.database import Database
from app.dependencies import get_current_user_id
from app.repositories.user_repo import UserRepository

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Dependencies ────────────────────────────────────────────────


async def get_admin_user(user_id: str = Depends(get_current_user_id)) -> str:
    user = await UserRepository.get_by_id(user_id, columns="id, type, status")
    if not user:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="User not found")
    if user["type"] != "admin":
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Admin access required")
    if user["status"] == "suspended":
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Account suspended")
    return str(user["id"])


# ── Models ──────────────────────────────────────────────────────


class CreateInviteRequest(BaseModel):
    data: dict


class InviteCodeResponse(BaseModel):
    id: str
    code: str
    status: str
    created_at: str
    expires_at: str
    hotel_name: Optional[str] = None
    redeemed_at: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────


def _generate_code() -> str:
    chars = string.ascii_uppercase + string.digits
    part1 = "".join(secrets.choice(chars) for _ in range(4))
    part2 = "".join(secrets.choice(chars) for _ in range(4))
    return f"{part1}-{part2}"


def _row_to_response(row: dict) -> InviteCodeResponse:
    data = row.get("data") or {}
    if isinstance(data, str):
        data = json.loads(data)
    return InviteCodeResponse(
        id=str(row["id"]),
        code=row["code"],
        status=row["status"],
        created_at=row["created_at"].isoformat() if row["created_at"] else "",
        expires_at=row["expires_at"].isoformat() if row["expires_at"] else "",
        hotel_name=data.get("property", {}).get("property_name"),
        redeemed_at=row["redeemed_at"].isoformat() if row.get("redeemed_at") else None,
    )


# ── Admin endpoints ─────────────────────────────────────────────


@router.post("/admin/invite-codes", status_code=201)
async def create_invite_code(
    body: CreateInviteRequest,
    admin_id: str = Depends(get_admin_user),
):
    code = _generate_code()
    # Ensure unique
    for _ in range(10):
        existing = await Database.fetchval(
            "SELECT 1 FROM invite_codes WHERE code = $1", code
        )
        if not existing:
            break
        code = _generate_code()

    row = await Database.fetchrow(
        """
        INSERT INTO invite_codes (code, data, created_by)
        VALUES ($1, $2::jsonb, $3)
        RETURNING *
        """,
        code,
        json.dumps(body.data),
        admin_id,
    )
    return _row_to_response(dict(row))


@router.get("/admin/invite-codes")
async def list_invite_codes(
    admin_id: str = Depends(get_admin_user),
):
    rows = await Database.fetch(
        "SELECT * FROM invite_codes ORDER BY created_at DESC"
    )
    return [_row_to_response(dict(r)) for r in rows]


@router.delete("/admin/invite-codes/{invite_id}", status_code=204)
async def delete_invite_code(
    invite_id: str,
    admin_id: str = Depends(get_admin_user),
):
    result = await Database.execute(
        "DELETE FROM invite_codes WHERE id = $1", invite_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Invite code not found")


# ── Public endpoints ────────────────────────────────────────────


@router.get("/api/invite-codes/{code}")
async def get_invite_code(code: str):
    row = await Database.fetchrow(
        "SELECT * FROM invite_codes WHERE code = $1", code.upper().strip()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Invalid invite code")

    if row["status"] == "redeemed":
        raise HTTPException(status_code=410, detail="This invite code has already been used")

    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        await Database.execute(
            "UPDATE invite_codes SET status = 'expired' WHERE id = $1", row["id"]
        )
        raise HTTPException(status_code=410, detail="This invite code has expired")

    data = row["data"]
    if isinstance(data, str):
        data = json.loads(data)

    return {"code": row["code"], "data": data}


@router.post("/api/invite-codes/{code}/redeem")
async def redeem_invite_code(code: str, user_id: str = Depends(get_current_user_id)):
    row = await Database.fetchrow(
        "SELECT * FROM invite_codes WHERE code = $1", code.upper().strip()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Invalid invite code")

    if row["status"] != "pending":
        raise HTTPException(status_code=410, detail="This invite code is no longer valid")

    await Database.execute(
        """
        UPDATE invite_codes
        SET status = 'redeemed', redeemed_by = $1, redeemed_at = NOW()
        WHERE id = $2
        """,
        user_id,
        row["id"],
    )
    return {"status": "redeemed"}
