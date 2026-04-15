"""arq worker settings — defines available jobs and Redis connection."""

from arq.connections import RedisSettings

from app.config import settings
from app.worker.encryption_job import encrypt_video_job


class WorkerSettings:
    """arq worker configuration."""

    # Available job functions
    functions = [encrypt_video_job]

    # Redis connection
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)

    # Worker settings
    max_jobs = 2  # Max concurrent jobs (limit CPU usage)
    job_timeout = 1800  # 30 minutes max per job
    max_tries = 2  # Retry once on failure
    health_check_interval = 30
