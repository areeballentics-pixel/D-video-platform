"""Shared test fixtures."""

import pytest


@pytest.fixture
def test_tenant_id():
    return "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def test_user_email():
    return "student@test-institute.com"
