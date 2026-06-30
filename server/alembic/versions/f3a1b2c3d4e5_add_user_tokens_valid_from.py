"""add users.tokens_valid_from for session invalidation on password reset

Revision ID: f3a1b2c3d4e5
Revises: e5f6a7b8c9d0
Create Date: 2026-06-28

QA SP-001: bumping this timestamp on password reset (or forced logout) lets
get_current_user reject any access token issued before it (tokens carry `iat`),
so a password change immediately ends every existing session.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a1b2c3d4e5"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("tokens_valid_from", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "tokens_valid_from")
