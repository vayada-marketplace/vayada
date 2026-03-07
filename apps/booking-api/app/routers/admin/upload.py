import base64
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request, status
from pydantic import BaseModel

from app.dependencies import require_hotel_admin
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


class ImageUploadRequest(BaseModel):
    filename: str
    content_type: Optional[str] = "image/jpeg"
    data: str  # base64-encoded image


@router.post("/upload/images", status_code=201)
async def proxy_upload_images(
    body: ImageUploadRequest,
    request: Request,
    user_id: str = Depends(require_hotel_admin),
):
    auth_header = request.headers.get("authorization", "")
    pms_url = f"{settings.PMS_API_URL}/upload/images"
    file_content = base64.b64decode(body.data)

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            pms_url,
            files=[("files", (body.filename, file_content, body.content_type))],
            headers={"Authorization": auth_header},
        )

    if resp.status_code >= 400:
        logger.error(f"PMS upload failed: status={resp.status_code}, body={resp.text}")
        raise HTTPException(status_code=resp.status_code, detail=f"PMS upload error: {resp.text}")

    return resp.json()
