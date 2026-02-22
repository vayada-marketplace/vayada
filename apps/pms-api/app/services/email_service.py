import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from app.config import settings

logger = logging.getLogger(__name__)

STYLE = """
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f4f4f7; }
  .wrapper { max-width: 600px; margin: 0 auto; padding: 24px; }
  .card { background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h2 { color: #1a1a2e; margin-top: 0; font-size: 22px; }
  .detail { margin: 6px 0; color: #333; font-size: 15px; line-height: 1.6; }
  .detail strong { color: #1a1a2e; }
  .divider { border: none; border-top: 1px solid #e8e8ed; margin: 20px 0; }
  .btn { display: inline-block; padding: 12px 28px; background: #1a1a2e; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; margin-top: 16px; }
  .footer { text-align: center; color: #888; font-size: 12px; margin-top: 24px; }
</style>
"""


def _wrap_html(content: str) -> str:
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">{STYLE}</head>
<body><div class="wrapper"><div class="card">{content}</div>
<p class="footer">Vayada &mdash; Hotel Management Platform</p>
</div></body></html>"""


def _booking_details_html(booking: dict) -> str:
    return f"""
    <p class="detail"><strong>Reference:</strong> {booking['booking_reference']}</p>
    <p class="detail"><strong>Room:</strong> {booking['room_name']}</p>
    <p class="detail"><strong>Check-in:</strong> {booking['check_in']}</p>
    <p class="detail"><strong>Check-out:</strong> {booking['check_out']}</p>
    <p class="detail"><strong>Guests:</strong> {booking['adults']} adults, {booking['children']} children</p>
    <p class="detail"><strong>Total:</strong> {booking['currency']} {booking['total_amount']}</p>
    """


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

    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"

    subject = f"New Booking: {booking['booking_reference']}"
    content = f"""
    <h2>New Booking Received</h2>
    <p class="detail"><strong>Guest:</strong> {booking['guest_first_name']} {booking['guest_last_name']}</p>
    <p class="detail"><strong>Email:</strong> {booking['guest_email']}</p>
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">Please review this booking and confirm or cancel it in the PMS.</p>
    <a href="{pms_link}" class="btn">Review in PMS</a>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_guest_confirmation(guest_email: str, booking: dict):
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Great news — your booking at <strong>{booking['hotel_name']}</strong> has been confirmed by the hotel.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">You can look up your booking anytime using your reference number and email address.</p>
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_cancellation(guest_email: str, booking: dict):
    subject = f"Booking Cancelled — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Cancelled</h2>
    <p class="detail">Unfortunately, your booking at <strong>{booking['hotel_name']}</strong> has been cancelled.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">If you have any questions, please contact the hotel directly.</p>
    """
    await _send_email(guest_email, subject, _wrap_html(content))
