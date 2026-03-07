"""
Email service for sending emails
Supports SMTP and email service providers (SendGrid, AWS SES, etc.)
"""
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
from app.config import settings
import logging

logger = logging.getLogger(__name__)


async def send_email(
    to_email: str,
    subject: str,
    html_body: str,
    text_body: Optional[str] = None
) -> bool:
    """
    Send an email
    
    Args:
        to_email: Recipient email address
        subject: Email subject
        html_body: HTML email body
        text_body: Plain text email body (optional, auto-generated from HTML if not provided)
    
    Returns:
        True if email sent successfully, False otherwise
    """
    if not settings.EMAIL_ENABLED:
        logger.warning(f"Email sending is disabled. Would send to {to_email}: {subject}")
        return False
    
    try:
        if settings.EMAIL_SERVICE_PROVIDER == "smtp":
            return await _send_email_smtp(to_email, subject, html_body, text_body)
        elif settings.EMAIL_SERVICE_PROVIDER == "sendgrid":
            return await _send_email_sendgrid(to_email, subject, html_body, text_body)
        elif settings.EMAIL_SERVICE_PROVIDER == "ses":
            return await _send_email_ses(to_email, subject, html_body, text_body)
        else:
            logger.error(f"Unknown email service provider: {settings.EMAIL_SERVICE_PROVIDER}")
            return False
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {str(e)}")
        return False


async def _send_email_smtp(
    to_email: str,
    subject: str,
    html_body: str,
    text_body: Optional[str] = None
) -> bool:
    """Send email via SMTP"""
    if not settings.SMTP_HOST:
        logger.error("SMTP_HOST not configured")
        return False
    
    try:
        # Create message
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = f"{settings.EMAIL_FROM_NAME} <{settings.EMAIL_FROM_ADDRESS}>"
        msg['To'] = to_email
        
        # Create plain text version if not provided
        if not text_body:
            # Simple HTML to text conversion (remove HTML tags)
            import re
            text_body = re.sub(r'<[^>]+>', '', html_body)
            text_body = text_body.replace('&nbsp;', ' ').strip()
        
        # Add both plain text and HTML versions
        part1 = MIMEText(text_body, 'plain')
        part2 = MIMEText(html_body, 'html')
        
        msg.attach(part1)
        msg.attach(part2)
        
        # Send email
        # IONOS supports both port 465 (SSL/TLS) and 587 (STARTTLS)
        # Port 465 is primary, 587 is alternative if 465 is blocked
        if settings.SMTP_PORT == 465:
            # Use SSL/TLS for port 465 (IONOS primary method)
            import ssl
            context = ssl.create_default_context()
            # IONOS requires TLS 1.2 or higher
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            with smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, context=context) as server:
                if settings.SMTP_USER and settings.SMTP_PASSWORD:
                    # IONOS requires full email address as username
                    server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                server.send_message(msg)
        else:
            # Use STARTTLS for port 587 (IONOS alternative method)
            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
                # IONOS requires STARTTLS on port 587
                if settings.SMTP_USE_TLS:
                    server.starttls()
                
                if settings.SMTP_USER and settings.SMTP_PASSWORD:
                    # IONOS requires full email address as username
                    server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                
                server.send_message(msg)
        
        logger.info(f"Email sent successfully to {to_email}")
        return True
        
    except smtplib.SMTPAuthenticationError as e:
        logger.error(f"SMTP authentication failed: {str(e)}")
        logger.error(f"  Host: {settings.SMTP_HOST}, Port: {settings.SMTP_PORT}")
        logger.error(f"  User: {settings.SMTP_USER}")
        logger.error("  Troubleshooting steps:")
        logger.error("    1. Verify password is correct in IONOS")
        logger.error("    2. Check if SMTP is enabled in IONOS control panel")
        logger.error("    3. Ensure email account exists and is active")
        logger.error("    4. Try logging into webmail with same credentials")
        logger.error("    5. Check if 2FA requires app-specific password")
        return False
    except Exception as e:
        logger.error(f"SMTP email sending failed: {str(e)}")
        logger.error(f"  Host: {settings.SMTP_HOST}, Port: {settings.SMTP_PORT}")
        return False


