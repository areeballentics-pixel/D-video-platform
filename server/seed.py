"""Seed the database with test data for development."""

import asyncio
import os
import uuid

from app.config import settings
from app.core.security import encrypt_master_key, hash_password
from app.database import async_session, engine, Base
from app.models import Tenant, User, License, Video


async def seed():
    async with async_session() as session:
        # Check if already seeded
        from sqlalchemy import select
        result = await session.execute(select(Tenant).limit(1))
        if result.scalar_one_or_none():
            print("Database already seeded. Skipping.")
            return

        # ─── Create test tenant ───
        # This is the same master key we use in the CLI tool and player tests
        raw_master_key = bytes.fromhex(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        encrypted_master_key = encrypt_master_key(raw_master_key)

        tenant = Tenant(
            id=uuid.UUID("22222222-2222-2222-2222-222222222222"),
            name="Test SAP Training Institute",
            slug="test-sap",
            master_key=encrypted_master_key,
        )
        session.add(tenant)

        # ─── Create test student user ───
        student = User(
            id=uuid.UUID("33333333-3333-3333-3333-333333333333"),
            tenant_id=tenant.id,
            email="student@test-sap.com",
            password_hash=hash_password("student123"),
            license_key="TEST-XXXX-YYYY-ZZZZ",
            role="student",
            max_devices=2,
            max_device_changes_per_30d=2,
        )
        session.add(student)

        # ─── Create test admin user ───
        admin = User(
            id=uuid.UUID("44444444-4444-4444-4444-444444444444"),
            tenant_id=tenant.id,
            email="admin@test-sap.com",
            password_hash=hash_password("admin123"),
            role="admin",
            max_devices=2,
            max_device_changes_per_30d=5,
        )
        session.add(admin)

        # ─── Create wildcard license (access to all videos) ───
        license = License(
            user_id=student.id,
            video_id=None,  # NULL = access to ALL videos
        )
        session.add(license)

        admin_license = License(
            user_id=admin.id,
            video_id=None,
        )
        session.add(admin_license)

        # ─── Register the test video we encrypted in Sprint 2 ───
        # Read the actual salt/nonce from the .svf file header so key derivation matches
        svf_path = os.path.join(os.path.dirname(__file__), "..", "test-videos", "encrypted",
                                "11111111-1111-1111-1111-111111111111_720p.svf")
        import struct
        if os.path.exists(svf_path):
            with open(svf_path, "rb") as svf:
                svf.read(4 + 2 + 2 + 16 + 16)  # magic + version + flags + video_id + tenant_id
                enc_salt = svf.read(32)
                enc_nonce = svf.read(16)
        else:
            enc_salt = os.urandom(32)
            enc_nonce = os.urandom(16)

        video = Video(
            id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
            tenant_id=tenant.id,
            title="SAP HANA Module 3: Data Modeling",
            description="Introduction to SAP HANA data modeling concepts",
            qualities=["480p", "720p", "1080p"],
            encryption_salt=enc_salt,
            encryption_nonce=enc_nonce,
            duration_ms=12003,
        )
        session.add(video)

        await session.commit()

        print("Database seeded successfully!")
        print(f"  Tenant: {tenant.name} ({tenant.id})")
        print(f"  Student: {student.email} / student123")
        print(f"  License key: {student.license_key}")
        print(f"  Admin: {admin.email} / admin123")
        print(f"  Video: {video.title} ({video.id})")


if __name__ == "__main__":
    asyncio.run(seed())
