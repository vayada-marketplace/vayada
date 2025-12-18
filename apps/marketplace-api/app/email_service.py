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
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
            if settings.SMTP_USE_TLS:
                server.starttls()
            
            if settings.SMTP_USER and settings.SMTP_PASSWORD:
                server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            
            server.send_message(msg)
        
        logger.info(f"Email sent successfully to {to_email}")
        return True
        
    except Exception as e:
        logger.error(f"SMTP email sending failed: {str(e)}")
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

