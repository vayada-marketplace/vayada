"""
Contact form routes
"""
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, EmailStr
from typing import Optional
from app.email_service import send_email
from app.config import settings
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
    Sends an email notification to the team.
    """
    try:
        html_body = f"""
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> {request.name}</p>
        <p><strong>Email:</strong> {request.email}</p>
        <p><strong>Phone:</strong> {request.phone or 'Not provided'}</p>
        <p><strong>Company:</strong> {request.company or 'Not provided'}</p>
        <p><strong>Country:</strong> {request.country or 'Not provided'}</p>
        <p><strong>User Type:</strong> {request.user_type or 'Not specified'}</p>
        <hr>
        <p><strong>Message:</strong></p>
        <p>{request.message}</p>
        """

        await send_email(
            to_email=settings.CONTACT_EMAIL or settings.EMAIL_FROM_ADDRESS,
            subject=f"New Contact Form: {request.name}",
            html_body=html_body
        )

        return ContactFormResponse(message="Contact form submitted successfully")

    except Exception as e:
        logger.error(f"Error submitting contact form: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit contact form. Please try again."
        )
