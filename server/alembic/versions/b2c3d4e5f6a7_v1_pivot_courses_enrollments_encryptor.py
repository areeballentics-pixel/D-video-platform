"""v1 pivot: courses, enrollments, encryptor devices, watch events, branding;
drop licenses; restructure videos for institute-side encryption.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-27

This is a hard-cut migration matching the v1 architecture pivot:
  - Encryption moves off the server entirely; institutes encrypt locally and
    self-host .svf files. Server stores only metadata (download URLs, content
    hashes per quality, file sizes, status).
  - Wildcard `License` model is replaced by `Course` + `CourseVideo` +
    `Enrollment`. The legacy table is dropped (no production data preserved).
  - Tenants gain branding fields, per-tenant feature flags, and an
    encryptor-seat license cap (max_encryptor_devices).
  - New tables: encryptor_devices, audit_logs, watch_events, watch_aggregates.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Drop legacy licenses table (replaced by enrollments) ──
    op.drop_index(op.f("ix_licenses_user_id"), table_name="licenses")
    op.drop_table("licenses")

    # ── 2. tenants: branding + encryptor-seat cap + feature flags ──
    op.add_column(
        "tenants",
        sa.Column(
            "max_encryptor_devices",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )
    op.add_column("tenants", sa.Column("logo_url", sa.String(length=1000), nullable=True))
    op.add_column("tenants", sa.Column("primary_color", sa.String(length=20), nullable=True))
    op.add_column("tenants", sa.Column("support_email", sa.String(length=255), nullable=True))
    op.add_column(
        "tenants",
        sa.Column("custom_welcome_message", sa.String(length=2000), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column(
            "feature_flags",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    # ── 3. videos: drop legacy single-quality encryption fields ──
    # The legacy `encryption_salt` and `encryption_nonce` columns held a single
    # salt/nonce pair shared across all qualities. The new model supports
    # different salt/nonce per quality via the JSONB `encryption_params` map.
    op.drop_column("videos", "encryption_salt")
    op.drop_column("videos", "encryption_nonce")

    # ── 4. videos: add v1 metadata columns ──
    op.add_column(
        "videos",
        sa.Column(
            "encryption_params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "download_urls",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "content_hashes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "file_sizes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="pending_urls",
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "is_free_preview",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "is_stream_only",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "videos",
        sa.Column(
            "chapters",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "videos",
        sa.Column("transcript_url", sa.String(length=1000), nullable=True),
    )
    op.add_column(
        "videos",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ── 5. courses + course_videos M2M ──
    op.create_table(
        "courses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(length=5000), nullable=False, server_default=""),
        sa.Column("thumbnail_url", sa.String(length=1000), nullable=True),
        sa.Column("intro_video_id", sa.Uuid(), nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "resource_attachments",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["intro_video_id"], ["videos.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_courses_tenant_id"), "courses", ["tenant_id"], unique=False)

    op.create_table(
        "course_videos",
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["video_id"], ["videos.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("course_id", "video_id"),
    )

    # ── 6. enrollments ──
    op.create_table(
        "enrollments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("enrolled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enrolled_by_user_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["enrolled_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "course_id", name="uq_enrollment_user_course"),
    )
    op.create_index(op.f("ix_enrollments_user_id"), "enrollments", ["user_id"], unique=False)
    op.create_index(op.f("ix_enrollments_course_id"), "enrollments", ["course_id"], unique=False)

    # ── 7. encryptor_devices ──
    op.create_table(
        "encryptor_devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("os_version", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("registered_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("registered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_master_key_fetch_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["registered_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "fingerprint", name="uq_encryptor_tenant_fingerprint"
        ),
    )
    op.create_index(
        op.f("ix_encryptor_devices_tenant_id"),
        "encryptor_devices",
        ["tenant_id"],
        unique=False,
    )

    # ── 8. audit_logs ──
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("actor_type", sa.String(length=20), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=True),
        sa.Column("actor_email", sa.String(length=255), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=True),
        sa.Column("target_id", sa.String(length=64), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("ip_address", sa.String(length=45), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_audit_logs_tenant_id"), "audit_logs", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_audit_logs_action"), "audit_logs", ["action"], unique=False)
    op.create_index(op.f("ix_audit_logs_occurred_at"), "audit_logs", ["occurred_at"], unique=False)

    # ── 9. watch_events (append-only) ──
    op.create_table(
        "watch_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=True),
        sa.Column("device_id", sa.Uuid(), nullable=True),
        sa.Column("position_ms", sa.BigInteger(), nullable=False),
        sa.Column("watched_delta_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["video_id"], ["videos.id"]),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"]),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_watch_events_tenant_id"), "watch_events", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_watch_events_user_id"), "watch_events", ["user_id"], unique=False)
    op.create_index(op.f("ix_watch_events_video_id"), "watch_events", ["video_id"], unique=False)
    op.create_index(op.f("ix_watch_events_occurred_at"), "watch_events", ["occurred_at"], unique=False)

    # ── 10a. platform_admins: TOTP fields for master 2FA ──
    op.add_column(
        "platform_admins",
        sa.Column("totp_secret", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "platform_admins",
        sa.Column(
            "totp_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    # ── 10b. users: login tracking + lockout fields ──
    op.add_column(
        "users",
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "failed_login_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "users",
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("admin_notes", sa.String(length=5000), nullable=True),
    )

    # ── 10c. seat_upgrade_requests: tenant admin asks master for more seats ──
    op.create_table(
        "seat_upgrade_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("requested_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("requested_seats", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("notes", sa.String(length=2000), nullable=False, server_default=""),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("handled_by_admin_id", sa.Uuid(), nullable=True),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("handled_notes", sa.String(length=2000), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["handled_by_admin_id"], ["platform_admins.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_seat_upgrade_requests_tenant_id"),
        "seat_upgrade_requests",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_seat_upgrade_requests_status"),
        "seat_upgrade_requests",
        ["status"],
        unique=False,
    )

    # ── 11. watch_aggregates (one row per user/video/day) ──
    op.create_table(
        "watch_aggregates",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("total_watched_ms", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("max_position_ms", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("last_position_ms", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sessions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["video_id"], ["videos.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "video_id", "day"),
    )


def downgrade() -> None:
    # Symmetric downgrade — restores the v0 schema. Only useful in dev; v1
    # data (courses, enrollments, watch events, etc.) is destroyed.
    op.drop_table("watch_aggregates")
    op.drop_index(op.f("ix_watch_events_occurred_at"), table_name="watch_events")
    op.drop_index(op.f("ix_watch_events_video_id"), table_name="watch_events")
    op.drop_index(op.f("ix_watch_events_user_id"), table_name="watch_events")
    op.drop_index(op.f("ix_watch_events_tenant_id"), table_name="watch_events")
    op.drop_table("watch_events")

    op.drop_index(op.f("ix_audit_logs_occurred_at"), table_name="audit_logs")
    op.drop_index(op.f("ix_audit_logs_action"), table_name="audit_logs")
    op.drop_index(op.f("ix_audit_logs_tenant_id"), table_name="audit_logs")
    op.drop_table("audit_logs")

    op.drop_index(op.f("ix_encryptor_devices_tenant_id"), table_name="encryptor_devices")
    op.drop_table("encryptor_devices")

    op.drop_index(
        op.f("ix_seat_upgrade_requests_status"), table_name="seat_upgrade_requests"
    )
    op.drop_index(
        op.f("ix_seat_upgrade_requests_tenant_id"), table_name="seat_upgrade_requests"
    )
    op.drop_table("seat_upgrade_requests")

    op.drop_column("users", "admin_notes")
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_attempts")
    op.drop_column("users", "last_login_at")

    op.drop_column("platform_admins", "totp_enabled")
    op.drop_column("platform_admins", "totp_secret")

    op.drop_index(op.f("ix_enrollments_course_id"), table_name="enrollments")
    op.drop_index(op.f("ix_enrollments_user_id"), table_name="enrollments")
    op.drop_table("enrollments")

    op.drop_table("course_videos")
    op.drop_index(op.f("ix_courses_tenant_id"), table_name="courses")
    op.drop_table("courses")

    op.drop_column("videos", "updated_at")
    op.drop_column("videos", "transcript_url")
    op.drop_column("videos", "chapters")
    op.drop_column("videos", "is_stream_only")
    op.drop_column("videos", "is_free_preview")
    op.drop_column("videos", "status")
    op.drop_column("videos", "file_sizes")
    op.drop_column("videos", "content_hashes")
    op.drop_column("videos", "download_urls")
    op.drop_column("videos", "encryption_params")
    # Restored as nullable: the v1 migration drops these and replaces them
    # with `encryption_params` JSONB. Production never carries data through
    # this downgrade — it exists only for dev round-trip testing — so a
    # nullable restore is sufficient.
    op.add_column(
        "videos",
        sa.Column("encryption_nonce", sa.LargeBinary(length=16), nullable=True),
    )
    op.add_column(
        "videos",
        sa.Column("encryption_salt", sa.LargeBinary(length=32), nullable=True),
    )

    op.drop_column("tenants", "feature_flags")
    op.drop_column("tenants", "custom_welcome_message")
    op.drop_column("tenants", "support_email")
    op.drop_column("tenants", "primary_color")
    op.drop_column("tenants", "logo_url")
    op.drop_column("tenants", "max_encryptor_devices")

    op.create_table(
        "licenses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.UUID(), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_licenses_user_id"), "licenses", ["user_id"], unique=False)
