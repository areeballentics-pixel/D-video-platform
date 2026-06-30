"""Security utilities: JWT tokens, password hashing, master key encryption."""

import uuid
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet
from jose import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ─── Password Hashing ───

def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ─── JWT Tokens ───

def create_access_token(user_id: str, tenant_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": user_id,
        "tenant_id": tenant_id,
        "role": role,
        # `iat` lets get_current_user reject tokens minted before a password
        # reset (compared against User.tokens_valid_from). QA SP-001.
        "iat": now,
        "exp": expire,
        "type": "access",
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": user_id,
        "exp": expire,
        "type": "refresh",
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


# ─── Master Admin Tokens ───
#
# Distinct `type` claim ("master_access" / "master_refresh") prevents a
# tenant token from ever being accepted on master endpoints (and vice
# versa). Same secret key — the type check is the security boundary.

def create_master_access_token(admin_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": admin_id,
        "exp": expire,
        "type": "master_access",
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_master_refresh_token(admin_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": admin_id,
        "exp": expire,
        "type": "master_refresh",
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def verify_token(token: str) -> dict:
    """Verify and decode a JWT token. Raises jose.JWTError on failure."""
    return jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])


# ─── Master Key Encryption (at rest) ───

def get_fernet() -> Fernet:
    """Get a Fernet instance for encrypting/decrypting tenant master keys."""
    # In production, SERVER_ENCRYPTION_KEY must be a valid Fernet key (base64-encoded 32 bytes)
    return Fernet(settings.SERVER_ENCRYPTION_KEY)


def encrypt_master_key(raw_key: bytes) -> bytes:
    return get_fernet().encrypt(raw_key)


def decrypt_master_key(encrypted_key: bytes) -> bytes:
    return get_fernet().decrypt(encrypted_key)
