"""
AWS S3 service for file uploads
"""

import logging
import uuid
from datetime import UTC, datetime

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

from app.config import settings

logger = logging.getLogger(__name__)

_s3_client: boto3.client | None = None


def get_s3_client():
    global _s3_client

    if _s3_client is None:
        try:
            kwargs = {
                "region_name": settings.AWS_REGION,
            }
            if settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY:
                kwargs["aws_access_key_id"] = settings.AWS_ACCESS_KEY_ID
                kwargs["aws_secret_access_key"] = settings.AWS_SECRET_ACCESS_KEY
            if settings.S3_ENDPOINT_URL:
                kwargs["endpoint_url"] = settings.S3_ENDPOINT_URL
            _s3_client = boto3.client("s3", **kwargs)
        except NoCredentialsError:
            logger.error("AWS credentials not found")
            raise

    return _s3_client


async def upload_file_to_s3(
    file_content: bytes, file_key: str, content_type: str = "image/jpeg", make_public: bool = True
) -> str:
    try:
        s3_client = get_s3_client()

        extra_args = {
            "ContentType": content_type,
        }

        s3_client.put_object(
            Bucket=settings.S3_BUCKET_NAME, Key=file_key, Body=file_content, **extra_args
        )

        if settings.S3_USE_PUBLIC_URLS and make_public:
            if settings.S3_PUBLIC_URL:
                url = f"{settings.S3_PUBLIC_URL}/{settings.S3_BUCKET_NAME}/{file_key}"
            else:
                url = f"https://{settings.S3_BUCKET_NAME}.s3.{settings.AWS_REGION}.amazonaws.com/{file_key}"
        else:
            url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": settings.S3_BUCKET_NAME, "Key": file_key},
                ExpiresIn=settings.S3_PUBLIC_URL_EXPIRY,
            )

        logger.info(f"File uploaded to S3: {file_key}")
        return url

    except ClientError as e:
        logger.error(f"Error uploading file to S3: {e}")
        raise Exception(f"Failed to upload file to S3: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error uploading to S3: {e}")
        raise


async def delete_file_from_s3(file_key: str) -> bool:
    try:
        s3_client = get_s3_client()
        s3_client.delete_object(Bucket=settings.S3_BUCKET_NAME, Key=file_key)
        logger.info(f"File deleted from S3: {file_key}")
        return True
    except ClientError as e:
        logger.error(f"Error deleting file from S3: {e}")
        return False


def generate_file_key(prefix: str, filename: str, user_id: str | None = None) -> str:
    file_ext = filename.split(".")[-1] if "." in filename else "jpg"
    unique_id = uuid.uuid4().hex[:8]
    timestamp = datetime.now(UTC).strftime("%Y%m%d")
    safe_filename = f"{timestamp}_{unique_id}.{file_ext}"

    if user_id:
        key = f"{prefix}/{user_id}/{safe_filename}"
    else:
        key = f"{prefix}/{safe_filename}"

    return key
