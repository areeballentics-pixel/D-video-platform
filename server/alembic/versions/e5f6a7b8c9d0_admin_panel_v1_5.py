"""Admin-panel v1.5: tenant tier/pricing/suspension reason + master 2FA recovery codes.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-04-29
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Tenant tier + price for at-a-glance MRR scanning + plan management.
    # Free-form so master can use any naming ("Starter", "Pro", "Custom-Acme").
    op.add_column(
        "tenants",
        sa.Column("tier", sa.String(length=64), nullable=False, server_default="Free"),
    )
    op.add_column(
        "tenants",
        sa.Column(
            "monthly_price_cents",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    # Suspension reason is shown to the tenant admin on next login attempt.
    op.add_column(
        "tenants",
        sa.Column("suspension_reason", sa.String(length=500), nullable=True),
    )

    # 2FA recovery codes: array of bcrypt-style hashes. Plaintext shown to
    # master exactly once at generation; consumed codes are removed from
    # the array. Stored as JSONB for portability + atomic remove via SQL.
    op.add_column(
        "platform_admins",
        sa.Column(
            "totp_recovery_codes_hashed",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("platform_admins", "totp_recovery_codes_hashed")
    op.drop_column("tenants", "suspension_reason")
    op.drop_column("tenants", "monthly_price_cents")
    op.drop_column("tenants", "tier")
