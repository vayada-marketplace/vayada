"""
Contact form routes
"""
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, EmailStr
from typing import Optional
from app.database import Database
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/contact", tags=["contact"])


class ContactFormRequest(BaseModel):
    """Request model for contact form submission"""
    name: str = Field(..., min_length=1, max_length=255)
    email: EmailStr
    phone: Optional[str] = Field(None, max_length=50)
    company: Optional[str] = Field(None, max_length=255)
    country: Optional[str] = Field(None, max_length=100)
    user_type: Optional[str] = Field(None, max_length=50)
    message: str = Field(..., min_length=1, max_length=5000)


class ContactFormResponse(BaseModel):
    """Response model for contact form submission"""
    message: str


@router.post("", response_model=ContactFormResponse)
async def submit_contact_form(request: ContactFormRequest):
    """
    Submit a contact form.
    Stores the submission in the database.
    """
    try:
        await Database.execute(
            """
            INSERT INTO contact_submissions (name, email, phone, company, country, user_type, message)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            request.name,
            request.email,
            request.phone,
            request.company,
            request.country,
            request.user_type,
            request.message
        )

        return ContactFormResponse(message="Contact form submitted successfully")

    except Exception as e:
        logger.error(f"Error submitting contact form: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit contact form. Please try again."
        )
