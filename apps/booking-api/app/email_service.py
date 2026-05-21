"""
Email service for the booking engine backend.
"""

import logging
import re
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.config import settings

logger = logging.getLogger(__name__)


async def send_email(
    to_email: str,
    subject: str,
    html_body: str,
    text_body: str | None = None,
) -> bool:
    if not settings.EMAIL_ENABLED:
        logger.warning(f"Email sending is disabled. Would send to {to_email}: {subject}")
        return False

    if not settings.SMTP_HOST:
        logger.error("SMTP_HOST not configured")
        return False

    try:
        if not text_body:
            text_body = re.sub(r"<[^>]+>", "", html_body).replace("&nbsp;", " ").strip()

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{settings.EMAIL_FROM_NAME} <{settings.EMAIL_FROM_ADDRESS}>"
        msg["To"] = to_email
        msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        if settings.SMTP_PORT == 465:
            context = ssl.create_default_context()
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            with smtplib.SMTP_SSL(
                settings.SMTP_HOST, settings.SMTP_PORT, context=context
            ) as server:
                if settings.SMTP_USER and settings.SMTP_PASSWORD:
                    server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
                if settings.SMTP_USE_TLS:
                    server.starttls()
                if settings.SMTP_USER and settings.SMTP_PASSWORD:
                    server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                server.send_message(msg)

        logger.info(f"Email sent successfully to {to_email}")
        return True
    except smtplib.SMTPAuthenticationError as e:
        logger.error(f"SMTP authentication failed: {e}")
        logger.error(
            f"  Host: {settings.SMTP_HOST}, Port: {settings.SMTP_PORT}, User: {settings.SMTP_USER}"
        )
        return False
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


# ── Template helpers ──────────────────────────────────────────────────


def _email_layout(title: str, heading: str, content_html: str) -> str:
    """Wrap inner content in the standard email chrome (DOCTYPE / head / body
    + heading band + footer). Keeps every transactional template visually
    identical so a CSS change is one edit, not three."""
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
            <h1 style="color: #2c3e50; margin-top: 0;">{heading}</h1>
        </div>

        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e0e0e0;">
{content_html}
        </div>

        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #999; font-size: 12px;">
            <p>&copy; {settings.EMAIL_FROM_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </body>
    </html>
    """


def _cta_button(href: str, label: str) -> str:
    """Centered call-to-action button."""
    return f"""
            <div style="text-align: center; margin: 30px 0;">
                <a href="{href}"
                   style="background-color: #007bff; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                    {label}
                </a>
            </div>"""


def _fallback_link(url: str) -> str:
    """The 'or copy and paste this link' box, for clients that strip buttons."""
    return f"""
            <p>Or copy and paste this link into your browser:</p>
            <p style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 12px; color: #666;">
                {url}
            </p>"""


_EXPIRY_NOTE = """
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
                <strong>This link will expire in 1 hour.</strong>
            </p>"""


# ── Templates ────────────────────────────────────────────────────────


def create_password_reset_html(reset_link: str, user_name: str | None = None) -> str:
    name = user_name or "there"
    content = f"""
            <p>Hi {name},</p>

            <p>We received a request to reset your password. Click the button below to set a new password:</p>
{_cta_button(reset_link, "Reset Password")}
{_fallback_link(reset_link)}
{_EXPIRY_NOTE}

            <p style="color: #666; font-size: 14px;">
                If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
            </p>"""
    return _email_layout("Reset Your Password", "Reset Your Password", content)


def create_welcome_email_html(user_name: str, login_link: str) -> str:
    name = user_name or "there"
    title = f"Welcome to {settings.EMAIL_FROM_NAME}"
    content = f"""
            <p>Hi {name},</p>

            <p>Thank you for creating your account. You're all set to start managing your properties and bookings.</p>

            <p>Click the button below to log in and access your dashboard:</p>
{_cta_button(login_link, "Go to Dashboard")}
{_fallback_link(login_link)}

            <p style="color: #666; font-size: 14px; margin-top: 30px;">
                If you have any questions, feel free to reach out to our support team.
            </p>"""
    return _email_layout(title, f"{title}!", content)


def create_email_change_verification_html(
    verification_link: str, new_email: str, user_name: str | None = None
) -> str:
    name = user_name or "there"
    content = f"""
            <p>Hi {name},</p>

            <p>We received a request to change your account email to <strong>{new_email}</strong>. Click the button below to confirm this change:</p>
{_cta_button(verification_link, "Confirm Email Change")}
{_fallback_link(verification_link)}
{_EXPIRY_NOTE}

            <p style="color: #666; font-size: 14px;">
                If you didn't request this change, you can safely ignore this email. Your email will remain unchanged.
            </p>"""
    return _email_layout("Confirm Email Change", "Confirm Email Change", content)
