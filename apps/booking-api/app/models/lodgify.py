"""Pydantic request / response models for the Lodgify integration."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class LodgifyConnectRequest(BaseModel):
    api_key: str = Field(min_length=8, description="Lodgify API key for the property owner")
    lodgify_property_id: str = Field(min_length=1, description="Lodgify property ID to bind this Vayada hotel to")


class LodgifyConnectionStatus(BaseModel):
    connected: bool
    status: str = "disconnected"
    lodgify_property_id: Optional[str] = None
    lodgify_property_name: Optional[str] = None
    last_validated_at: Optional[datetime] = None
    last_error: Optional[str] = None
