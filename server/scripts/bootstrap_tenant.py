#!/usr/bin/env python3
"""Bootstrap the first tenant + admin user.

Run ONCE after `alembic upgrade head` to seed the database with:
  1. A tenant (with a randomly generated 32-byte master key, Fernet-encrypted)
  2. An admin user for that tenant

The admin can then log into the dashboard and start uploading videos,
creating students, etc.

Usage:
    python scripts/bootstrap_tenant.py \\
        --tenant-name "Acme Academy" \\
        --tenant-slug acme \\
        --admin-email admin@acme.com \\
        --admin-password 'StrongP@ssw0rd!'

On Railway, run via:
    railway run python scripts/bootstrap_tenant.py --tenant-name ... (etc.)
"""

import argparse
import asyncio
import secrets
import sys

from sqlalchemy import select

from app.core.security import encrypt_master_key, hash_password
from app.database import async_session
from app.models.tenant import Tenant
from app.models.user import User


async def bootstrap(
    tenant_name: str,
    tenant_slug: str,
    admin_email: str,
    admin_password: str,
) -> None:
    async with async_session() as session:
        # Abort if the tenant slug already exists
        existing = await session.execute(
            select(Tenant).where(Tenant.slug == tenant_slug)
        )
        if existing.scalar_one_or_none() is not None:
            print(f"Tenant with slug '{tenant_slug}' already exists. Aborting.")
            sys.exit(1)

        # Generate a fresh 32-byte tenant master key. All per-video keys are
        # derived from this via HKDF; the raw key is immediately Fernet-encrypted
        # before being stored in the database.
        master_key = secrets.token_bytes(32)
        encrypted_master_key = encrypt_master_key(master_key)

        tenant = Tenant(
            name=tenant_name,
            slug=tenant_slug,
            master_key=encrypted_master_key,
        )
        session.add(tenant)
        await session.flush()  # assigns tenant.id

        admin = User(
            tenant_id=tenant.id,
            email=admin_email,
            password_hash=hash_password(admin_password),
            role="admin",
            is_active=True,
        )
        session.add(admin)
        await session.commit()

        print()
        print("=" * 64)
        print("Tenant created")
        print(f"  ID:    {tenant.id}")
        print(f"  Name:  {tenant_name}")
        print(f"  Slug:  {tenant_slug}")
        print()
        print("Admin user created")
        print(f"  Email:    {admin_email}")
        print(f"  Password: (as provided)")
        print(f"  Role:     admin")
        print()
        print("Tenant master key (hex) — BACK THIS UP OFFLINE:")
        print(f"  {master_key.hex()}")
        print()
        print("This key is already Fernet-encrypted in the database using")
        print("SERVER_ENCRYPTION_KEY. A paper/password-manager backup of the")
        print("hex string is your last-resort recovery option if that env var")
        print("is ever lost.")
        print("=" * 64)


def main() -> None:
    p = argparse.ArgumentParser(description="Bootstrap first tenant + admin user.")
    p.add_argument(
        "--tenant-name",
        required=True,
        help="Display name for the tenant (e.g. 'Acme Academy')",
    )
    p.add_argument(
        "--tenant-slug",
        required=True,
        help="URL-safe short name for the tenant (e.g. 'acme')",
    )
    p.add_argument(
        "--admin-email",
        required=True,
        help="Email address for the initial admin user",
    )
    p.add_argument(
        "--admin-password",
        required=True,
        help="Password for the initial admin user",
    )
    args = p.parse_args()

    asyncio.run(bootstrap(
        tenant_name=args.tenant_name,
        tenant_slug=args.tenant_slug,
        admin_email=args.admin_email,
        admin_password=args.admin_password,
    ))


if __name__ == "__main__":
    main()
