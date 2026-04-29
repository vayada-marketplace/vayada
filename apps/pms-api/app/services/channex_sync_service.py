"""Backward-compat re-exports from the ``app.services.channex`` package.

The module was split out for readability — see audit #5. New code should
import directly from ``app.services.channex.<submodule>``. Existing
imports + class-level test patches keep working through this facade.
"""
from app.services.channex._common import (
    SYNC_HORIZON_DAYS,
    CHANNEX_SYNC_REASON,
    _count_local_blocks,
)
from app.services.channex.provisioning import provision_property
from app.services.channex.ari_push import (
    push_availability_for_room_type,
    push_restrictions_for_rate_plan,
    push_cancellation_policy_for_room_type,
    _build_restriction_entry,
    _restrictions_equal,
    _restriction_to_value,
    _build_cancellation_policy,
)
from app.services.channex.orchestrator import (
    push_ari_for_hotel,
    push_ari_for_booking,
)
from app.services.channex.inbound import (
    process_inbound_booking,
    poll_bookings_for_hotel,
    _apply_booking_modification,
)
from app.services.channex.outbound import handle_vayada_cancellation

# Symbols re-exported so test patches and other callers that look them up
# via this module's namespace keep finding the same class/module objects
# they used before the split. Class-level patches (e.g.
# patch("app.services.channex_sync_service.ChannexConnectionRepository.foo"))
# remain robust because they mutate the class attribute, not this binding.
from app.repositories.channex_mapping_repo import (  # noqa: F401
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
    ChannexRatePlanMappingRepository,
    ChannexBookingMappingRepository,
    ChannexChannelMarkupRepository,
)
from app.repositories.room_type_repo import RoomTypeRepository  # noqa: F401
from app.repositories.booking_repo import BookingRepository  # noqa: F401
from app.services import channex_service  # noqa: F401
