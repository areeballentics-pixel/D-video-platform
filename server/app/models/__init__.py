"""SQLAlchemy models — import all models here so Alembic can discover them."""

from app.models.tenant import Tenant
from app.models.user import User
from app.models.device import Device, DeviceChange
from app.models.license import License
from app.models.video import Video
from app.models.piracy_report import PiracyReport
from app.models.platform_admin import PlatformAdmin

__all__ = [
    "Tenant",
    "User",
    "Device",
    "DeviceChange",
    "License",
    "Video",
    "PiracyReport",
    "PlatformAdmin",
]
