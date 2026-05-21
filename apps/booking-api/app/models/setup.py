from pydantic import BaseModel
from typing import Optional


class SetupPrefillData(BaseModel):
    property_name: Optional[str] = None
    reservation_email: Optional[str] = None
    phone_number: Optional[str] = None
    address: Optional[str] = None
    hero_image: Optional[str] = None


class SetupStatusResponse(BaseModel):
    setup_complete: bool
    missing_fields: list[str]
    prefill_data: Optional[SetupPrefillData] = None
