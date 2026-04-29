"""Add per-tenant quotas for students / videos / courses.

The existing `max_encryptor_devices` was the only quota; with the in-app
admin migration, the master dashboard is now the single place where the
platform owner can issue + cap a tenant's resources. Defaults chosen to
roughly match a "small institute" plan; master admin bumps for paying
tenants via the new tenants/{id}/limits endpoint.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-04-29
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("max_students", sa.Integer(), nullable=False, server_default="50"),
    )
    op.add_column(
        "tenants",
        sa.Column("max_videos", sa.Integer(), nullable=False, server_default="100"),
    )
    op.add_column(
        "tenants",
        sa.Column("max_courses", sa.Integer(), nullable=False, server_default="20"),
    )


def downgrade() -> None:
    op.drop_column("tenants", "max_courses")
    op.drop_column("tenants", "max_videos")
    op.drop_column("tenants", "max_students")
