from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PullRequest(SQLModel, table=True):
    __tablename__ = "pull_requests"

    pr_id: int = Field(primary_key=True)
    title: str
    author_name: str
    repository_name: str
    pr_url: str
    pr_status: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    iterations: list["PrReviewIteration"] = Relationship(back_populates="pull_request")


class PrReviewIteration(SQLModel, table=True):
    __tablename__ = "pr_review_iterations"
    __table_args__ = (
        UniqueConstraint("pr_id", "last_commit_id"),
        Index("idx_iterations_pr_id", "pr_id"),
        Index("idx_iterations_status", "status"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    pr_id: int = Field(foreign_key="pull_requests.pr_id")
    last_commit_id: str
    status: str
    ai_summary: Optional[str] = None
    raw_ai_response: Optional[str] = None
    tokens_used: int = 0
    estimated_cost_usd: float = 0.0
    error_message: Optional[str] = None
    error_type: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    reviewed_at: Optional[datetime] = None

    pull_request: Optional[PullRequest] = Relationship(back_populates="iterations")
