"""Device request/response schemas."""

from datetime import datetime

from pydantic import BaseModel


class DeviceRegisterRequest(BaseModel):
    fingerprint: str
    hostname: str = ""
    os_version: str = ""


class DeviceResponse(BaseModel):
    device_id: str
    fingerprint: str
    hostname: str
    os_version: str
    is_active: bool
    registered_at: datetime
    last_seen_at: datetime


class DeviceListResponse(BaseModel):
    devices: list[DeviceResponse]
    devices_used: int
    max_devices: int
