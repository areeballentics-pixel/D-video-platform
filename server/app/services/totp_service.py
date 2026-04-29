"""TOTP-based 2FA for platform admins.

Standard time-based one-time password (RFC 6238) with a 30-second period and
6-digit codes — compatible with Google Authenticator, Authy, 1Password, etc.

Setup flow:
  1. POST /api/master/me/totp/enable → returns { secret, otpauth_uri } once
  2. Admin scans the QR (or types secret) into their authenticator
  3. POST /api/master/me/totp/confirm with the current 6-digit code →
     server verifies + flips totp_enabled=True
  4. Subsequent /api/master/login calls require the code in addition to password.
"""

import pyotp


_ISSUER = "SVP Master"


def generate_secret() -> str:
    """Return a fresh base32-encoded TOTP secret (32 chars)."""
    return pyotp.random_base32()


def provisioning_uri(email: str, secret: str) -> str:
    """Return the otpauth:// URI that can be encoded as a QR code by the dashboard.
    Authenticator apps scan this and store the secret + issuer + label."""
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=_ISSUER)


def verify(secret: str, code: str) -> bool:
    """Verify a 6-digit code against the secret. Allows ±1 step (30s) of clock drift."""
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code, valid_window=1)
    except Exception:
        return False
