#!/usr/bin/env python3
"""Bootstrap the first PlatformAdmin (master dashboard user).

This is the account that logs into master.yourplatform.com to create
tenants, suspend them, etc. It sits ABOVE tenants — no tenant_id.

Run ONCE after `alembic upgrade head`, then log into the master
dashboard and use the UI to create tenants/admins normally.

Usage:
    python scripts/bootstrap_platform_admin.py \\
        --email you@yourplatform.com \\
        --password 'ALongStrongPassword!'

On the VPS via docker-compose:
    docker compose -f docker-compose.prod.yml exec server \\
        python scripts/bootstrap_platform_admin.py \\
            --email you@yourplatform.com \\
            --password 'ALongStrongPassword!'

Subsequent platform admins can be added directly via SQL or by extending
the master API with a /master/admins endpoint (intentionally not in v1 —
you almost never need more than 1-2 platform admins).
"""

import argparse
import asyncio
import sys

from sqlalchemy import select

from app.core.security import hash_password
from app.database import async_session
from app.models.platform_admin import PlatformAdmin


async def bootstrap(email: str, password: str) -> None:
    async with async_session() as session:
        existing = await session.execute(
            select(PlatformAdmin).where(PlatformAdmin.email == email)
        )
        if existing.scalar_one_or_none() is not None:
            print(f"Platform admin with email '{email}' already exists. Aborting.")
            sys.exit(1)

        admin = PlatformAdmin(
            email=email,
            password_hash=hash_password(password),
            is_active=True,
        )
        session.add(admin)
        await session.commit()

        print()
        print("=" * 64)
        print("Platform admin created")
        print(f"  ID:       {admin.id}")
        print(f"  Email:    {email}")
        print(f"  Password: (as provided)")
        print()
        print("Log in at the master dashboard (master.yourplatform.com)")
        print("with these credentials to start creating tenants.")
        print("=" * 64)


def main() -> None:
    p = argparse.ArgumentParser(description="Bootstrap first platform admin")
    p.add_argument("--email", required=True, help="Platform admin email")
    p.add_argument("--password", required=True, help="Platform admin password (>=8 chars)")
    args = p.parse_args()

    if len(args.password) < 8:
        print("Password must be at least 8 characters")
        sys.exit(1)

    asyncio.run(bootstrap(email=args.email, password=args.password))


if __name__ == "__main__":
    main()
