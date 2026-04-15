"""arq worker settings — defines available jobs and Redis connection."""

from arq.connections import RedisSettings

from app.config import settings
from app.worker.encryption_job import encrypt_video_job


# Parse DSN, then widen the Redis connection timeouts.
# arq's default conn_timeout is 1s — too aggressive for Docker-internal
# DNS (resolving `redis` hostname on first use can take several seconds
# on a cold container). This caused the worker thread to crash on boot
# in production with `redis.exceptions.TimeoutError: Timeout connecting
# to server` while the main FastAPI process (which uses redis-py's own
# no-timeout default) connected fine.
_redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
_redis_settings.conn_timeout = 30
_redis_settings.conn_retries = 10
_redis_settings.conn_retry_delay = 2


class WorkerSettings:
    """arq worker configuration."""

    # Available job functions
    functions = [encrypt_video_job]

    # Redis connection (widened timeouts for Docker networks)
    redis_settings = _redis_settings

    # Worker settings
    max_jobs = 2  # Max concurrent jobs (limit CPU usage)
    job_timeout = 1800  # 30 minutes max per job
    max_tries = 2  # Retry once on failure
    health_check_interval = 30
