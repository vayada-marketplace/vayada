"""Backward-compat re-exports from the ``app.services.channex`` package.

The module was split out for readability — see audit #5. New code should
import directly from ``app.services.channex.<submodule>``. Existing
imports + class-level test patches keep working through this facade.
"""

# Symbols re-exported so test patches and other callers that look them up
# via this module's namespace keep finding the same class/module objects
# they used before the split. Class-level patches (e.g.
# patch("app.services.channex_sync_service.ChannexConnectionRepository.foo"))
# remain robust because they mutate the class attribute, not this binding.
from app.repositories.booking_repo import BookingRepository  # noqa: F401
from app.repositories.channex_mapping_repo import (  # noqa: F401
    ChannexBookingMappingRepository,
    ChannexChannelMarkupRepository,
    ChannexConnectionRepository,
    ChannexRatePlanMappingRepository,
    ChannexRoomTypeMappingRepository,
)
from app.repositories.room_type_repo import RoomTypeRepository  # noqa: F401
from app.services import channex_service  # noqa: F401
