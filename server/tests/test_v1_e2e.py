"""End-to-end smoke test for the v1 server flow.

Walks through the full happy path: bootstrap a tenant, log in, register an
encryptor, fetch the master key, create a course, create a student, enroll
them, register an encrypted-video, set a download URL, fetch the key as
the student.

Run against a live server (postgres + redis must be up):

    docker compose up -d postgres redis
    .venv/Scripts/alembic upgrade head
    .venv/Scripts/uvicorn app.main:app --port 8000 &
    .venv/Scripts/pytest tests/test_v1_e2e.py -v

This is intentionally NOT a unit test — it exercises the real DB + Redis +
the full FastAPI stack to catch wiring issues that mocked tests miss.
"""

import os
import secrets
import uuid

import httpx
import pytest


BASE_URL = os.environ.get("SVP_TEST_SERVER", "http://127.0.0.1:8000")


def _unique(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


@pytest.fixture(scope="module")
def http():
    """Module-scoped HTTP client so cookies + connection pool persist."""
    with httpx.Client(base_url=BASE_URL, timeout=10.0) as client:
        yield client


def test_health_is_up(http: httpx.Client):
    """Sanity: /health returns 200 + version. If this fails, nothing else will."""
    r = http.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_full_v1_happy_path(http: httpx.Client):
    """Bootstrap → login → encryptor → course → enrollment → /key.

    Each step depends on the previous. If any break, the failure points
    directly at the broken link in the chain.
    """
    slug = _unique("e2e")
    admin_email = f"admin-{slug}@example.com"
    admin_password = "TestPass123!"
    student_email = f"student-{slug}@example.com"
    student_password = "StudentPass123!"

    # ── 1. Bootstrap tenant (uses scripts/bootstrap_tenant.py via DB session) ──
    # We do this via the master API instead of the script so the test stays
    # self-contained: requires a platform admin credentials env var to exist.
    # If the master admin isn't bootstrapped, skip the master-side and assume
    # the scripts/bootstrap_tenant.py was run manually as a precondition.
    master_email = os.environ.get("SVP_TEST_MASTER_EMAIL")
    master_password = os.environ.get("SVP_TEST_MASTER_PASSWORD")
    if not (master_email and master_password):
        pytest.skip(
            "SVP_TEST_MASTER_EMAIL + SVP_TEST_MASTER_PASSWORD must be set "
            "to drive tenant creation through the master API. Otherwise "
            "run scripts/bootstrap_tenant.py manually first."
        )

    r = http.post(
        "/api/master/login",
        json={"email": master_email, "password": master_password, "totp_code": None},
    )
    assert r.status_code == 200, f"master login failed: {r.text}"
    master_token = r.json()["access_token"]

    r = http.post(
        "/api/master/tenants",
        headers={"Authorization": f"Bearer {master_token}"},
        json={
            "name": f"E2E {slug}",
            "slug": slug,
            "admin_email": admin_email,
            "admin_password": admin_password,
        },
    )
    assert r.status_code == 201, f"create tenant failed: {r.text}"
    bootstrap = r.json()
    expected_master_key_hex = bootstrap["master_key_hex"]
    tenant_id = bootstrap["tenant_id"]
    assert len(expected_master_key_hex) == 64

    # ── 2. Log in as tenant admin ──
    r = http.post(
        "/api/auth/login",
        json={
            "email": admin_email,
            "password": admin_password,
            "device_fingerprint": "e2e-admin-fp",
            "hostname": "e2e-host",
            "os_version": "e2e-os",
        },
    )
    assert r.status_code == 200, f"admin login failed: {r.text}"
    admin_token = r.json()["access_token"]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    assert r.json()["tenant_id"] == tenant_id

    # ── 3. Register an encryptor — must return the same master_key bytes ──
    r = http.post(
        "/api/admin/encryptors/register",
        headers=admin_headers,
        json={
            "password": admin_password,
            "fingerprint": "e2e-encryptor-fp",
            "hostname": "e2e-encryptor-host",
            "os_version": "e2e-os",
        },
    )
    assert r.status_code == 200, f"register encryptor failed: {r.text}"
    enc = r.json()
    assert enc["master_key_hex"] == expected_master_key_hex, (
        "Encryptor master_key must match the bootstrap output byte-for-byte."
    )
    assert enc["seats_used"] == 1
    assert enc["is_first_registration"] is True

    # ── 4. Second register with a different fingerprint hits the seat cap ──
    r = http.post(
        "/api/admin/encryptors/register",
        headers=admin_headers,
        json={
            "password": admin_password,
            "fingerprint": "e2e-encryptor-fp-OTHER",
            "hostname": "other-host",
            "os_version": "e2e-os",
        },
    )
    assert r.status_code == 429, "should hit default seat cap of 1"
    assert "cap reached" in r.json()["detail"].lower()

    # ── 5. Create a course ──
    r = http.post(
        "/api/admin/courses",
        headers=admin_headers,
        json={"name": f"E2E course {slug}", "tags": ["e2e"]},
    )
    assert r.status_code == 201, f"create course failed: {r.text}"
    course = r.json()
    course_id = course["id"]
    assert course["is_published"] is False

    # ── 6. Publish it ──
    r = http.post(
        f"/api/admin/courses/{course_id}/publish",
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert r.json()["is_published"] is True

    # ── 7. Create a student ──
    r = http.post(
        "/api/admin/students",
        headers=admin_headers,
        data={"email": student_email, "password": student_password},
    )
    assert r.status_code == 200, f"create student failed: {r.text}"
    student_id = r.json()["user_id"]

    # ── 8. Enroll the student in the course ──
    r = http.post(
        "/api/admin/enrollments",
        headers=admin_headers,
        json={"user_id": student_id, "course_id": course_id},
    )
    assert r.status_code == 201, f"enroll failed: {r.text}"

    # ── 9. Register an encrypted video against this tenant ──
    video_id = str(uuid.uuid4())
    salt_hex = secrets.token_hex(32)   # 32 bytes hex = 64 chars
    nonce_hex = secrets.token_hex(16)  # 16 bytes hex = 32 chars
    content_hash_hex = secrets.token_hex(32)
    r = http.post(
        "/api/admin/videos/register-encrypted",
        headers=admin_headers,
        json={
            "video_id": video_id,
            "title": "E2E test video",
            "duration_ms": 60_000,
            "qualities": ["720p"],
            "encryption_params": {"720p": {"salt": salt_hex, "nonce": nonce_hex}},
            "content_hashes": {"720p": content_hash_hex},
            "file_sizes": {"720p": 10_000_000},
        },
    )
    assert r.status_code == 200, f"register-encrypted failed: {r.text}"
    assert r.json()["status"] == "pending_urls"
    assert r.json()["needs_download_urls_for"] == ["720p"]

    # ── 10. Add the video to the course ──
    r = http.post(
        f"/api/admin/courses/{course_id}/videos",
        headers=admin_headers,
        json={"video_id": video_id},
    )
    assert r.status_code == 201

    # ── 11. Paste the Drive URL — flips status to live ──
    r = http.put(
        f"/api/admin/videos/{video_id}/download-urls",
        headers=admin_headers,
        json={"download_urls": {"720p": "https://drive.google.com/test"}},
    )
    assert r.status_code == 200, f"put-download-urls failed: {r.text}"
    assert r.json()["status"] == "live"

    # ── 12. Audit log captured the actions ──
    r = http.get("/api/admin/audit", headers=admin_headers)
    assert r.status_code == 200
    actions = {entry["action"] for entry in r.json()}
    assert "encryptor.register" in actions
    assert "course.create" in actions
    assert "course.publish" in actions
    assert "video.register_encrypted" in actions
    assert "video.set_download_urls" in actions
    assert "enrollment.create" in actions

    # ── 13. Log in as the student, fetch the video key ──
    r = http.post(
        "/api/auth/login",
        json={
            "email": student_email,
            "password": student_password,
            "device_fingerprint": "e2e-student-fp",
            "hostname": "e2e-student-host",
            "os_version": "e2e-os",
        },
    )
    assert r.status_code == 200, f"student login failed: {r.text}"
    student_token = r.json()["access_token"]
    student_headers = {"Authorization": f"Bearer {student_token}"}

    r = http.post(
        "/api/videos/key",
        headers=student_headers,
        json={
            "video_id": video_id,
            "quality": "720p",
            "device_fingerprint": "e2e-student-fp",
        },
    )
    assert r.status_code == 200, f"/api/videos/key failed: {r.text}"
    payload = r.json()
    assert len(payload["key"]) == 64  # 32 bytes hex
    assert payload["download_url"] == "https://drive.google.com/test"
    assert payload["content_hash"] == content_hash_hex

    # ── 14. Watch-event heartbeat ──
    r = http.post(
        "/api/watch-events/heartbeat",
        headers=student_headers,
        json={
            "video_id": video_id,
            "position_ms": 5000,
            "watched_delta_ms": 5000,
            "course_id": course_id,
        },
    )
    assert r.status_code == 200, f"heartbeat failed: {r.text}"

    # ── 15. Last-position recovers what we just sent ──
    r = http.get(
        f"/api/watch-events/last-position?video_id={video_id}",
        headers=student_headers,
    )
    assert r.status_code == 200
    assert r.json()["last_position_ms"] == 5000

    # ── 16. Per-video analytics show the watch event ──
    r = http.get(
        f"/api/admin/analytics/video/{video_id}",
        headers=admin_headers,
    )
    assert r.status_code == 200
    analytics = r.json()
    assert analytics["unique_viewers"] >= 1
    assert analytics["total_watch_time_ms"] >= 5000

    # ── 17. Master can see updated platform stats ──
    r = http.get(
        "/api/master/stats",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    assert r.status_code == 200
    stats = r.json()
    assert stats["total_tenants"] >= 1
    assert stats["total_videos"] >= 1
    assert stats["total_active_enrollments"] >= 1
    assert stats["total_encryptor_devices"] >= 1


def test_seat_cap_upgrade_flow(http: httpx.Client):
    """Tenant requests upgrade → master fulfills → cap raised → new device fits."""
    master_email = os.environ.get("SVP_TEST_MASTER_EMAIL")
    master_password = os.environ.get("SVP_TEST_MASTER_PASSWORD")
    if not (master_email and master_password):
        pytest.skip("master credentials env not set")

    slug = _unique("seats")
    admin_email = f"admin-{slug}@example.com"
    admin_password = "TestPass123!"

    r = http.post(
        "/api/master/login",
        json={"email": master_email, "password": master_password, "totp_code": None},
    )
    master_token = r.json()["access_token"]
    master_headers = {"Authorization": f"Bearer {master_token}"}

    r = http.post(
        "/api/master/tenants",
        headers=master_headers,
        json={
            "name": f"Seats {slug}",
            "slug": slug,
            "admin_email": admin_email,
            "admin_password": admin_password,
        },
    )
    tenant_id = r.json()["tenant_id"]

    # Tenant admin asks for more seats.
    r = http.post(
        "/api/auth/login",
        json={
            "email": admin_email,
            "password": admin_password,
            "device_fingerprint": "seats-admin",
            "hostname": "h", "os_version": "o",
        },
    )
    admin_token = r.json()["access_token"]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    r = http.post(
        "/api/admin/encryptors/seat-upgrade-request",
        headers=admin_headers,
        json={"requested_seats": 3, "notes": "hiring 2 editors"},
    )
    assert r.status_code == 200
    request_id = r.json()["request_id"]

    # Master sees it pending.
    r = http.get(
        "/api/master/upgrade-requests?status_filter=pending",
        headers=master_headers,
    )
    pending_ids = [x["id"] for x in r.json()]
    assert request_id in pending_ids

    # Master fulfills with new cap = 3.
    r = http.post(
        f"/api/master/upgrade-requests/{request_id}/fulfill",
        headers=master_headers,
        json={"new_max_encryptor_devices": 3, "handled_notes": "approved"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "fulfilled"
    assert r.json()["current_seats"] == 3

    # Verify the tenant row reflects the new cap.
    r = http.get("/api/master/tenants", headers=master_headers)
    target = next(t for t in r.json()["tenants"] if t["id"] == tenant_id)
    assert target["encryptor_seats_total"] == 3
