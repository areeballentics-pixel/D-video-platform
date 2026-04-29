"""Widen fingerprint columns to accommodate prefixed formats.

The encryptor app sends `encryptor-app-{64-hex SHA256}` = 78 chars to
`/api/auth/login`, exceeding the legacy `varchar(64)` cap. The dashboard
clients use `dashboard-{uuid}` = 46 chars which fits, but any future client
that prefixes the fingerprint to differentiate device classes would hit the
same wall. Widening to varchar(128) accommodates all reasonable prefixed
formats.

Postgres `ALTER COLUMN ... TYPE` for varchar widening is metadata-only —
no table rewrite, no downtime.

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-28
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "devices",
        "fingerprint",
        existing_type=sa.String(length=64),
        type_=sa.String(length=128),
        existing_nullable=False,
    )
    op.alter_column(
        "encryptor_devices",
        "fingerprint",
        existing_type=sa.String(length=64),
        type_=sa.String(length=128),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Narrowing is only safe if all existing rows fit in 64 chars.
    op.alter_column(
        "encryptor_devices",
        "fingerprint",
        existing_type=sa.String(length=128),
        type_=sa.String(length=64),
        existing_nullable=False,
    )
    op.alter_column(
        "devices",
        "fingerprint",
        existing_type=sa.String(length=128),
        type_=sa.String(length=64),
        existing_nullable=False,
    )
