import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, or_
from sqlalchemy.orm import selectinload
from sqlmodel import select

from ..database import session_factory
from ..models import PrReviewIteration, PullRequest


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/prs", tags=["pull requests"])


@router.get("")
async def list_pull_requests(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=40, ge=1, le=100),
    search: str | None = Query(default=None, max_length=200),
):
    filters = []
    if search:
        term = f"%{search}%"
        filters.append(
            or_(
                PullRequest.title.ilike(term),
                PullRequest.author_name.ilike(term),
                PullRequest.repository_name.ilike(term),
            )
        )
    async with session_factory() as session:
        count_statement = select(func.count()).select_from(PullRequest)
        statement = (
            select(PullRequest)
            .options(selectinload(PullRequest.iterations))
            .order_by(PullRequest.azure_created_at.desc(), PullRequest.pr_id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        for condition in filters:
            count_statement = count_statement.where(condition)
            statement = statement.where(condition)
        total = int((await session.exec(count_statement)).one())
        prs = (await session.exec(statement)).all()

    items = []
    for pr in prs:
        latest = max(pr.iterations, key=lambda item: item.created_at, default=None)
        reviewed_at = next(
            (
                item.reviewed_at
                for item in sorted(
                    pr.iterations, key=lambda item: item.created_at, reverse=True
                )
                if item.reviewed_at is not None
            ),
            None,
        )
        items.append(
            {
                "pr_id": pr.pr_id,
                "title": pr.title,
                "author_name": pr.author_name,
                "repository_name": pr.repository_name,
                "pr_url": pr.pr_url,
                "pr_status": pr.pr_status,
                "azure_created_at": pr.azure_created_at,
                "fetched_at": pr.fetched_at,
                "reviewed_at": reviewed_at,
                "latest_iteration": latest,
            }
        )
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/{pr_id}")
async def get_pull_request(pr_id: int):
    async with session_factory() as session:
        statement = (
            select(PullRequest)
            .where(PullRequest.pr_id == pr_id)
            .options(selectinload(PullRequest.iterations))
        )
        pr = (await session.exec(statement)).one_or_none()
    if pr is None:
        raise HTTPException(status_code=404, detail="Pull request not found")
    return {
        "pr_id": pr.pr_id,
        "title": pr.title,
        "author_name": pr.author_name,
        "repository_name": pr.repository_name,
        "pr_url": pr.pr_url,
        "pr_status": pr.pr_status,
        "azure_created_at": pr.azure_created_at,
        "fetched_at": pr.fetched_at,
        "reviewed_at": next(
            (
                item.reviewed_at
                for item in sorted(
                    pr.iterations, key=lambda item: item.created_at, reverse=True
                )
                if item.reviewed_at is not None
            ),
            None,
        ),
        "iterations": sorted(
            pr.iterations, key=lambda item: item.created_at, reverse=True
        ),
    }


async def _run_manual_review(review_scheduler, pr_id: int) -> None:
    try:
        await review_scheduler.manual_review(pr_id)
    except Exception:
        logger.exception("Manual review failed for PR %s", pr_id)


@router.post("/fetch")
async def fetch_pull_requests(request: Request):
    try:
        count = await request.app.state.review_scheduler.fetch_prs()
    except Exception as exc:
        logger.exception("Manual Azure DevOps fetch failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "Azure DevOps fetch failed",
        ) from exc
    return {
        "message": "Fetch from Azure DevOps completed; reviews queued",
        "fetched": count,
    }


@router.post("/{pr_id}/re-review", status_code=status.HTTP_202_ACCEPTED)
async def re_review(pr_id: int, request: Request):
    async with session_factory() as session:
        if await session.get(PullRequest, pr_id) is None:
            raise HTTPException(status_code=404, detail="Pull request not found")
    asyncio.create_task(_run_manual_review(request.app.state.review_scheduler, pr_id))
    return {"message": "Re-review queued", "pr_id": pr_id}
