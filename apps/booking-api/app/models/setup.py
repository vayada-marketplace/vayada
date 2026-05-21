from pydantic import BaseModel


class SetupPrefillData(BaseModel):
    property_name: str | None = None
    reservation_email: str | None = None
    phone_number: str | None = None
    address: str | None = None
    hero_image: str | None = None


class SetupStatusResponse(BaseModel):
    setup_complete: bool
    missing_fields: list[str]
    prefill_data: SetupPrefillData | None = None
