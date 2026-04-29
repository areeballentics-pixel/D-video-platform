"""SQLAlchemy models — import all models here so Alembic can discover them."""

from app.models.audit_log import AuditLog
from app.models.course import Course, CourseVideo
from app.models.device import Device, DeviceChange
from app.models.encryptor_device import EncryptorDevice
from app.models.enrollment import Enrollment
from app.models.piracy_report import PiracyReport
from app.models.platform_admin import PlatformAdmin
from app.models.seat_upgrade_request import SeatUpgradeRequest
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.models.watch_event import WatchAggregate, WatchEvent

__all__ = [
    "AuditLog",
    "Course",
    "CourseVideo",
    "Device",
    "DeviceChange",
    "EncryptorDevice",
    "Enrollment",
    "PiracyReport",
    "PlatformAdmin",
    "SeatUpgradeRequest",
    "Tenant",
    "User",
    "Video",
    "WatchAggregate",
    "WatchEvent",
]
