"""Canonical OTA channel keys + alias normalization.

Channex sends ``ota_name`` in many forms across properties and account
configurations: ``"Booking.com"``, ``"booking_com"``, ``"BookingCom"``,
``"booking"``. The PMS must store one canonical value per OTA so the
frontend's color/legend lookup, source filters, and report grouping all
agree (without each consumer re-implementing the alias table).

Canonical keys are the lowercase brand names (``"booking.com"``,
``"airbnb"``, ``"expedia"``) — same shape the calendar legend already
uses. ``"channex"`` is the fallback when Channex sends nothing usable;
``"direct"`` is the PMS-native source.
"""

# Canonical key -> human-facing label (used in host-notification emails).
CHANNEL_LABELS: dict[str, str] = {
    "direct": "Direct",
    "booking.com": "Booking.com",
    "airbnb": "Airbnb",
    "expedia": "Expedia",
    "agoda": "Agoda",
    "vrbo": "Vrbo",
    "hostelworld": "Hostelworld",
    "tripadvisor": "Tripadvisor",
    "hotels.com": "Hotels.com",
}

# Alias -> canonical key. Keys are pre-lowercased; callers should
# lowercase + strip before lookup. The canonical key itself is included
# as an alias so a single dict lookup works for both raw and canonical
# inputs.
_CHANNEL_ALIASES: dict[str, str] = {
    "direct": "direct",
    # Booking.com sends inconsistent casings/separators
    "booking.com": "booking.com",
    "booking_com": "booking.com",
    "bookingcom": "booking.com",
    "booking": "booking.com",
    # Airbnb
    "airbnb": "airbnb",
    # Expedia (kept simple for now; expand as new aliases surface)
    "expedia": "expedia",
    "expedia.com": "expedia",
    # Other major OTAs — straight pass-through, listed so future label
    # lookups don't fall back to the title-cased raw value.
    "agoda": "agoda",
    "vrbo": "vrbo",
    "hostelworld": "hostelworld",
    "tripadvisor": "tripadvisor",
    "hotels.com": "hotels.com",
    "hotelscom": "hotels.com",
}


# Channels whose bookings are settled by the OTA platform — the guest
# has already paid (or is bound to a card the OTA charges), so the PMS
# should treat the invoice as paid by default instead of nagging hosts
# for an outstanding balance the guest doesn't actually owe them (VAY-490).
# ``channex`` is included because the inbound pipeline falls back to it
# when Channex sends an OTA name the alias table doesn't know — still
# externally-settled, just unbranded.
OTA_CHANNELS: frozenset[str] = frozenset(
    {
        "airbnb",
        "booking.com",
        "expedia",
        "agoda",
        "vrbo",
        "hostelworld",
        "tripadvisor",
        "hotels.com",
        "channex",
    }
)


def is_ota_channel(value: str | None) -> bool:
    """True if ``value`` (raw or canonical) is an externally-settled OTA channel."""
    if not value:
        return False
    return normalize_channel(value) in OTA_CHANNELS


def normalize_channel(value: str | None) -> str:
    """Map a raw channel value (e.g. Channex ``ota_name``) onto the
    canonical key used throughout the PMS.

    Empty/missing input falls back to ``"channex"`` — preserves the
    legacy default used by the inbound pipeline before normalization
    landed (so a behavior change is opt-in via the alias table, not a
    blanket rewrite of unknown sources).
    """
    if not value:
        return "channex"
    key = value.strip().lower()
    if not key:
        return "channex"
    return _CHANNEL_ALIASES.get(key, key)


def channel_label(value: str | None) -> str:
    """Map a raw channel value onto the human-facing OTA label used in
    host-notification emails. Falls back to ``"OTA"`` for the
    direct/missing/channex sentinels (matches the original spec from
    VAY-315 — hosts see "OTA" rather than the internal sentinel)."""
    if not value:
        return "OTA"
    canonical = normalize_channel(value)
    if canonical in {"direct", "channex"}:
        return "OTA"
    if canonical in CHANNEL_LABELS:
        return CHANNEL_LABELS[canonical]
    # Unknown but non-sentinel value — surface a tidy form rather than
    # snake_case so unfamiliar OTAs are still readable in emails.
    return value.replace("_", " ").title()
