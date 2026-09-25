from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import distinct, func
from sqlmodel import select

from ..config import get_settings
from ..database import session_factory
from ..models import LlmModel, PrReviewIteration


router = APIRouter(prefix="/metrics", tags=["metrics"])


class AutoReviewBody(BaseModel):
    enabled: bool


@router.get("")
async def get_metrics():
    async with session_factory() as session:
        total_reviewed = (
            await session.exec(
                select(func.count(distinct(PrReviewIteration.pr_id))).where(
                    PrReviewIteration.status == "REVIEWED"
                )
            )
        ).one()
        active_model = (
            await session.exec(select(LlmModel).where(LlmModel.is_active == True))  # noqa: E712
        ).one_or_none()
    return {
        "total_prs_reviewed": int(total_reviewed),
        "auto_pr_review_enabled": get_settings().auto_pr_review_enabled,
        "active_model_name": active_model.name if active_model else None,
        "active_model_id": active_model.model if active_model else None,
    }


@router.post("/auto-review")
async def set_auto_review(body: AutoReviewBody, request: Request):
    enabled = request.app.state.review_scheduler.set_auto_review_enabled(body.enabled)
    return {"auto_pr_review_enabled": enabled}
