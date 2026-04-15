"""Application configuration via environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ─── Database ───
    DATABASE_URL: str = "postgresql+asyncpg://svp:svp_dev_password@localhost:5433/secure_video_platform"

    # ─── Redis ───
    REDIS_URL: str = "redis://localhost:6379/0"

    # ─── JWT ───
    JWT_SECRET_KEY: str = "dev-secret-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120  # 2 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ─── Encryption ───
    # Used to encrypt tenant master keys at rest in the database.
    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    SERVER_ENCRYPTION_KEY: str = "uwO8nsQMoodLhm1aPlcIDER4TZOUBzea3usWWAPN_1o="

    # ─── Admin ───
    ADMIN_API_KEY: str = "dev-admin-key-change-in-production"

    # ─── Device Policies (defaults, overridable per tenant) ───
    DEFAULT_MAX_DEVICES: int = 2
    DEFAULT_MAX_DEVICE_CHANGES_PER_30D: int = 2
    DEFAULT_OFFLINE_GRACE_DAYS: int = 20

    # ─── CORS ───
    # Comma-separated list of additional origins to allow (in addition to the
    # built-in localhost defaults for local dev).
    # Example: "https://admin.yourplatform.com,https://app.yourplatform.com"
    ALLOWED_ORIGINS: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
