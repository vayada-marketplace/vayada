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
  .btn-accept { background: #16a34a; }
  .btn-reject { background: #dc2626; margin-left: 12px; }
  .footer { text-align: center; color: #888; font-size: 12px; margin-top: 24px; }
  .alert { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-size: 14px; color: #92400e; }
</style>
"""


def _my_booking_url(booking: dict) -> str | None:
    slug = booking.get("hotel_slug")
    if not slug:
        return None
    return f"https://{slug}.vayada.com/my-booking"


def _my_booking_button_html(booking: dict) -> str:
    url = _my_booking_url(booking)
    if not url:
        return ""
    return f"""
    <hr class="divider">
    <a href="{url}" class="btn">View My Booking</a>
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


# ── Legacy (still used for admin-created bookings) ────────────────

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
    {_my_booking_button_html(booking)}
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
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


# ── New payment flow emails ───────────────────────────────────────

async def send_booking_request_notification(hotel_email: str, booking: dict):
    """Notify host of new booking request with Accept/Reject actions."""
    if not hotel_email:
        return

    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"
    payment_method = booking.get("payment_method", "card")
    payment_label = "Card (authorization hold)" if payment_method == "card" else "Pay at property"

    subject = f"New Booking Request: {booking['booking_reference']}"
    content = f"""
    <h2>New Booking Request</h2>
    <p class="detail"><strong>Guest:</strong> {booking['guest_first_name']} {booking['guest_last_name']}</p>
    <p class="detail"><strong>Email:</strong> {booking['guest_email']}</p>
    <p class="detail"><strong>Payment:</strong> {payment_label}</p>
    {_booking_details_html(booking)}
    <div class="alert">
        You have <strong>24 hours</strong> to accept or reject this booking.
        If no action is taken, the booking will expire automatically.
    </div>
    <hr class="divider">
    <a href="{pms_link}" class="btn btn-accept">Review &amp; Respond</a>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_guest_booking_requested(guest_email: str, booking: dict):
    """Confirm to guest that their booking request has been submitted."""
    subject = f"Booking Request Submitted — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Submitted</h2>
    <p class="detail">Your booking request at <strong>{booking['hotel_name']}</strong> has been submitted successfully.</p>
    <p class="detail">The host will review your request and respond within <strong>24 hours</strong>.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">You will receive an email once the host responds. You can also check your booking status using your reference number.</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_accepted(guest_email: str, booking: dict):
    """Notify guest that their booking has been accepted and payment captured."""
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    payment_method = booking.get("payment_method", "card")
    payment_note = "Your card has been charged." if payment_method == "card" else "Please pay at the property upon arrival."

    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Great news — your booking at <strong>{booking['hotel_name']}</strong> has been accepted by the host.</p>
    <p class="detail">{payment_note}</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We look forward to welcoming you!</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_rejected(guest_email: str, booking: dict):
    """Notify guest that their booking has been declined."""
    payment_method = booking.get("payment_method", "card")
    refund_note = "Any authorization hold on your card has been released." if payment_method == "card" else ""

    subject = f"Booking Request Declined — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Declined</h2>
    <p class="detail">Unfortunately, your booking request at <strong>{booking['hotel_name']}</strong> was declined by the host.</p>
    {"<p class='detail'>" + refund_note + "</p>" if refund_note else ""}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We encourage you to search for alternative dates or properties.</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_expired(guest_email: str, booking: dict):
    """Notify guest that their booking request expired (host didn't respond)."""
    payment_method = booking.get("payment_method", "card")
    refund_note = "Any authorization hold on your card has been released." if payment_method == "card" else ""

    subject = f"Booking Request Expired — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Expired</h2>
    <p class="detail">Your booking request at <strong>{booking['hotel_name']}</strong> has expired because the host did not respond within 24 hours.</p>
    {"<p class='detail'>" + refund_note + "</p>" if refund_note else ""}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We apologize for the inconvenience. Please try booking again or explore other properties.</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_booking_withdrawn(hotel_email: str, booking: dict):
    """Notify host that guest withdrew their booking request."""
    if not hotel_email:
        return

    subject = f"Booking Withdrawn: {booking['booking_reference']}"
    content = f"""
    <h2>Guest Withdrew Booking Request</h2>
    <p class="detail">The guest <strong>{booking['guest_first_name']} {booking['guest_last_name']}</strong> has withdrawn their booking request.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">No action is needed on your part.</p>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_host_booking_expired(hotel_email: str, booking: dict):
    """Notify host that a booking expired because they didn't respond."""
    if not hotel_email:
        return

    subject = f"Booking Expired: {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Expired</h2>
    <p class="detail">A booking request from <strong>{booking['guest_first_name']} {booking['guest_last_name']}</strong> has expired because no action was taken within 24 hours.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <div class="alert">
        Please ensure you review and respond to booking requests promptly to avoid losing potential guests.
    </div>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_guest_cancellation_refund(
    guest_email: str, booking: dict, refund_amount: float, refund_pct: float
):
    """Notify guest of cancellation with refund details."""
    if refund_pct >= 100:
        refund_text = f"A full refund of <strong>{booking['currency']} {refund_amount:.2f}</strong> will be processed to your original payment method."
    elif refund_amount > 0:
        refund_text = f"A partial refund of <strong>{booking['currency']} {refund_amount:.2f}</strong> ({refund_pct:.0f}%) will be processed to your original payment method."
    else:
        refund_text = "Based on the cancellation policy, no refund is applicable for this cancellation."

    subject = f"Booking Cancelled — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Cancelled</h2>
    <p class="detail">Your booking at <strong>{booking['hotel_name']}</strong> has been cancelled.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">{refund_text}</p>
    <p class="detail">If you have any questions, please contact the hotel directly.</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


# ── New notification emails ────────────────────────────────────────


async def send_guest_booking_withdrawn(guest_email: str, booking: dict):
    """Confirm to guest that they withdrew their booking request."""
    payment_method = booking.get("payment_method", "card")
    release_note = "Any authorization hold on your card has been released." if payment_method == "card" else ""

    subject = f"Booking Withdrawn — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Withdrawn</h2>
    <p class="detail">Your booking request at <strong>{booking['hotel_name']}</strong> has been withdrawn.</p>
    {"<p class='detail'>" + release_note + "</p>" if release_note else ""}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">If you change your mind, you're welcome to submit a new booking request anytime.</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_booking_accepted(hotel_email: str, booking: dict):
    """Confirm to host that they accepted the booking."""
    if not hotel_email:
        return

    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"
    payment_method = booking.get("payment_method", "card")
    payment_note = "Payment has been captured." if payment_method == "card" else "Guest will pay at the property."

    subject = f"Booking Accepted: {booking['booking_reference']}"
    content = f"""
    <h2>Booking Accepted</h2>
    <p class="detail">You have accepted the booking from <strong>{booking['guest_first_name']} {booking['guest_last_name']}</strong>.</p>
    <p class="detail">{payment_note}</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_guest_admin_booking_confirmed(guest_email: str, booking: dict):
    """Notify guest that an admin has created and confirmed their booking."""
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Your booking at <strong>{booking['hotel_name']}</strong> has been confirmed.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We look forward to welcoming you!</p>
    {_my_booking_button_html(booking)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_guest_cancelled(hotel_email: str, booking: dict):
    """Notify host that a guest cancelled their confirmed booking."""
    if not hotel_email:
        return

    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"

    subject = f"Booking Cancelled by Guest: {booking['booking_reference']}"
    content = f"""
    <h2>Guest Cancelled Booking</h2>
    <p class="detail">The guest <strong>{booking['guest_first_name']} {booking['guest_last_name']}</strong> has cancelled their confirmed booking.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">The room is now available for new bookings.</p>
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))
