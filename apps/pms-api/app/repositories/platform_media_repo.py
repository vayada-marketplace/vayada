"""Platform media persistence helpers used by PMS-owned commands."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from uuid import uuid4

from app.config import settings
from app.database import Database
from app.s3_service import upload_file_to_s3

PMS_MESSAGING_ATTACHMENT_PURPOSE = "pms.messaging.attachment"
PROVIDER_ORIGINAL_VARIANT = "provider_original"


def normalize_attachment_content_type(content_type: str | None) -> str:
    normalized = (content_type or "application/octet-stream").lower().split(";")[0].strip()
    return "image/jpeg" if normalized == "image/jpg" else normalized


def _safe_filename(filename: str | None) -> str:
    base = PurePosixPath((filename or "attachment").replace("\\", "/")).name.strip()
    if not base or base in {".", ".."}:
        base = "attachment"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", base)[:180]


@dataclass(frozen=True)
class PlatformMediaAttachment:
    media_id: str
    storage_key: str | None
    filename: str | None
    content_type: str | None
    size_bytes: int | None


class PlatformMediaAttachmentRepository:
    @staticmethod
    async def store_private_attachment(
        *,
        property_id: str,
        thread_id: str,
        actor_user_id: str,
        file_bytes: bytes,
        filename: str | None,
        content_type: str | None,
    ) -> PlatformMediaAttachment:
        """Store outbound PMS attachment bytes as private platform media."""
        if not settings.S3_BUCKET_NAME:
            raise RuntimeError("Platform media storage is not configured")

        media_id = str(uuid4())
        safe_filename = _safe_filename(filename)
        normalized_content_type = normalize_attachment_content_type(content_type)
        storage_key = (
            f"private/pms/properties/{property_id}/messages/{thread_id}/{media_id}/{safe_filename}"
        )
        size_bytes = len(file_bytes)
        checksum = hashlib.sha256(file_bytes).hexdigest()

        await upload_file_to_s3(
            file_bytes,
            storage_key,
            content_type=normalized_content_type,
            make_public=False,
        )

        source_metadata = {
            "threadId": thread_id,
            "filename": safe_filename,
            "sourceProvider": "channex",
        }
        await Database.fetchrow(
            """
            INSERT INTO platform.media_objects (
                id, bucket, storage_key, storage_kind, visibility, purpose,
                property_id, resource_product, resource_type, resource_id,
                lifecycle_status, content_type, size_bytes, checksum_sha256,
                original_filename, source_system, source_metadata,
                public_approved, created_by_user_id
            )
            VALUES (
                $1, $2, $3, 'vayada_managed', 'private', $4,
                $5, 'pms', 'message_thread', $6,
                'staged', $7, $8, $9,
                $10, 'pms', $11::jsonb,
                false, $12
            )
            RETURNING id
            """,
            media_id,
            settings.S3_BUCKET_NAME,
            storage_key,
            PMS_MESSAGING_ATTACHMENT_PURPOSE,
            property_id,
            thread_id,
            normalized_content_type,
            size_bytes,
            checksum,
            safe_filename,
            json.dumps(source_metadata),
            actor_user_id,
        )
        await Database.fetchrow(
            """
            INSERT INTO platform.media_variants (
                media_object_id, variant_name, visibility, storage_key,
                content_type, size_bytes, checksum_sha256
            )
            VALUES ($1, $2, 'private', $3, $4, $5, $6)
            RETURNING id
            """,
            media_id,
            PROVIDER_ORIGINAL_VARIANT,
            storage_key,
            normalized_content_type,
            size_bytes,
            checksum,
        )
        return PlatformMediaAttachment(
            media_id=media_id,
            storage_key=storage_key,
            filename=safe_filename,
            content_type=normalized_content_type,
            size_bytes=size_bytes,
        )

    @staticmethod
    async def record_provider_attachment_id(
        *,
        media_id: str,
        source_attachment_id: str,
    ) -> None:
        await Database.execute(
            """
            UPDATE platform.media_objects
            SET source_metadata = source_metadata || jsonb_build_object(
                    'sourceAttachmentId', $2
                ),
                updated_at = now()
            WHERE id = $1
            """,
            media_id,
            source_attachment_id,
        )

    @staticmethod
    async def find_by_provider_attachment_id(
        *,
        property_id: str,
        thread_id: str,
        source_attachment_id: str,
    ) -> PlatformMediaAttachment | None:
        row = await Database.fetchrow(
            """
            SELECT
              id,
              storage_key,
              original_filename,
              content_type,
              size_bytes
            FROM platform.media_objects
            WHERE purpose = $1
              AND visibility = 'private'
              AND property_id = $2
              AND resource_type = 'message_thread'
              AND resource_id = $3
              AND source_metadata->>'sourceAttachmentId' = $4
            ORDER BY created_at DESC
            LIMIT 1
            """,
            PMS_MESSAGING_ATTACHMENT_PURPOSE,
            property_id,
            thread_id,
            source_attachment_id,
        )
        if not row:
            return None
        data = dict(row)
        return PlatformMediaAttachment(
            media_id=str(data["id"]),
            storage_key=data.get("storage_key"),
            filename=data.get("original_filename"),
            content_type=data.get("content_type"),
            size_bytes=int(data["size_bytes"]) if data.get("size_bytes") is not None else None,
        )

    @staticmethod
    async def link_message_attachment(
        *,
        media_id: str,
        message_attachment_id: str,
    ) -> None:
        await Database.execute(
            """
            UPDATE platform.media_objects
            SET source_table = 'message_attachments',
                source_row_id = $2,
                updated_at = now()
            WHERE id = $1
            """,
            media_id,
            message_attachment_id,
        )

    @staticmethod
    async def create_provider_external_reference(
        *,
        property_id: str,
        thread_id: str,
        message_attachment_id: str,
        source_attachment_id: str | None,
        source_url: str,
        filename: str | None,
        content_type: str | None,
        size_bytes: int | None,
    ) -> PlatformMediaAttachment:
        media_id = str(uuid4())
        safe_filename = _safe_filename(filename)
        normalized_content_type = normalize_attachment_content_type(content_type)
        source_metadata = {
            "threadId": thread_id,
            "sourceProvider": "channex",
        }
        if source_attachment_id:
            source_metadata["sourceAttachmentId"] = source_attachment_id

        await Database.fetchrow(
            """
            INSERT INTO platform.media_objects (
                id, bucket, storage_key, storage_kind, visibility, purpose,
                property_id, resource_product, resource_type, resource_id,
                lifecycle_status, content_type, size_bytes, original_filename,
                source_url, source_system, source_table, source_row_id,
                source_metadata, public_approved
            )
            VALUES (
                $1, NULL, NULL, 'external_reference', 'private', $2,
                $3, 'pms', 'message_thread', $4,
                'external_reference', $5, $6, $7,
                $8, 'pms', 'message_attachments', $9,
                $10::jsonb, false
            )
            RETURNING id
            """,
            media_id,
            PMS_MESSAGING_ATTACHMENT_PURPOSE,
            property_id,
            thread_id,
            normalized_content_type,
            size_bytes,
            safe_filename,
            source_url,
            message_attachment_id,
            json.dumps(source_metadata),
        )
        return PlatformMediaAttachment(
            media_id=media_id,
            storage_key=None,
            filename=safe_filename,
            content_type=normalized_content_type,
            size_bytes=size_bytes,
        )
