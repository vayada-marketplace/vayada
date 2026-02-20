import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from app.config import settings

logger = logging.getLogger(__name__)


async def _send_email(to: str, subject: str, html_body: str):
    if not settings.SMTP_HOST:
        logger.debug("SMTP not configured — skipping email to %s", to)
        return

    try:
        import aiosmtplib

        msg = MIMEMultipart("alternative")
        msg["From"] = settings.SMTP_FROM
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(html_body, "html"))

        await aiosmtplib.send(
            msg,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USERNAME or None,
            password=settings.SMTP_PASSWORD or None,
            use_tls=settings.SMTP_USE_TLS,
        )
        logger.info("Email sent to %s: %s", to, subject)
    except Exception as e:
        logger.warning("Failed to send email to %s: %s", to, e)


async def send_hotel_notification(hotel_email: str, booking: dict):
    if not hotel_email:
        return
    subject = f"New Booking: {booking['booking_reference']}"
    html = f"""
    <h2>New Booking Received</h2>
    <p><strong>Reference:</strong> {booking['booking_reference']}</p>
    <p><strong>Guest:</strong> {booking['guest_first_name']} {booking['guest_last_name']}</p>
    <p><strong>Email:</strong> {booking['guest_email']}</p>
    <p><strong>Room:</strong> {booking['room_name']}</p>
    <p><strong>Check-in:</strong> {booking['check_in']}</p>
    <p><strong>Check-out:</strong> {booking['check_out']}</p>
    <p><strong>Guests:</strong> {booking['adults']} adults, {booking['children']} children</p>
    <p><strong>Total:</strong> {booking['currency']} {booking['total_amount']}</p>
    """
    await _send_email(hotel_email, subject, html)


async def send_guest_confirmation(guest_email: str, booking: dict):
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    html = f"""
    <h2>Thank you for your booking!</h2>
    <p>Your booking at <strong>{booking['hotel_name']}</strong> has been received.</p>
    <p><strong>Reference:</strong> {booking['booking_reference']}</p>
    <p><strong>Room:</strong> {booking['room_name']}</p>
    <p><strong>Check-in:</strong> {booking['check_in']}</p>
    <p><strong>Check-out:</strong> {booking['check_out']}</p>
    <p><strong>Total:</strong> {booking['currency']} {booking['total_amount']}</p>
    <p>You can look up your booking anytime using your reference and email address.</p>
    """
    await _send_email(guest_email, subject, html)
