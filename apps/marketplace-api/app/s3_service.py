"""
AWS S3 service for file uploads and URL generation
"""
import boto3
import logging
from typing import Optional
from botocore.exceptions import ClientError, NoCredentialsError
from app.config import settings

logger = logging.getLogger(__name__)

# Initialize S3 client
_s3_client: Optional[boto3.client] = None


def get_s3_client():
    """Get or create S3 client"""
    global _s3_client
    
    if _s3_client is None:
        try:
            if settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY:
                _s3_client = boto3.client(
                    's3',
                    region_name=settings.AWS_REGION,
                    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
                    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY
                )
            else:
                # Try to use default credentials (e.g., from IAM role or ~/.aws/credentials)
                _s3_client = boto3.client('s3', region_name=settings.AWS_REGION)
                logger.info("Using default AWS credentials for S3")
        except NoCredentialsError:
            logger.error("AWS credentials not found")
            raise
    
    return _s3_client


async def upload_file_to_s3(
    file_content: bytes,
    file_key: str,
    content_type: str = "image/jpeg",
    make_public: bool = True
) -> str:
    """
    Upload a file to S3 and return the URL
    
    Args:
        file_content: File content as bytes
        file_key: S3 object key (path in bucket)
        content_type: MIME type of the file
        make_public: Whether to make the file publicly accessible
    
    Returns:
        Public URL of the uploaded file
    """
    try:
        s3_client = get_s3_client()
        
        # Upload file
        extra_args = {
            'ContentType': content_type,
        }
        
        # Note: ACL is not set because the bucket doesn't allow ACLs
        # Public access is handled by bucket policy instead
        
        s3_client.put_object(
            Bucket=settings.S3_BUCKET_NAME,
            Key=file_key,
            Body=file_content,
            **extra_args
        )
        
        # Generate URL
        if settings.S3_USE_PUBLIC_URLS and make_public:
            # Public URL format
            url = f"https://{settings.S3_BUCKET_NAME}.s3.{settings.AWS_REGION}.amazonaws.com/{file_key}"
        else:
            # Generate signed URL
            url = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': settings.S3_BUCKET_NAME, 'Key': file_key},
                ExpiresIn=settings.S3_PUBLIC_URL_EXPIRY
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
    """
    Delete a file from S3
    
    Args:
        file_key: S3 object key (path in bucket)
    
    Returns:
        True if successful, False otherwise
    """
    try:
        s3_client = get_s3_client()
        s3_client.delete_object(
            Bucket=settings.S3_BUCKET_NAME,
            Key=file_key
        )
        logger.info(f"File deleted from S3: {file_key}")
        return True
    except ClientError as e:
        logger.error(f"Error deleting file from S3: {e}")
        return False


async def list_objects_in_prefix(prefix: str) -> list[str]:
    """
    List all object keys in an S3 prefix (folder)
    
    Args:
        prefix: S3 prefix (folder path), e.g., "creators/user_id/" or "listings/user_id/"
    
    Returns:
        List of object keys (file paths) in the prefix
    """
    try:
        s3_client = get_s3_client()
        object_keys = []
        
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(
            Bucket=settings.S3_BUCKET_NAME,
            Prefix=prefix
        )
        
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    object_keys.append(obj['Key'])
        
        return object_keys
    except ClientError as e:
        logger.error(f"Error listing objects in S3 prefix {prefix}: {e}")
        return []


async def delete_all_objects_in_prefix(prefix: str) -> dict:
    """
    Delete all objects in an S3 prefix (folder)
    
    Args:
        prefix: S3 prefix (folder path), e.g., "creators/user_id/" or "listings/user_id/"
    
    Returns:
        Dictionary with deletion statistics:
        {
            "deleted_count": int,
            "failed_count": int,
            "total_objects": int
        }
    """
    object_keys = await list_objects_in_prefix(prefix)
    
    if not object_keys:
        return {
            "deleted_count": 0,
            "failed_count": 0,
            "total_objects": 0
        }
    
    deleted_count = 0
    failed_count = 0
    
    try:
        s3_client = get_s3_client()
        
        # Delete objects in batches (S3 allows up to 1000 objects per delete request)
        batch_size = 1000
        for i in range(0, len(object_keys), batch_size):
            batch = object_keys[i:i + batch_size]
            
            # Prepare delete request
            delete_objects = [{'Key': key} for key in batch]
            
            try:
                response = s3_client.delete_objects(
                    Bucket=settings.S3_BUCKET_NAME,
                    Delete={
                        'Objects': delete_objects,
                        'Quiet': True
                    }
                )
                
                # Count successful deletions
                if 'Deleted' in response:
                    deleted_count += len(response['Deleted'])
                
                # Count errors
                if 'Errors' in response:
                    failed_count += len(response['Errors'])
                    for error in response['Errors']:
                        logger.warning(f"Failed to delete {error['Key']}: {error.get('Message', 'Unknown error')}")
                
            except ClientError as e:
                logger.error(f"Error deleting batch from S3: {e}")
                failed_count += len(batch)
        
        logger.info(f"Deleted {deleted_count} objects from S3 prefix {prefix} (failed: {failed_count}, total: {len(object_keys)})")
        
    except Exception as e:
        logger.error(f"Unexpected error deleting objects from S3 prefix {prefix}: {e}")
        failed_count = len(object_keys)
    
    return {
        "deleted_count": deleted_count,
        "failed_count": failed_count,
        "total_objects": len(object_keys)
    }


def generate_file_key(prefix: str, filename: str, user_id: Optional[str] = None) -> str:
    """
    Generate a unique S3 file key
    
    Args:
        prefix: Folder prefix (e.g., 'hotels', 'creators', 'listings')
        filename: Original filename
        user_id: Optional user ID for organization
    
    Returns:
        S3 object key
    """
    import uuid
    from datetime import datetime, timezone
    
    # Extract file extension
    file_ext = filename.split('.')[-1] if '.' in filename else 'jpg'
    
    # Generate unique filename
    unique_id = uuid.uuid4().hex[:8]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    safe_filename = f"{timestamp}_{unique_id}.{file_ext}"
    
    # Build key path
    if user_id:
        key = f"{prefix}/{user_id}/{safe_filename}"
    else:
        key = f"{prefix}/{safe_filename}"
    
    return key


def extract_key_from_url(url: str) -> Optional[str]:
    """
    Extract S3 key from a URL
    
    Args:
        url: S3 URL
    
    Returns:
        S3 key or None if URL is not an S3 URL
    """
    # Handle public S3 URLs: https://bucket-name.s3.region.amazonaws.com/key
    if f"{settings.S3_BUCKET_NAME}.s3" in url:
        parts = url.split(f"{settings.S3_BUCKET_NAME}.s3.{settings.AWS_REGION}.amazonaws.com/")
        if len(parts) == 2:
            return parts[1]
    
    # Handle signed URLs (more complex, would need to parse)
    # For now, return None for signed URLs
    return None