async def _send_email_sendgrid(
    to_email: str,
    subject: str,
    html_body: str,
    text_body: Optional[str] = None
) -> bool:
    """Send email via SendGrid API"""
    try:
        import requests
        
        if not settings.EMAIL_SERVICE_API_KEY:
            logger.error("EMAIL_SERVICE_API_KEY not configured for SendGrid")
            return False
        
        # Create plain text version if not provided
        if not text_body:
            import re
            text_body = re.sub(r'<[^>]+>', '', html_body)
            text_body = text_body.replace('&nbsp;', ' ').strip()
        
        url = "https://api.sendgrid.com/v3/mail/send"
        headers = {
            "Authorization": f"Bearer {settings.EMAIL_SERVICE_API_KEY}",
            "Content-Type": "application/json"
        }
        
        data = {
            "personalizations": [{
                "to": [{"email": to_email}]
            }],
            "from": {
                "email": settings.EMAIL_FROM_ADDRESS,
                "name": settings.EMAIL_FROM_NAME
            },
            "subject": subject,
            "content": [
                {
                    "type": "text/plain",
                    "value": text_body
                },
                {
                    "type": "text/html",
                    "value": html_body
                }
            ]
        }
        
        response = requests.post(url, json=data, headers=headers)
        
        if response.status_code == 202:
            logger.info(f"Email sent successfully to {to_email} via SendGrid")
            return True
        else:
            logger.error(f"SendGrid API error: {response.status_code} - {response.text}")
            return False
            
    except ImportError:
        logger.error("requests library not installed. Install it to use SendGrid.")
        return False
    except Exception as e:
        logger.error(f"SendGrid email sending failed: {str(e)}")
        return False


async def _send_email_ses(
    to_email: str,
    subject: str,
    html_body: str,
    text_body: Optional[str] = None
) -> bool:
    """Send email via AWS SES"""
    try:
        import boto3
        from botocore.exceptions import ClientError
        
        if not settings.EMAIL_SERVICE_API_KEY:
            logger.error("AWS credentials not configured for SES")
            return False
        
        # Create plain text version if not provided
        if not text_body:
            import re
            text_body = re.sub(r'<[^>]+>', '', html_body)
            text_body = text_body.replace('&nbsp;', ' ').strip()
        
        # Initialize SES client
        # Note: EMAIL_SERVICE_API_KEY should contain AWS access key
        # You may need to configure AWS credentials differently
        ses_client = boto3.client(
            'ses',
            aws_access_key_id=settings.EMAIL_SERVICE_API_KEY,
            # aws_secret_access_key should be in a separate config
            region_name='us-east-1'  # Adjust as needed
        )
        
        response = ses_client.send_email(
            Source=f"{settings.EMAIL_FROM_NAME} <{settings.EMAIL_FROM_ADDRESS}>",
            Destination={'ToAddresses': [to_email]},
            Message={
                'Subject': {'Data': subject, 'Charset': 'UTF-8'},
                'Body': {
                    'Text': {'Data': text_body, 'Charset': 'UTF-8'},
                    'Html': {'Data': html_body, 'Charset': 'UTF-8'}
                }
            }
        )
        
        logger.info(f"Email sent successfully to {to_email} via AWS SES")
        return True
        
    except ImportError:
        logger.error("boto3 library not installed. Install it to use AWS SES.")
        return False
    except ClientError as e:
        logger.error(f"AWS SES error: {str(e)}")
        return False
    except Exception as e:
        logger.error(f"AWS SES email sending failed: {str(e)}")
        return False


