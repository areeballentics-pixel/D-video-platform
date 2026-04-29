"""Encryptor auto-updater endpoint.

Tauri 2's built-in updater polls a URL on app launch and offers to install
a new version if `version` is greater than the currently-installed one.
The response shape is fixed by Tauri:

    {
      "version": "0.2.0",
      "notes": "Bug fixes + faster encryption",
      "pub_date": "2026-04-28T10:00:00Z",
      "platforms": {
        "windows-x86_64": {
          "signature": "<minisign-signature>",
          "url": "https://example.com/SVPEncryptor_0.2.0_x64_en-US.msi"
        },
        "darwin-aarch64": { ... },
        "linux-x86_64": { ... }
      }
    }

For v1 we serve a static manifest controlled via `ENCRYPTOR_LATEST_VERSION`
env var (or a JSON file at `/etc/svp/encryptor-latest.json`). When you cut a
new release, edit the env var or file and the updater will pick it up on
the next encryptor launch.

Public endpoint — no auth required (Tauri's updater hits it before login).
"""

import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException


router = APIRouter()


_DEFAULT_MANIFEST = {
    "version": "0.1.0",
    "notes": "Initial v1 release.",
    "pub_date": "2026-04-28T00:00:00Z",
    "platforms": {},
}


def _load_manifest() -> dict:
    """Load the latest-version manifest from (in order):
    1. The `ENCRYPTOR_LATEST_JSON` env var (literal JSON string)
    2. The file path in `ENCRYPTOR_MANIFEST_PATH` env var
    3. `/etc/svp/encryptor-latest.json` (Linux production default)
    4. The hard-coded default above (v0.1.0, no platforms — updater no-op)
    """
    env_json = os.environ.get("ENCRYPTOR_LATEST_JSON")
    if env_json:
        try:
            return json.loads(env_json)
        except json.JSONDecodeError:
            pass

    manifest_path = os.environ.get("ENCRYPTOR_MANIFEST_PATH")
    if manifest_path:
        p = Path(manifest_path)
        if p.exists():
            try:
                return json.loads(p.read_text())
            except (OSError, json.JSONDecodeError):
                pass

    default_path = Path("/etc/svp/encryptor-latest.json")
    if default_path.exists():
        try:
            return json.loads(default_path.read_text())
        except (OSError, json.JSONDecodeError):
            pass

    return _DEFAULT_MANIFEST


@router.get("/latest")
async def encryptor_latest():
    """Tauri updater target. Returns the latest version manifest."""
    return _load_manifest()


@router.get("/latest/{platform_target}")
async def encryptor_latest_per_platform(platform_target: str):
    """Some Tauri updater configurations append the target triple to the URL,
    e.g. `/latest/windows-x86_64`. Return the platform-specific subset so
    those clients work too."""
    manifest = _load_manifest()
    platform_info = manifest.get("platforms", {}).get(platform_target)
    if not platform_info:
        raise HTTPException(
            status_code=404,
            detail=f"No update available for {platform_target}",
        )
    return {
        "version": manifest["version"],
        "notes": manifest.get("notes", ""),
        "pub_date": manifest.get("pub_date", ""),
        **platform_info,
    }
