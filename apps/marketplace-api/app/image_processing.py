"""
Image validation and processing utilities
"""
import io
import logging
from typing import Tuple, Optional
from PIL import Image
from app.config import settings

logger = logging.getLogger(__name__)


def validate_image(
    file_content: bytes,
    filename: str,
    content_type: Optional[str] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate an image file
    
    Args:
        file_content: Image file content as bytes
        filename: Original filename
        content_type: MIME type (optional, will be inferred if not provided)
    
    Returns:
        Tuple of (is_valid, error_message)
    """
    # Check file size
    max_size_bytes = settings.MAX_IMAGE_SIZE_MB * 1024 * 1024
    if len(file_content) > max_size_bytes:
        return False, f"Image size exceeds maximum allowed size of {settings.MAX_IMAGE_SIZE_MB}MB"
    
    # Check file type
    try:
        image = Image.open(io.BytesIO(file_content))
        image_format = image.format
        
        # Validate format
        valid_formats = {'JPEG', 'PNG', 'WEBP'}
        if image_format not in valid_formats:
            return False, f"Invalid image format. Allowed formats: JPEG, PNG, WEBP"
        
        # Validate dimensions
        # If resizing is enabled, allow larger images (they'll be resized anyway)
        # But still enforce a reasonable maximum to prevent memory issues
        width, height = image.size
        
        # If resizing is enabled, use a more lenient limit (10x the resize target)
        # Otherwise use the configured max dimensions
        if settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0:
            # Allow up to 10x the resize target (e.g., 19200x19200 if resizing to 1920x1920)
            max_allowed_width = max(settings.MAX_IMAGE_WIDTH, settings.IMAGE_RESIZE_WIDTH * 10) if settings.IMAGE_RESIZE_WIDTH > 0 else settings.MAX_IMAGE_WIDTH
            max_allowed_height = max(settings.MAX_IMAGE_HEIGHT, settings.IMAGE_RESIZE_HEIGHT * 10) if settings.IMAGE_RESIZE_HEIGHT > 0 else settings.MAX_IMAGE_HEIGHT
        else:
            max_allowed_width = settings.MAX_IMAGE_WIDTH
            max_allowed_height = settings.MAX_IMAGE_HEIGHT
        
        if width > max_allowed_width or height > max_allowed_height:
            return False, f"Image dimensions exceed maximum allowed size ({max_allowed_width}x{max_allowed_height})"
        
        # Validate content type if provided
        if content_type:
            valid_content_types = settings.ALLOWED_IMAGE_TYPES
            if content_type not in valid_content_types:
                return False, f"Invalid content type. Allowed types: {', '.join(valid_content_types)}"
        
        return True, None
        
    except Exception as e:
        logger.error(f"Error validating image: {e}")
        return False, f"Invalid image file: {str(e)}"


def process_image(
    file_content: bytes,
    resize_width: Optional[int] = None,
    resize_height: Optional[int] = None,
    quality: int = 85,
    format: str = "JPEG"
) -> bytes:
    """
    Process an image (resize, optimize)
    
    Args:
        file_content: Original image content as bytes
        resize_width: Target width (None = maintain aspect ratio)
        resize_height: Target height (None = maintain aspect ratio)
        quality: JPEG quality (1-100, default: 85)
        format: Output format (JPEG, PNG, WEBP)
    
    Returns:
        Processed image content as bytes
    """
    try:
        # Open image
        image = Image.open(io.BytesIO(file_content))
        
        # Convert RGBA to RGB for JPEG
        if format == "JPEG" and image.mode in ("RGBA", "LA", "P"):
            # Create white background
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(image, mask=image.split()[-1] if image.mode == "RGBA" else None)
            image = background
        elif image.mode != "RGB" and format == "JPEG":
            image = image.convert("RGB")
        
        # Resize if needed
        if resize_width or resize_height:
            # Maintain aspect ratio
            original_width, original_height = image.size
            
            if resize_width and resize_height:
                # Both specified - resize to fit within bounds
                ratio = min(resize_width / original_width, resize_height / original_height)
                new_width = int(original_width * ratio)
                new_height = int(original_height * ratio)
            elif resize_width:
                # Only width specified
                ratio = resize_width / original_width
                new_height = int(original_height * ratio)
                new_width = resize_width
            else:
                # Only height specified
                ratio = resize_height / original_height
                new_width = int(original_width * ratio)
                new_height = resize_height
            
            # Only resize if image is larger than target
            if new_width < original_width or new_height < original_height:
                image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        # Save to bytes
        output = io.BytesIO()
        save_kwargs = {'format': format}
        
        if format == "JPEG":
            save_kwargs['quality'] = quality
            save_kwargs['optimize'] = True
        elif format == "PNG":
            save_kwargs['optimize'] = True
        
        image.save(output, **save_kwargs)
        output.seek(0)
        
        return output.read()
        
    except Exception as e:
        logger.error(f"Error processing image: {e}")
        raise Exception(f"Failed to process image: {str(e)}")


def generate_thumbnail(
    file_content: bytes,
    size: int = 300,
    quality: int = 85
) -> bytes:
    """
    Generate a square thumbnail from an image
    
    Args:
        file_content: Original image content as bytes
        size: Thumbnail size in pixels (square)
        quality: JPEG quality (1-100)
    
    Returns:
        Thumbnail image content as bytes
    """
    try:
        # Open image
        image = Image.open(io.BytesIO(file_content))
        
        # Convert RGBA to RGB for JPEG
        if image.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(image, mask=image.split()[-1] if image.mode == "RGBA" else None)
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")
        
        # Create square thumbnail (center crop)
        width, height = image.size
        
        # Calculate crop box (center crop)
        if width > height:
            # Landscape - crop width
            left = (width - height) // 2
            right = left + height
            top = 0
            bottom = height
        else:
            # Portrait or square - crop height
            top = (height - width) // 2
            bottom = top + width
            left = 0
            right = width
        
        # Crop to square
        image = image.crop((left, top, right, bottom))
        
        # Resize to thumbnail size
        image = image.resize((size, size), Image.Resampling.LANCZOS)
        
        # Save to bytes
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=quality, optimize=True)
        output.seek(0)
        
        return output.read()
        
    except Exception as e:
        logger.error(f"Error generating thumbnail: {e}")
        raise Exception(f"Failed to generate thumbnail: {str(e)}")


def get_image_info(file_content: bytes) -> dict:
    """
    Get image information (dimensions, format, size)
    
    Args:
        file_content: Image file content as bytes
    
    Returns:
        Dictionary with image info
    """
    try:
        image = Image.open(io.BytesIO(file_content))
        return {
            "width": image.size[0],
            "height": image.size[1],
            "format": image.format,
            "mode": image.mode,
            "size_bytes": len(file_content)
        }
    except Exception as e:
        logger.error(f"Error getting image info: {e}")
        return {}





