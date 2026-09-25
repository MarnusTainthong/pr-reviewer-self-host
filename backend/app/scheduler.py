import asyncio
import json
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import func
from sqlmodel import select

from .azure_devops import AzureDevOpsClient, AzureDevOpsError, PullRequestData
from .config import Settings
from .database import session_factory
from .llm import LlmClient, LlmError, LlmResponse
from .models import PrReviewIteration, PullRequest, utc_now


logger = logging.getLogger(__name__)
last_successful_poll: datetime | None = None
review_lock = asyncio.Lock()


class ReviewScheduler:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.azure = AzureDevOpsClient(settings)
        self.llm = LlmClient()
        self.scheduler = AsyncIOScheduler(timezone="UTC")

    def start(self) -> None:
        if not self.settings.auto_pr_review_enabled:
            logger.info("Auto PR review is disabled; poller will not start")
            return
        self._ensure_poll_job(run_immediately=True)

    async def stop(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
        await self.azure.close()
        await self.llm.close()

    def set_auto_review_enabled(self, enabled: bool) -> bool:
        self.settings.auto_pr_review_enabled = enabled
        if enabled:
            self._ensure_poll_job(run_immediately=True)
            logger.info("Auto PR review enabled")
        else:
            self._remove_poll_job()
            logger.info("Auto PR review disabled")
        return enabled

    def _ensure_poll_job(self, *, run_immediately: bool) -> None:
        if not self.scheduler.running:
            self.scheduler.start()
        existing = self.scheduler.get_job("azure-devops-poll")
        if existing is not None:
            if run_immediately:
                existing.modify(next_run_time=utc_now())
            return
        self.scheduler.add_job(
            self.poll,
            "interval",
            minutes=self.settings.poll_interval_minutes,
            id="azure-devops-poll",
            max_instances=1,
            coalesce=True,
            next_run_time=utc_now() if run_immediately else None,
        )

    def _remove_poll_job(self) -> None:
        if self.scheduler.get_job("azure-devops-poll") is not None:
            self.scheduler.remove_job("azure-devops-poll")

    async def poll(self) -> None:
        if not self.settings.auto_pr_review_enabled:
            logger.debug("Auto PR review is disabled; skipping poll")
            return
        await self._run_poll()

    async def _run_poll(self) -> int:
        global last_successful_poll
        async with review_lock:
            try:
                prs = await self.azure.list_assigned_active_prs()
                for pr in prs:
                    try:
                        await self._review_if_needed(pr)
                    except Exception:
                        logger.exception("Review failed for PR %s", pr.pr_id)
                last_successful_poll = datetime.now(timezone.utc)
                return len(prs)
            except Exception:
                logger.exception("Azure DevOps poll failed")
                raise

    async def fetch_prs(self) -> int:
        """Fetch assigned PRs into the DB, then review them in the background."""
        prs = await self.azure.list_assigned_active_prs()
        for pr in prs:
            await self._upsert_pr(pr)
        asyncio.create_task(self._review_fetched(prs))
        return len(prs)

    async def _review_fetched(self, prs: list[PullRequestData]) -> None:
        global last_successful_poll
        async with review_lock:
            for pr in prs:
                try:
                    await self._review_if_needed(pr)
                except Exception:
                    logger.exception("Review failed for PR %s", pr.pr_id)
            last_successful_poll = datetime.now(timezone.utc)

    async def _upsert_pr(self, pr: PullRequestData) -> None:
        now = utc_now()
        async with session_factory() as session:
            stored_pr = await session.get(PullRequest, pr.pr_id)
            if stored_pr is None:
                session.add(
                    PullRequest(
                        pr_id=pr.pr_id,
                        title=pr.title,
                        author_name=pr.author_name,
                        repository_name=pr.repository_name,
                        pr_url=pr.url,
                        pr_status=pr.status,
                        azure_created_at=pr.azure_created_at,
                        fetched_at=now,
                    )
                )
            else:
                stored_pr.title = pr.title
                stored_pr.author_name = pr.author_name
                stored_pr.repository_name = pr.repository_name
                stored_pr.pr_url = pr.url
                stored_pr.pr_status = pr.status
                stored_pr.azure_created_at = pr.azure_created_at
                stored_pr.fetched_at = now
                stored_pr.updated_at = now
            await session.commit()

    async def manual_review(self, pr_id: int) -> None:
        async with review_lock:
            prs = await self.azure.list_assigned_active_prs()
            pr = next((item for item in prs if item.pr_id == pr_id), None)
            if pr is None:
                raise ValueError(
                    "PR is not active, or was not created by / assigned to the configured identity"
                )
            await self._review_if_needed(pr, force=True)

    async def _review_if_needed(
        self, pr: PullRequestData, force: bool = False
    ) -> None:
        iteration = await self._prepare_iteration(pr, force)
        if iteration is None:
            return

        try:
            if await self._daily_cost() >= self.settings.daily_cost_cap_usd:
                await self._set_skipped(
                    iteration.id,
                    "Daily LLM cost cap reached; this iteration will retry next day",
                    transient=True,
                )
                return

            diff, changed_lines = await self.azure.build_diff(pr)
            if changed_lines > self.settings.max_changed_lines:
                await self._set_skipped(
                    iteration.id,
                    f"Diff has {changed_lines} changed lines, exceeding the "
                    f"{self.settings.max_changed_lines}-line limit",
                    transient=False,
                )
                return
            if not diff:
                await self._set_skipped(
                    iteration.id, "No reviewable text changes found", transient=False
                )
                return

            result = await self.llm.review(diff)
            current_pr = await self.azure.get_pr(pr.repository_id, pr.pr_id)
            if current_pr.status != "active":
                await self._set_skipped(
                    iteration.id,
                    f"PR became {current_pr.status} before comments were posted",
                    transient=False,
                    result=result,
                )
                return
            if current_pr.source_commit != pr.source_commit:
                await self._set_skipped(
                    iteration.id,
                    "A new commit arrived before comments were posted",
                    transient=False,
                    result=result,
                )
                return

            await self._mark_attempting(iteration.id, result)
            posted = 0
            for finding in result.review.findings:
                if finding.severity == "nit":
                    continue
                try:
                    await self.azure.post_comment(
                        pr,
                        finding.file,
                        finding.line,
                        finding.severity,
                        finding.comment,
                    )
                    posted += 1
                except AzureDevOpsError as exc:
                    await self._mark_failed(
                        iteration.id,
                        str(exc),
                        transient=exc.transient and posted == 0,
                    )
                    return
            await self._mark_reviewed(iteration.id, result, posted)
        except (AzureDevOpsError, LlmError) as exc:
            await self._mark_failed(iteration.id, str(exc), transient=exc.transient)
        except Exception as exc:
            await self._mark_failed(iteration.id, str(exc), transient=True)
            raise

    async def _prepare_iteration(
        self, pr: PullRequestData, force: bool
    ) -> PrReviewIteration | None:
        async with session_factory() as session:
            now = utc_now()
            stored_pr = await session.get(PullRequest, pr.pr_id)
            if stored_pr is None:
                stored_pr = PullRequest(
                    pr_id=pr.pr_id,
                    title=pr.title,
                    author_name=pr.author_name,
                    repository_name=pr.repository_name,
                    pr_url=pr.url,
                    pr_status=pr.status,
                    azure_created_at=pr.azure_created_at,
                    fetched_at=now,
                )
                session.add(stored_pr)
            else:
                stored_pr.title = pr.title
                stored_pr.author_name = pr.author_name
                stored_pr.repository_name = pr.repository_name
                stored_pr.pr_url = pr.url
                stored_pr.pr_status = pr.status
                stored_pr.azure_created_at = pr.azure_created_at
                stored_pr.fetched_at = now
                stored_pr.updated_at = now

            statement = select(PrReviewIteration).where(
                PrReviewIteration.pr_id == pr.pr_id,
                PrReviewIteration.last_commit_id == pr.source_commit,
            )
            iteration = (await session.exec(statement)).one_or_none()
            if iteration is None:
                iteration = PrReviewIteration(
                    pr_id=pr.pr_id,
                    last_commit_id=pr.source_commit,
                    status="PENDING",
                )
                session.add(iteration)
            elif force:
                iteration.status = "PENDING"
                iteration.error_message = None
                iteration.error_type = None
                iteration.reviewed_at = None
            elif not self._is_retryable(iteration):
                await session.commit()
                return None

            await session.commit()
            await session.refresh(iteration)
            return iteration

    @staticmethod
    def _is_retryable(iteration: PrReviewIteration) -> bool:
        if iteration.status == "PENDING":
            return True
        return (
            iteration.status in {"FAILED", "SKIPPED"}
            and iteration.error_type == "TRANSIENT"
        )

    async def _daily_cost(self) -> float:
        today = datetime.now(timezone.utc).date().isoformat()
        async with session_factory() as session:
            statement = select(
                func.coalesce(func.sum(PrReviewIteration.estimated_cost_usd), 0.0)
            ).where(func.date(PrReviewIteration.created_at) == today)
            return float((await session.exec(statement)).one())

    async def _set_skipped(
        self,
        iteration_id: int | None,
        message: str,
        transient: bool,
        result: LlmResponse | None = None,
    ) -> None:
        await self._update_iteration(
            iteration_id,
            status="SKIPPED",
            error_message=message,
            error_type="TRANSIENT" if transient else "PERMANENT",
            result=result,
        )

    async def _mark_attempting(
        self, iteration_id: int | None, result: LlmResponse
    ) -> None:
        await self._update_iteration(
            iteration_id, status="ATTEMPTING", result=result
        )

    async def _mark_failed(
        self, iteration_id: int | None, message: str, transient: bool
    ) -> None:
        await self._update_iteration(
            iteration_id,
            status="FAILED",
            error_message=message[:2000],
            error_type="TRANSIENT" if transient else "PERMANENT",
        )

    async def _mark_reviewed(
        self, iteration_id: int | None, result: LlmResponse, posted: int
    ) -> None:
        counts = {"critical": 0, "suggestion": 0, "nit": 0}
        for finding in result.review.findings:
            counts[finding.severity] += 1
        summary = (
            f"Found {counts['critical']} critical, {counts['suggestion']} suggestion, "
            f"and {counts['nit']} nit issue(s). Posted {posted} comment(s)."
        )
        await self._update_iteration(
            iteration_id,
            status="REVIEWED",
            ai_summary=summary,
            reviewed_at=utc_now(),
            result=result,
            clear_error=True,
        )

    async def _update_iteration(
        self,
        iteration_id: int | None,
        *,
        status: str,
        error_message: str | None = None,
        error_type: str | None = None,
        ai_summary: str | None = None,
        reviewed_at: datetime | None = None,
        result: LlmResponse | None = None,
        clear_error: bool = False,
    ) -> None:
        if iteration_id is None:
            raise RuntimeError("Iteration was not persisted")
        async with session_factory() as session:
            iteration = await session.get(PrReviewIteration, iteration_id)
            if iteration is None:
                raise RuntimeError("Iteration no longer exists")
            iteration.status = status
            if clear_error:
                iteration.error_message = None
                iteration.error_type = None
            else:
                iteration.error_message = error_message
                iteration.error_type = error_type
            if ai_summary is not None:
                iteration.ai_summary = ai_summary
            if reviewed_at is not None:
                iteration.reviewed_at = reviewed_at
            if result is not None:
                iteration.raw_ai_response = json.dumps(
                    result.review.model_dump(), separators=(",", ":")
                )
                iteration.tokens_used = result.tokens_used
                iteration.estimated_cost_usd = result.estimated_cost_usd
            await session.commit()
