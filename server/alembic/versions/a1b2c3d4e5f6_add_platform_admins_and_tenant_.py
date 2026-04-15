"""add platform_admins table and tenant suspension timestamp

Revision ID: a1b2c3d4e5f6
Revises: f2f082bd0294
Create Date: 2026-04-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "f2f082bd0294"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Platform admins — operators of the SaaS platform itself.
    op.create_table(
        "platform_admins",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index(
        op.f("ix_platform_admins_email"),
        "platform_admins",
        ["email"],
        unique=True,
    )

    # 2. tenants.suspended_at — audit trail timestamp for the most recent
    #    suspension (nullable; the authoritative check is still tenants.is_active).
    op.add_column(
        "tenants",
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tenants", "suspended_at")
    op.drop_index(op.f("ix_platform_admins_email"), table_name="platform_admins")
    op.drop_table("platform_admins")