def create_email_verification_html(verification_code: str, user_name: Optional[str] = None) -> str:
    """
    Create HTML email template for email verification code
    
    Args:
        verification_code: 6-digit verification code
        user_name: Optional user name for personalization
    
    Returns:
        HTML email body
    """
    name = user_name or "there"
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h1 style="color: #2c3e50; margin-top: 0;">Verify Your Email</h1>
        </div>
        
        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e0e0e0;">
            <p>Hi {name},</p>
            
            <p>Thank you for registering with Vayada! Please use the verification code below to verify your email address:</p>
            
            <div style="background-color: #f0f0f0; padding: 20px; border-radius: 5px; margin: 30px 0; text-align: center;">
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #007bff; font-family: 'Courier New', monospace;">
                    {verification_code}
                </div>
            </div>
            
            <p style="color: #666; font-size: 14px;">
                <strong>This code will expire in 15 minutes.</strong><br>
                If you didn't request this code, please ignore this email.
            </p>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px;">
            <p>© {settings.EMAIL_FROM_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </body>
    </html>
    """
    
    return html


def create_profile_completion_email_html(user_name: str, user_type: str, verification_link: Optional[str] = None) -> str:
    """
    Create HTML email template for profile completion confirmation with email verification
    
    Args:
        user_name: User's name
        user_type: 'creator' or 'hotel'
        verification_link: Optional email verification link (if provided, includes verification section)
    
    Returns:
        HTML email body
    """
    profile_type = "Creator" if user_type == "creator" else "Hotel"
    dashboard_link = f"{settings.FRONTEND_URL}/{'profile' if user_type == 'creator' else 'hotel/dashboard'}"
    
    # Build verification section if link is provided
    verification_section = ""
    if verification_link:
        verification_section = f"""
            <p style="margin: 20px 0 10px 0; color: #666; font-size: 14px;">Please verify your email address to complete your account setup:</p>
            <div style="text-align: center; margin: 15px 0;">
                <a href="{verification_link}"   
                   style="color: #007bff; text-decoration: underline; font-size: 14px;">
                    Verify Email Address
                </a>
            </div>
            <p style="margin: 10px 0 20px 0; color: #999; font-size: 12px;">This link will expire in 48 hours.</p>
        """
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Profile Completed - {profile_type}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h1 style="color: #2c3e50; margin-top: 0;">🎉 Profile Completed!</h1>
        </div>
        
        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e0e0e0;">
            <p>Hi {user_name},</p>
            
            <p>Congratulations! Your {profile_type.lower()} profile on Vayada has been completed successfully.</p>
            
            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">✅ Your profile is now complete and ready for review!</p>
            </div>
            
            {verification_section}
            
            <p>Our team will now review your profile and verify your information. Once approved, your profile will go live and you'll be able to:</p>
            
            <ul style="color: #666;">
                <li>Connect with {('hotels' if user_type == 'creator' else 'creators')} on the platform</li>
                <li>Start receiving collaboration opportunities</li>
                <li>Build your presence on Vayada</li>
            </ul>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="{dashboard_link}" 
                   style="background-color: #007bff; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                    View Your Profile
                </a>
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
                <strong>What's next?</strong><br>
                You'll receive an email notification once your profile has been reviewed and approved by our team.
            </p>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px;">
            <p>© {settings.EMAIL_FROM_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </body>
    </html>
    """
    
    return html


def _collaboration_email_wrapper(title: str, content: str) -> str:
    """Shared wrapper for all collaboration emails."""
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>{title}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h1 style="color: #2c3e50; margin-top: 0;">{title}</h1>
        </div>

        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e0e0e0;">
            {content}
        </div>

        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px;">
            <p>&copy; {settings.EMAIL_FROM_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </body>
    </html>
    """


def _collaboration_details_html(
    collaboration_type: str,
    listing_name: str,
    listing_location: Optional[str] = None,
) -> str:
    """Render a small collaboration summary block."""
    location_line = f"<br><strong>Location:</strong> {listing_location}" if listing_location else ""
    return f"""
    <div style="background-color: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <strong>Type:</strong> {collaboration_type}<br>
        <strong>Listing:</strong> {listing_name}{location_line}
    </div>
    """


def _view_button_html(url: str, label: str = "View Collaboration") -> str:
    return f"""
    <div style="text-align: center; margin: 30px 0;">
        <a href="{url}"
           style="background-color: #007bff; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
            {label}
        </a>
    </div>
    """


def create_collaboration_request_email_html(
    recipient_name: str,
    initiator_name: str,
    initiator_type: str,
    collaboration_type: str,
    listing_name: str,
    listing_location: Optional[str] = None,
    why_great_fit: Optional[str] = None,
) -> str:
    """Email sent to the recipient when a new collaboration request is created."""
    if initiator_type == "creator":
        title = "New Collaboration Application"
        intro = f"<strong>{initiator_name}</strong> has applied to collaborate with your property."
    else:
        title = "New Collaboration Invitation"
        intro = f"<strong>{initiator_name}</strong> has invited you to collaborate."

    fit_section = ""
    if why_great_fit:
        fit_section = f"""
        <p style="margin-top: 15px;"><strong>Why they think it's a great fit:</strong></p>
        <p style="color: #555; font-style: italic;">"{why_great_fit}"</p>
        """

    collab_url = f"{settings.FRONTEND_URL}/collaborations"
    content = f"""
        <p>Hi {recipient_name},</p>
        <p>{intro}</p>
        {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
        {fit_section}
        <p>Log in to review the details and respond.</p>
        {_view_button_html(collab_url, "View Request")}
    """
    return _collaboration_email_wrapper(title, content)


def create_collaboration_response_email_html(
    recipient_name: str,
    responder_name: str,
    accepted: bool,
    collaboration_type: str,
    listing_name: str,
    listing_location: Optional[str] = None,
    response_message: Optional[str] = None,
) -> str:
    """Email sent to the initiator when their request is accepted or declined."""
    if accepted:
        title = "Collaboration Request Accepted"
        status_html = '<div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;"><p style="margin: 0; color: #2e7d32; font-weight: bold;">Your collaboration request has been accepted!</p></div>'
        next_step = "The collaboration is now in the negotiation phase. You can discuss and finalize the terms via chat."
    else:
        title = "Collaboration Request Declined"
        status_html = '<div style="background-color: #fbe9e7; padding: 15px; border-radius: 5px; margin: 20px 0;"><p style="margin: 0; color: #c62828; font-weight: bold;">Your collaboration request has been declined.</p></div>'
        next_step = "Don't be discouraged — there are many other opportunities on Vayada!"

    message_section = ""
    if response_message:
        message_section = f'<p style="color: #555; font-style: italic;">Message from {responder_name}: "{response_message}"</p>'

    collab_url = f"{settings.FRONTEND_URL}/collaborations"
    content = f"""
        <p>Hi {recipient_name},</p>
        <p><strong>{responder_name}</strong> has responded to your collaboration request.</p>
        {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
        {status_html}
        {message_section}
        <p>{next_step}</p>
        {_view_button_html(collab_url)}
    """
    return _collaboration_email_wrapper(title, content)


def create_collaboration_counter_offer_email_html(
    recipient_name: str,
    sender_name: str,
    sender_role: str,
    collaboration_type: str,
    listing_name: str,
    changes_summary: str,
    listing_location: Optional[str] = None,
) -> str:
    """Email sent when the other party suggests new terms."""
    title = "New Counter-Offer on Your Collaboration"
    collab_url = f"{settings.FRONTEND_URL}/collaborations"
    content = f"""
        <p>Hi {recipient_name},</p>
        <p><strong>{sender_name}</strong> ({sender_role}) has suggested updated terms for your collaboration.</p>
        {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
        <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0 0 5px 0; font-weight: bold;">Proposed changes:</p>
            <p style="margin: 0; color: #555;">{changes_summary}</p>
        </div>
        <p>Log in to review the updated terms, discuss in the chat, or make your own counter-offer.</p>
        {_view_button_html(collab_url, "Review Terms")}
    """
    return _collaboration_email_wrapper(title, content)


def create_collaboration_approved_email_html(
    recipient_name: str,
    other_party_name: str,
    collaboration_type: str,
    listing_name: str,
    listing_location: Optional[str] = None,
    both_approved: bool = False,
) -> str:
    """Email sent when a party approves the terms (and when both have approved)."""
    if both_approved:
        title = "Collaboration Confirmed!"
        content = f"""
            <p>Hi {recipient_name},</p>
            <p>Great news! Both parties have approved the terms. Your collaboration is now confirmed.</p>
            {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">The collaboration is now active!</p>
            </div>
            {_view_button_html(f"{settings.FRONTEND_URL}/collaborations")}
        """
    else:
        title = "Terms Approved — Waiting for Confirmation"
        content = f"""
            <p>Hi {recipient_name},</p>
            <p><strong>{other_party_name}</strong> has approved the current terms.</p>
            {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
            <p>Please review and approve the terms to confirm the collaboration.</p>
            {_view_button_html(f"{settings.FRONTEND_URL}/collaborations", "Review & Approve")}
        """
    return _collaboration_email_wrapper(title, content)


def create_collaboration_cancelled_email_html(
    recipient_name: str,
    canceller_name: str,
    canceller_role: str,
    collaboration_type: str,
    listing_name: str,
    listing_location: Optional[str] = None,
    reason: Optional[str] = None,
) -> str:
    """Email sent when the other party cancels the collaboration."""
    title = "Collaboration Cancelled"
    reason_section = ""
    if reason:
        reason_section = f'<p style="color: #555;"><strong>Reason:</strong> {reason}</p>'
    content = f"""
        <p>Hi {recipient_name},</p>
        <p><strong>{canceller_name}</strong> ({canceller_role}) has cancelled the collaboration.</p>
        {_collaboration_details_html(collaboration_type, listing_name, listing_location)}
        <div style="background-color: #fbe9e7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; color: #c62828; font-weight: bold;">This collaboration has been cancelled.</p>
        </div>
        {reason_section}
        <p>You can explore other collaboration opportunities on Vayada.</p>
        {_view_button_html(f"{settings.FRONTEND_URL}/collaborations", "Browse Collaborations")}
    """
    return _collaboration_email_wrapper(title, content)


def _newsletter_item_html(
    name: str,
    location: str,
    description: str,
    image_url: Optional[str] = None,
    badge: Optional[str] = None,
) -> str:
    """Render a single recommendation card inside a newsletter."""
    badge_html = ""
    if badge:
        badge_html = f'<span style="display: inline-block; background-color: #e3f2fd; color: #1565c0; font-size: 11px; font-weight: bold; padding: 2px 8px; border-radius: 12px; margin-bottom: 8px;">{badge}</span><br>'

    img_html = ""
    if image_url:
        img_html = f'<img src="{image_url}" alt="{name}" style="width: 80px; height: 80px; border-radius: 8px; object-fit: cover; margin-right: 15px; flex-shrink: 0;" />'

    return f"""
    <div style="display: flex; align-items: flex-start; padding: 15px 0; border-bottom: 1px solid #eee;">
        {img_html}
        <div>
            {badge_html}
            <strong style="font-size: 15px;">{name}</strong><br>
            <span style="color: #888; font-size: 13px;">{location}</span>
            <p style="margin: 6px 0 0; color: #555; font-size: 13px;">{description}</p>
        </div>
    </div>
    """


def create_newsletter_for_creator_html(
    creator_name: str,
    recommendations: list,
    new_hotels: list,
    frontend_url: str,
) -> str:
    """
    Weekly newsletter for creators — recommends hotels.

    recommendations: list of dicts with keys name, location, description, image_url, accommodation_type
    new_hotels:      list of dicts (same shape) for newly joined hotels
    """
    recs_html = ""
    for r in recommendations:
        recs_html += _newsletter_item_html(
            name=r["name"],
            location=r["location"],
            description=r.get("description", ""),
            image_url=r.get("image_url"),
        )

    new_section = ""
    if new_hotels:
        items = ""
        for h in new_hotels:
            items += _newsletter_item_html(
                name=h["name"],
                location=h["location"],
                description=h.get("description", ""),
                image_url=h.get("image_url"),
                badge="New on Vayada",
            )
        new_section = f"""
        <h2 style="font-size: 18px; color: #2c3e50; margin-top: 30px;">New Hotels This Week</h2>
        {items}
        """

    content = f"""
        <p>Hi {creator_name},</p>
        <p>Here are this week's top hotel recommendations for you:</p>
        {recs_html}
        {new_section}
        {_view_button_html(f"{frontend_url}/marketplace", "Explore the Marketplace")}
        <p style="color: #999; font-size: 12px; margin-top: 20px;">
            You can update your newsletter preferences in
            <a href="{frontend_url}/settings/newsletter" style="color: #007bff;">Settings</a>.
        </p>
    """
    return _collaboration_email_wrapper("Your Weekly Hotel Picks", content)


def create_newsletter_for_hotel_html(
    hotel_name: str,
    recommendations: list,
    new_creators: list,
    frontend_url: str,
) -> str:
    """
    Weekly newsletter for hotels — recommends creators.

    recommendations: list of dicts with keys name, location, description, image_url, followers, platform
    new_creators:     list of dicts (same shape) for newly joined creators
    """
    recs_html = ""
    for r in recommendations:
        extra = ""
        if r.get("followers"):
            extra = f" | {r['followers']:,} followers"
        if r.get("platform"):
            extra += f" on {r['platform']}"
        recs_html += _newsletter_item_html(
            name=r["name"],
            location=r["location"],
            description=(r.get("description", "") + extra),
            image_url=r.get("image_url"),
        )

    new_section = ""
    if new_creators:
        items = ""
        for c in new_creators:
            extra = ""
            if c.get("followers"):
                extra = f" | {c['followers']:,} followers"
            items += _newsletter_item_html(
                name=c["name"],
                location=c["location"],
                description=(c.get("description", "") + extra),
                image_url=c.get("image_url"),
                badge="New on Vayada",
            )
        new_section = f"""
        <h2 style="font-size: 18px; color: #2c3e50; margin-top: 30px;">New Creators This Week</h2>
        {items}
        """

    content = f"""
        <p>Hi {hotel_name},</p>
        <p>Here are this week's top creator recommendations for your property:</p>
        {recs_html}
        {new_section}
        {_view_button_html(f"{frontend_url}/marketplace", "Explore the Marketplace")}
        <p style="color: #999; font-size: 12px; margin-top: 20px;">
            You can update your newsletter preferences in
            <a href="{frontend_url}/settings/newsletter" style="color: #007bff;">Settings</a>.
        </p>
    """
    return _collaboration_email_wrapper("Your Weekly Creator Picks", content)


def create_password_reset_email_html(reset_link: str, user_name: Optional[str] = None) -> str:
    """
    Create HTML email template for password reset
    
    Args:
        reset_link: Password reset link with token
        user_name: Optional user name for personalization
    
    Returns:
        HTML email body
    """
    name = user_name or "there"
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h1 style="color: #2c3e50; margin-top: 0;">Reset Your Password</h1>
        </div>
        
        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e0e0e0;">
            <p>Hi {name},</p>
            
            <p>We received a request to reset your password for your Vayada account. Click the button below to reset your password:</p>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="{reset_link}" 
                   style="background-color: #007bff; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                    Reset Password
                </a>
            </div>
            
            <p>Or copy and paste this link into your browser:</p>
            <p style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 12px; color: #666;">
                {reset_link}
            </p>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
                <strong>This link will expire in 1 hour.</strong>
            </p>
            
            <p style="color: #666; font-size: 14px;">
                If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
            </p>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px;">
            <p>© {settings.EMAIL_FROM_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </body>
    </html>
    """
    
    return html

