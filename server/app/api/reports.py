"""Piracy report endpoints — silent reporting from the player."""

from fastapi import APIRouter

router = APIRouter()


@router.post("/piracy")
async def report_piracy_attempt():
    """Player reports suspicious activity (screen recorder, debugger, VM, etc.)."""
    # TODO (Sprint 6): Implement
    return {"message": "Report received"}
