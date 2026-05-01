"""
ListingService — single source of truth for hotel-listing CRUD.

Both the hotel self-service router (POST/PUT/DELETE /hotels/me/listings)
and the admin router (POST/PUT/DELETE /admin/users/{id}/listings) used to
hold copies of the same multi-table transaction. The admin copy silently
dropped `creator_types` from listing_creator_requirements; centralizing
the writes here removes that drift.
"""
from typing import List, Optional

from app.database import Database
from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
)
from app.models.hotels import (
    CreateListingRequest,
    ListingResponse,
    UpdateListingRequest,
)
from app.repositories.hotel_repo import HotelRepository


class ListingService:

    @staticmethod
    async def get_with_details(
        listing_id: str,
        hotel_profile_id: str,
    ) -> Optional[dict]:
        """Fetch listing + offerings + requirements, or None if listing missing."""
        listing = await HotelRepository.get_listing(listing_id, hotel_profile_id)
        if not listing:
            return None
        offerings = await HotelRepository.get_offerings(listing_id)
        requirements = await HotelRepository.get_requirements(listing_id)
        return {
            "listing": listing,
            "offerings": offerings,
            "requirements": requirements,
        }

    @staticmethod
    async def create(
        hotel_profile_id: str,
        request: CreateListingRequest,
        *,
        initial_status: Optional[str] = None,
    ) -> dict:
        """Create listing, offerings, and requirements atomically."""
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                if initial_status is not None:
                    listing_row = await conn.fetchrow(
                        """
                        INSERT INTO hotel_listings
                        (hotel_profile_id, name, location, description, accommodation_type, images, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        RETURNING id, hotel_profile_id, name, location, description, accommodation_type, images,
                                  status, created_at, updated_at
                        """,
                        hotel_profile_id, request.name, request.location, request.description,
                        request.accommodationType, request.images, initial_status,
                    )
                    listing = dict(listing_row)
                else:
                    listing = await HotelRepository.create_listing(
                        hotel_profile_id, request.name, request.location, request.description,
                        request.accommodationType, request.images, conn=conn,
                    )
                    listing.setdefault('hotel_profile_id', hotel_profile_id)

                listing_id = listing['id']

                offerings: List[dict] = []
                for offering in request.collaborationOfferings:
                    o = await HotelRepository.create_offering(
                        listing_id,
                        offering.collaborationType,
                        offering.availabilityMonths,
                        offering.platforms,
                        offering.freeStayMinNights,
                        offering.freeStayMaxNights,
                        offering.paidMaxAmount,
                        offering.discountPercentage,
                        offering.currency,
                        offering.commissionPercentage,
                        offering.minFollowers,
                        conn=conn,
                    )
                    o.setdefault('listing_id', listing_id)
                    offerings.append(o)

                requirements = await HotelRepository.create_requirements(
                    listing_id,
                    request.creatorRequirements.platforms,
                    request.creatorRequirements.minFollowers,
                    request.creatorRequirements.topCountries,
                    request.creatorRequirements.targetAgeMin,
                    request.creatorRequirements.targetAgeMax,
                    request.creatorRequirements.targetAgeGroups or [],
                    request.creatorRequirements.creatorTypes or [],
                    conn=conn,
                )
                requirements.setdefault('listing_id', listing_id)

        return {
            "listing": listing,
            "offerings": offerings,
            "requirements": requirements,
        }

    @staticmethod
    async def update(
        listing_id: str,
        request: UpdateListingRequest,
    ) -> None:
        """Patch listing fields, replace offerings/requirements when provided."""
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                update_fields: List[str] = []
                update_values: list = []
                pc = 1

                if request.name is not None:
                    update_fields.append(f"name = ${pc}")
                    update_values.append(request.name)
                    pc += 1
                if request.location is not None:
                    update_fields.append(f"location = ${pc}")
                    update_values.append(request.location)
                    pc += 1
                if request.description is not None:
                    update_fields.append(f"description = ${pc}")
                    update_values.append(request.description)
                    pc += 1
                if request.accommodationType is not None:
                    update_fields.append(f"accommodation_type = ${pc}")
                    update_values.append(request.accommodationType)
                    pc += 1
                if request.images is not None:
                    update_fields.append(f"images = ${pc}")
                    update_values.append(request.images)
                    pc += 1

                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(listing_id)
                    query = f"UPDATE hotel_listings SET {', '.join(update_fields)} WHERE id = ${pc}"
                    await conn.execute(query, *update_values)

                if request.collaborationOfferings is not None:
                    await HotelRepository.delete_offerings(listing_id, conn=conn)
                    for offering in request.collaborationOfferings:
                        await HotelRepository.create_offering(
                            listing_id,
                            offering.collaborationType,
                            offering.availabilityMonths,
                            offering.platforms,
                            offering.freeStayMinNights,
                            offering.freeStayMaxNights,
                            offering.paidMaxAmount,
                            offering.discountPercentage,
                            offering.currency,
                            offering.commissionPercentage,
                            offering.minFollowers,
                            conn=conn,
                        )

                if request.creatorRequirements is not None:
                    await HotelRepository.delete_requirements(listing_id, conn=conn)
                    await HotelRepository.create_requirements(
                        listing_id,
                        request.creatorRequirements.platforms,
                        request.creatorRequirements.minFollowers,
                        request.creatorRequirements.topCountries,
                        request.creatorRequirements.targetAgeMin,
                        request.creatorRequirements.targetAgeMax,
                        request.creatorRequirements.targetAgeGroups or [],
                        request.creatorRequirements.creatorTypes or [],
                        conn=conn,
                    )

    @staticmethod
    async def delete(listing_id: str) -> None:
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await HotelRepository.delete_offerings(listing_id, conn=conn)
                await HotelRepository.delete_requirements(listing_id, conn=conn)
                await HotelRepository.delete_listing(listing_id, conn=conn)


