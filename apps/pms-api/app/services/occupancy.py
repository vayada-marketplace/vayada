def room_allows_guest_mix(
    room: dict,
    adults: int | None,
    children: int | None,
) -> bool:
    """Return whether a requested party fits the room's occupancy limits."""
    if adults is None and children is None:
        return True

    adult_count = int(adults or 0)
    child_count = int(children or 0)
    total_guests = adult_count + child_count

    if total_guests > int(room.get("max_occupancy") or 0):
        return False

    max_adults = room.get("max_adults")
    if max_adults is not None and adult_count > int(max_adults):
        return False

    max_children = room.get("max_children")
    if max_children is not None and child_count > int(max_children):
        return False

    return True
