"""Redis client for sessions, rate limiting, and caching."""

import redis.asyncio as redis

from app.config import settings

redis_client: redis.Redis | None = None


async def init_redis() -> redis.Redis:
    """Initialize the Redis connection."""
    global redis_client
    redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    return redis_client


async def close_redis():
    """Close the Redis connection."""
    global redis_client
    if redis_client:
        await redis_client.close()
        redis_client = None


def get_redis() -> redis.Redis:
    """Get the current Redis client. Must call init_redis() first."""
    if redis_client is None:
        raise RuntimeError("Redis not initialized. Call init_redis() first.")
    return redis_client