def build_listing_response(
    data: dict,
    *,
    hotel_profile_id: Optional[str] = None,
) -> ListingResponse:
    """Assemble a ListingResponse from {listing, offerings, requirements}."""
    listing = data["listing"]
    listing_id = listing['id']

    offerings_response = [
        CollaborationOfferingResponse.model_validate({
            "id": str(o['id']),
            "listing_id": str(o.get('listing_id', listing_id)),
            "collaboration_type": o['collaboration_type'],
            "availability_months": o['availability_months'],
            "platforms": o['platforms'],
            "free_stay_min_nights": o['free_stay_min_nights'],
            "free_stay_max_nights": o['free_stay_max_nights'],
            "paid_max_amount": o['paid_max_amount'],
            "currency": o.get('currency'),
            "discount_percentage": o['discount_percentage'],
            "commission_percentage": o.get('commission_percentage'),
            "min_followers": o.get('min_followers'),
            "created_at": o['created_at'],
            "updated_at": o['updated_at'],
        })
        for o in data["offerings"]
    ]

    requirements = data.get("requirements")
    requirements_response = None
    if requirements:
        requirements_response = CreatorRequirementsResponse.model_validate({
            "id": str(requirements['id']),
            "listing_id": str(requirements.get('listing_id', listing_id)),
            "platforms": requirements['platforms'],
            "min_followers": requirements['min_followers'],
            "target_countries": requirements['target_countries'],
            "target_age_min": requirements['target_age_min'],
            "target_age_max": requirements['target_age_max'],
            "target_age_groups": requirements['target_age_groups'],
            "creator_types": requirements.get('creator_types'),
            "created_at": requirements['created_at'],
            "updated_at": requirements['updated_at'],
        })

    effective_profile_id = hotel_profile_id or listing.get('hotel_profile_id')

    return ListingResponse.model_validate({
        "id": str(listing_id),
        "hotel_profile_id": str(effective_profile_id),
        "name": listing['name'],
        "location": listing['location'],
        "description": listing.get('description'),
        "accommodation_type": listing['accommodation_type'],
        "images": listing.get('images') or [],
        "status": listing['status'],
        "created_at": listing['created_at'],
        "updated_at": listing['updated_at'],
        "collaboration_offerings": offerings_response,
        "creator_requirements": requirements_response,
    })
