"""
HotelProfileService — partial-update helper shared by the self-service
hotel profile route (PUT /hotels/me) and the admin override
(PUT /admin/users/{id}/profile/hotel).

The dynamic-UPDATE field building lived inline in both routers.
"""

from app.repositories.hotel_repo import HotelRepository

_ALLOWED_FIELDS = ("name", "location", "about", "website", "phone", "picture")


class HotelProfileService:
    @staticmethod
    async def apply_partial(
        profile_id: str,
        *,
        name: str | None = None,
        location: str | None = None,
        about: str | None = None,
        website: str | None = None,
        phone: str | None = None,
        picture: str | None = None,
    ) -> None:
        """Update only the provided columns on hotel_profiles.

        Callers pass plain strings — pydantic URL-typed fields should be
        coerced with ``str(...)`` first.
        """
        provided = {
            "name": name,
            "location": location,
            "about": about,
            "website": website,
            "phone": phone,
            "picture": picture,
        }
        update_fields: list[str] = []
        update_values: list = []
        pc = 1
        for column in _ALLOWED_FIELDS:
            value = provided[column]
            if value is None:
                continue
            update_fields.append(f"{column} = ${pc}")
            update_values.append(value)
            pc += 1

        if update_fields:
            await HotelRepository.update_profile(profile_id, update_fields, update_values)
