def room_allows_guest_mix(
    room: dict,
    adults: int | None,
    children: int | None,
    units: int = 1,
) -> bool:
    """Return whether a requested party fits the room's occupancy limits,
    scaled by ``units`` for multi-room bookings (VAY-492).

    ``units`` defaults to 1 (single-room booking). Pass the total physical
    rooms of this type — ``total_rooms`` at search-filter time, or
    ``number_of_rooms`` at booking-validation time — so a party that
    overflows one unit can still be accommodated across several.
    """
    if adults is None and children is None:
        return True

    adult_count = int(adults or 0)
    child_count = int(children or 0)
    total_guests = adult_count + child_count

    unit_count = max(1, int(units))

    if total_guests > int(room.get("max_occupancy") or 0) * unit_count:
        return False

    max_adults = room.get("max_adults")
    if max_adults is not None and adult_count > int(max_adults) * unit_count:
        return False

    max_children = room.get("max_children")
    if max_children is not None and child_count > int(max_children) * unit_count:
        return False

    return True
