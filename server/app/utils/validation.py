"""Lightweight input validators shared across API layers.

We deliberately avoid pydantic's `EmailStr` here: its underlying
email-validator rejects internal-only TLDs like `.local` / `.internal`
(RFC 6761), which some institutes use for admin accounts. This permissive
check still rejects the structurally-invalid inputs QA found (e.g. `abc@g`,
`123@q`, or anything without an `@`), by requiring a dotted domain.
"""

import re

# One `@`, non-empty local part, and a domain with at least one dot and
# non-empty labels around it. No whitespace anywhere.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(email: str) -> bool:
    """Return True if `email` is structurally a valid address.

    Rejects: empty, overlong (>254), missing `@`, missing dotted domain
    (e.g. `abc@g`), and any value containing whitespace.
    """
    email = (email or "").strip()
    if not email or len(email) > 254:
        return False
    return bool(_EMAIL_RE.match(email))
