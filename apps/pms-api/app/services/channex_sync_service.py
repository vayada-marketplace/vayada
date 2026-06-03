"""Backward-compat re-exports from the ``app.services.channex`` package.

The module was split out for readability — see audit #5. New code should
import directly from ``app.services.channex.<submodule>``. Existing
imports + class-level test patches keep working through this facade.

Every import below is intentionally "unused" inside this file — they're
re-exports for legacy callers and class-level test patches. Each carries
``# noqa: F401`` so Ruff/pyflakes does not strip them on auto-fix.
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
from app.services.channex._common import (  # noqa: F401
    CHANNEX_SYNC_REASON,
    SYNC_HORIZON_DAYS,
    _count_local_blocks,
)
from app.services.channex.ari_push import (  # noqa: F401
    _build_cancellation_policy,
    _build_restriction_entry,
    _restriction_to_value,
    _restrictions_equal,
    push_availability_for_room_type,
    push_cancellation_policy_for_room_type,
    push_restrictions_for_rate_plan,
)
from app.services.channex.inbound import (  # noqa: F401
    _apply_booking_modification,
    poll_bookings_for_hotel,
    process_inbound_booking,
)
from app.services.channex.orchestrator import (  # noqa: F401
    push_ari_for_booking,
    push_ari_for_hotel,
    push_ari_for_room_type,
)
from app.services.channex.outbound import handle_vayada_cancellation  # noqa: F401
from app.services.channex.provisioning import provision_property  # noqa: F401
