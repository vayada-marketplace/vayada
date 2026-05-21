"""
Trip and External Collaboration routes
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status

from app.dependencies import get_current_creator_id
from app.models.trips import (
    CreateExternalCollaborationRequest,
    CreateTripRequest,
    ExternalCollaborationResponse,
    TripResponse,
    UpdateExternalCollaborationRequest,
    UpdateTripRequest,
)
from app.repositories.trip_repo import ExternalCollaborationRepository, TripRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/trips", tags=["trips"])


# ============================================
# TRIP ENDPOINTS
# ============================================


@router.post("", response_model=TripResponse, status_code=http_status.HTTP_201_CREATED)
async def create_trip(
    request: CreateTripRequest,
    creator_id: str = Depends(get_current_creator_id),
):
    """Create a new trip for the authenticated creator."""
    try:
        if request.end_date < request.start_date:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="end_date must be >= start_date",
            )

        trip = await TripRepository.create(
            creator_id=creator_id,
            name=request.name,
            location=request.location,
            start_date=request.start_date,
            end_date=request.end_date,
            notes=request.notes,
        )

        return TripResponse(
            id=str(trip["id"]),
            creator_id=str(trip["creator_id"]),
            name=trip["name"],
            location=trip["location"],
            start_date=trip["start_date"],
            end_date=trip["end_date"],
            notes=trip["notes"],
            created_at=trip["created_at"],
            updated_at=trip["updated_at"],
            external_collaborations=[],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating trip: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create trip"
        )


@router.get("", response_model=list[TripResponse])
async def list_trips(
    creator_id: str = Depends(get_current_creator_id),
):
    """List all trips for the authenticated creator."""
    try:
        trips = await TripRepository.list_by_creator(creator_id)

        response = []
        for trip in trips:
            # Fetch external collaborations for each trip
            ext_collabs = await ExternalCollaborationRepository.list_by_trip(str(trip["id"]))
            ext_collab_responses = [
                ExternalCollaborationResponse(
                    id=str(ec["id"]),
                    creator_id=str(ec["creator_id"]),
                    trip_id=str(ec["trip_id"]) if ec["trip_id"] else None,
                    title=ec["title"],
                    hotel_name=ec["hotel_name"],
                    location=ec["location"],
                    collaboration_type=ec["collaboration_type"],
                    start_date=ec["start_date"],
                    end_date=ec["end_date"],
                    deliverables=ec["deliverables"],
                    notes=ec["notes"],
                    created_at=ec["created_at"],
                    updated_at=ec["updated_at"],
                )
                for ec in ext_collabs
            ]

            response.append(
                TripResponse(
                    id=str(trip["id"]),
                    creator_id=str(trip["creator_id"]),
                    name=trip["name"],
                    location=trip["location"],
                    start_date=trip["start_date"],
                    end_date=trip["end_date"],
                    notes=trip["notes"],
                    created_at=trip["created_at"],
                    updated_at=trip["updated_at"],
                    external_collaborations=ext_collab_responses,
                )
            )

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing trips: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to list trips"
        )


@router.get("/{trip_id}", response_model=TripResponse)
async def get_trip(
    trip_id: str,
    creator_id: str = Depends(get_current_creator_id),
):
    """Get a trip by ID with its external collaborations."""
    try:
        trip = await TripRepository.get_by_id_and_creator(trip_id, creator_id)

        if not trip:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found")

        # Fetch external collaborations linked to this trip
        ext_collabs = await ExternalCollaborationRepository.list_by_trip(trip_id)
        ext_collab_responses = [
            ExternalCollaborationResponse(
                id=str(ec["id"]),
                creator_id=str(ec["creator_id"]),
                trip_id=str(ec["trip_id"]) if ec["trip_id"] else None,
                title=ec["title"],
                hotel_name=ec["hotel_name"],
                location=ec["location"],
                collaboration_type=ec["collaboration_type"],
                start_date=ec["start_date"],
                end_date=ec["end_date"],
                deliverables=ec["deliverables"],
                notes=ec["notes"],
                created_at=ec["created_at"],
                updated_at=ec["updated_at"],
            )
            for ec in ext_collabs
        ]

        return TripResponse(
            id=str(trip["id"]),
            creator_id=str(trip["creator_id"]),
            name=trip["name"],
            location=trip["location"],
            start_date=trip["start_date"],
            end_date=trip["end_date"],
            notes=trip["notes"],
            created_at=trip["created_at"],
            updated_at=trip["updated_at"],
            external_collaborations=ext_collab_responses,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting trip: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to get trip"
        )


@router.put("/{trip_id}", response_model=TripResponse)
async def update_trip(
    trip_id: str,
    request: UpdateTripRequest,
    creator_id: str = Depends(get_current_creator_id),
):
    """Update a trip owned by the authenticated creator."""
    try:
        # Verify ownership
        existing = await TripRepository.get_by_id_and_creator(trip_id, creator_id)
        if not existing:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found")

        # Validate date range if dates are being updated
        new_start = request.start_date if request.start_date is not None else existing["start_date"]
        new_end = request.end_date if request.end_date is not None else existing["end_date"]
        if new_end < new_start:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="end_date must be >= start_date",
            )

        update_data = request.model_dump(exclude_none=True)
        trip = await TripRepository.update(trip_id, **update_data)

        if not trip:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found")

        # Fetch external collaborations
        ext_collabs = await ExternalCollaborationRepository.list_by_trip(trip_id)
        ext_collab_responses = [
            ExternalCollaborationResponse(
                id=str(ec["id"]),
                creator_id=str(ec["creator_id"]),
                trip_id=str(ec["trip_id"]) if ec["trip_id"] else None,
                title=ec["title"],
                hotel_name=ec["hotel_name"],
                location=ec["location"],
                collaboration_type=ec["collaboration_type"],
                start_date=ec["start_date"],
                end_date=ec["end_date"],
                deliverables=ec["deliverables"],
                notes=ec["notes"],
                created_at=ec["created_at"],
                updated_at=ec["updated_at"],
            )
            for ec in ext_collabs
        ]

        return TripResponse(
            id=str(trip["id"]),
            creator_id=str(trip["creator_id"]),
            name=trip["name"],
            location=trip["location"],
            start_date=trip["start_date"],
            end_date=trip["end_date"],
            notes=trip["notes"],
            created_at=trip["created_at"],
            updated_at=trip["updated_at"],
            external_collaborations=ext_collab_responses,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating trip: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to update trip"
        )


@router.delete("/{trip_id}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_trip(
    trip_id: str,
    creator_id: str = Depends(get_current_creator_id),
):
    """Delete a trip owned by the authenticated creator."""
    try:
        # Verify ownership
        existing = await TripRepository.get_by_id_and_creator(trip_id, creator_id)
        if not existing:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found")

        await TripRepository.delete(trip_id)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting trip: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to delete trip"
        )


# ============================================
# EXTERNAL COLLABORATION ENDPOINTS
# ============================================


@router.post(
    "/external-collaborations",
    response_model=ExternalCollaborationResponse,
    status_code=http_status.HTTP_201_CREATED,
)
async def create_external_collaboration(
    request: CreateExternalCollaborationRequest,
    creator_id: str = Depends(get_current_creator_id),
):
    """Create a new external collaboration for the authenticated creator."""
    try:
        if request.end_date < request.start_date:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="end_date must be >= start_date",
            )

        # Validate trip ownership if trip_id is provided
        if request.trip_id:
            trip = await TripRepository.get_by_id_and_creator(request.trip_id, creator_id)
            if not trip:
                raise HTTPException(
                    status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found"
                )

        collab = await ExternalCollaborationRepository.create(
            creator_id=creator_id,
            title=request.title,
            start_date=request.start_date,
            end_date=request.end_date,
            trip_id=request.trip_id,
            hotel_name=request.hotel_name,
            location=request.location,
            collaboration_type=request.collaboration_type,
            deliverables=request.deliverables,
            notes=request.notes,
        )

        return ExternalCollaborationResponse(
            id=str(collab["id"]),
            creator_id=str(collab["creator_id"]),
            trip_id=str(collab["trip_id"]) if collab["trip_id"] else None,
            title=collab["title"],
            hotel_name=collab["hotel_name"],
            location=collab["location"],
            collaboration_type=collab["collaboration_type"],
            start_date=collab["start_date"],
            end_date=collab["end_date"],
            deliverables=collab["deliverables"],
            notes=collab["notes"],
            created_at=collab["created_at"],
            updated_at=collab["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating external collaboration: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create external collaboration",
        )


@router.get("/external-collaborations", response_model=list[ExternalCollaborationResponse])
async def list_external_collaborations(
    creator_id: str = Depends(get_current_creator_id),
):
    """List all external collaborations for the authenticated creator."""
    try:
        collabs = await ExternalCollaborationRepository.list_by_creator(creator_id)

        return [
            ExternalCollaborationResponse(
                id=str(c["id"]),
                creator_id=str(c["creator_id"]),
                trip_id=str(c["trip_id"]) if c["trip_id"] else None,
                title=c["title"],
                hotel_name=c["hotel_name"],
                location=c["location"],
                collaboration_type=c["collaboration_type"],
                start_date=c["start_date"],
                end_date=c["end_date"],
                deliverables=c["deliverables"],
                notes=c["notes"],
                created_at=c["created_at"],
                updated_at=c["updated_at"],
            )
            for c in collabs
        ]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing external collaborations: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list external collaborations",
        )


@router.put("/external-collaborations/{collab_id}", response_model=ExternalCollaborationResponse)
async def update_external_collaboration(
    collab_id: str,
    request: UpdateExternalCollaborationRequest,
    creator_id: str = Depends(get_current_creator_id),
):
    """Update an external collaboration owned by the authenticated creator."""
    try:
        # Verify ownership
        existing = await ExternalCollaborationRepository.get_by_id_and_creator(
            collab_id, creator_id
        )
        if not existing:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="External collaboration not found",
            )

        # Validate date range if dates are being updated
        new_start = request.start_date if request.start_date is not None else existing["start_date"]
        new_end = request.end_date if request.end_date is not None else existing["end_date"]
        if new_end < new_start:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="end_date must be >= start_date",
            )

        # Validate trip ownership if trip_id is being updated
        if request.trip_id:
            trip = await TripRepository.get_by_id_and_creator(request.trip_id, creator_id)
            if not trip:
                raise HTTPException(
                    status_code=http_status.HTTP_404_NOT_FOUND, detail="Trip not found"
                )

        update_data = request.model_dump(exclude_none=True)
        collab = await ExternalCollaborationRepository.update(collab_id, **update_data)

        if not collab:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="External collaboration not found",
            )

        return ExternalCollaborationResponse(
            id=str(collab["id"]),
            creator_id=str(collab["creator_id"]),
            trip_id=str(collab["trip_id"]) if collab["trip_id"] else None,
            title=collab["title"],
            hotel_name=collab["hotel_name"],
            location=collab["location"],
            collaboration_type=collab["collaboration_type"],
            start_date=collab["start_date"],
            end_date=collab["end_date"],
            deliverables=collab["deliverables"],
            notes=collab["notes"],
            created_at=collab["created_at"],
            updated_at=collab["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating external collaboration: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update external collaboration",
        )


@router.delete("/external-collaborations/{collab_id}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_external_collaboration(
    collab_id: str,
    creator_id: str = Depends(get_current_creator_id),
):
    """Delete an external collaboration owned by the authenticated creator."""
    try:
        # Verify ownership
        existing = await ExternalCollaborationRepository.get_by_id_and_creator(
            collab_id, creator_id
        )
        if not existing:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="External collaboration not found",
            )

        await ExternalCollaborationRepository.delete(collab_id)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting external collaboration: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete external collaboration",
        )
