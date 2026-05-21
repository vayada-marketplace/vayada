"""
CreatorProfileService — single source of truth for the
dynamic-UPDATE-creators + replace-platforms transaction shared by the
self-service router (PUT /creators/me) and the admin router
(PUT /admin/users/{id}/profile/creator).
"""
import json
from decimal import Decimal

from app.database import Database


class CreatorProfileService:

    @staticmethod
    async def update(creator_id: str, request) -> None:
        """Apply partial creator-profile update + replace platforms when provided.

        `request` may be either creators.UpdateCreatorProfileRequest or
        admin.UpdateCreatorProfileRequest — both expose the same field names.
        Platform analytics fields can be either dicts or pydantic models with
        .model_dump(); we normalize both.
        """
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                update_fields: list[str] = []
                update_values: list = []
                pc = 1

                if request.location is not None:
                    update_fields.append(f"location = ${pc}")
                    update_values.append(request.location)
                    pc += 1
                if request.shortDescription is not None:
                    update_fields.append(f"short_description = ${pc}")
                    update_values.append(request.shortDescription)
                    pc += 1
                if request.portfolioLink is not None:
                    update_fields.append(f"portfolio_link = ${pc}")
                    update_values.append(str(request.portfolioLink))
                    pc += 1
                if request.phone is not None:
                    update_fields.append(f"phone = ${pc}")
                    update_values.append(request.phone)
                    pc += 1
                if request.profilePicture is not None:
                    update_fields.append(f"profile_picture = ${pc}")
                    update_values.append(request.profilePicture)
                    pc += 1
                if request.creatorType is not None:
                    update_fields.append(f"creator_type = ${pc}")
                    update_values.append(request.creatorType)
                    pc += 1

                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(creator_id)
                    query = f"UPDATE creators SET {', '.join(update_fields)} WHERE id = ${pc}"
                    await conn.execute(query, *update_values)

                if request.platforms is not None:
                    await conn.execute(
                        "DELETE FROM creator_platforms WHERE creator_id = $1",
                        creator_id,
                    )
                    for platform in request.platforms:
                        top_countries_data = _to_jsonb(platform.topCountries)
                        top_age_groups_data = _to_jsonb(platform.topAgeGroups)
                        gender_split_data = _to_jsonb(platform.genderSplit)

                        await conn.execute(
                            """
                            INSERT INTO creator_platforms
                            (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            """,
                            creator_id,
                            platform.name,
                            platform.handle,
                            platform.followers,
                            Decimal(str(platform.engagementRate)),
                            top_countries_data,
                            top_age_groups_data,
                            gender_split_data,
                        )


def _to_jsonb(value) -> str | None:
    """Serialize a list-of-models / single-model / list-of-dicts / dict into a JSON string for asyncpg."""
    if value is None:
        return None
    if isinstance(value, list):
        return json.dumps([v if isinstance(v, dict) else v.model_dump() for v in value])
    if isinstance(value, dict):
        return json.dumps(value)
    return json.dumps(value.model_dump())
