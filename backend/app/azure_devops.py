import asyncio
import base64
import difflib
import fnmatch
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any

import httpx

from .config import Settings


SEVERITY_EMOJI = {
    "critical": "🔴",
    "suggestion": "🟡",
    "nit": "⚪",
}


class AzureDevOpsError(Exception):
    def __init__(self, message: str, transient: bool) -> None:
        super().__init__(message)
        self.transient = transient


@dataclass
class PullRequestData:
    pr_id: int
    title: str
    author_name: str
    repository_id: str
    repository_name: str
    url: str
    status: str
    source_commit: str
    target_commit: str
    azure_created_at: datetime


EXCLUDED_PATHS = (
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.min.js",
    "*.min.css",
    "dist/*",
    "node_modules/*",
    "vendor/*",
)


class AzureDevOpsClient:
    def __init__(self, settings: Settings) -> None:
        token = base64.b64encode(f":{settings.azure_devops_pat}".encode()).decode()
        self.organization = settings.azure_devops_organization
        self.project = settings.azure_devops_project
        self.base_url = (
            f"https://dev.azure.com/{self.organization}/"
            f"{self.project}/_apis/git"
        )
        self.identity = settings.azure_devops_reviewer.casefold()
        self.max_changed_lines = settings.max_changed_lines
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Basic {token}"},
            timeout=httpx.Timeout(30),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(4):
            try:
                response = await self.client.request(method, url, **kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt == 3:
                    raise AzureDevOpsError(str(exc), transient=True) from exc
                await asyncio.sleep(2**attempt)
                continue

            if response.status_code < 400:
                return response
            body = response.text[:500]
            # Folder/tree content requests never succeed on retry.
            tree_as_blob = (
                "expected a blob" in body.casefold()
                or "gitunexpectedobjecttypeexception" in body.casefold()
            )
            transient = (
                not tree_as_blob
                and (response.status_code == 429 or response.status_code >= 500)
            )
            if not transient or attempt == 3:
                raise AzureDevOpsError(
                    f"Azure DevOps returned {response.status_code}: {body}",
                    transient=transient,
                )
            await asyncio.sleep(self._retry_delay(response, attempt))
        raise AzureDevOpsError("Azure DevOps request failed", transient=True)

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        value = response.headers.get("Retry-After")
        if value:
            try:
                return max(0.0, float(value))
            except ValueError:
                try:
                    return max(
                        0.0,
                        (parsedate_to_datetime(value) - parsedate_to_datetime(
                            response.headers["Date"]
                        )).total_seconds(),
                    )
                except (KeyError, TypeError, ValueError):
                    pass
        return float(2**attempt)

    async def list_assigned_active_prs(self) -> list[PullRequestData]:
        """Active PRs created by or assigned to the configured identity."""
        response = await self._request(
            "GET",
            f"{self.base_url}/pullrequests",
            params={"searchCriteria.status": "active", "api-version": "7.1"},
        )
        results = []
        for raw in response.json().get("value", []):
            if self._is_created_by_me(raw) or self._is_assigned_to_me(raw):
                results.append(self._parse_pr(raw))
        return results

    async def get_repository_id(self, repository_name: str) -> str:
        response = await self._request(
            "GET",
            f"{self.base_url}/repositories/{repository_name}",
            params={"api-version": "7.1"},
        )
        return response.json()["id"]

    async def get_pr(self, repository_id: str, pr_id: int) -> PullRequestData:
        response = await self._request(
            "GET",
            f"{self.base_url}/repositories/{repository_id}/pullRequests/{pr_id}",
            params={"api-version": "7.1"},
        )
        return self._parse_pr(response.json())

    async def get_pr_by_repository_name(
        self, repository_name: str, pr_id: int
    ) -> PullRequestData:
        repository_id = await self.get_repository_id(repository_name)
        return await self.get_pr(repository_id, pr_id)

    def _is_created_by_me(self, raw: dict[str, Any]) -> bool:
        return self._identity_matches(raw.get("createdBy", {}))

    def _is_assigned_to_me(self, raw: dict[str, Any]) -> bool:
        return any(
            self._identity_matches(item) for item in raw.get("reviewers", [])
        )

    def _identity_matches(self, identity: dict[str, Any]) -> bool:
        candidates = (
            identity.get("id", ""),
            identity.get("displayName", ""),
            identity.get("uniqueName", ""),
        )
        return self.identity in {str(candidate).casefold() for candidate in candidates}

    def _web_url(self, repository_name: str, pr_id: int) -> str:
        return (
            f"https://dev.azure.com/{self.organization}/{self.project}/_git/"
            f"{repository_name}/pullrequest/{pr_id}"
        )

    def _parse_pr(self, raw: dict[str, Any]) -> PullRequestData:
        repository = raw["repository"]
        repository_name = repository["name"]
        pr_id = raw["pullRequestId"]
        creation_date = raw.get("creationDate")
        if not creation_date:
            raise AzureDevOpsError(
                f"PR {pr_id} is missing creationDate from Azure DevOps",
                transient=False,
            )
        return PullRequestData(
            pr_id=pr_id,
            title=raw["title"],
            author_name=raw["createdBy"]["displayName"],
            repository_id=repository["id"],
            repository_name=repository_name,
            url=self._web_url(repository_name, pr_id),
            status=raw["status"].casefold(),
            source_commit=raw["lastMergeSourceCommit"]["commitId"],
            target_commit=raw["lastMergeTargetCommit"]["commitId"],
            azure_created_at=self._parse_datetime(creation_date),
        )

    @staticmethod
    def _parse_datetime(value: Any) -> datetime:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if isinstance(value, str) and value:
            normalized = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        raise AzureDevOpsError(
            f"Invalid Azure DevOps datetime value: {value!r}",
            transient=False,
        )

    async def build_diff(self, pr: PullRequestData) -> tuple[str, int]:
        changes_response = await self._request(
            "GET",
            f"{self.base_url}/repositories/{pr.repository_id}/diffs/commits",
            params={
                "baseVersion": pr.target_commit,
                "baseVersionType": "commit",
                "targetVersion": pr.source_commit,
                "targetVersionType": "commit",
                "$top": 2000,
                "api-version": "7.1",
            },
        )

        changes_data = changes_response.json()
        if changes_data.get("allChangesIncluded") is False:
            return "", self.max_changed_lines + 1

        patches: list[str] = []
        changed_lines = 0
        for change in changes_data.get("changes", []):
            item = change.get("item", {})
            if item.get("isFolder") or str(item.get("gitObjectType", "")).casefold() == "tree":
                continue
            path = item.get("path", "").lstrip("/")
            if not path or self._excluded(path):
                continue
            change_type = str(change.get("changeType", "")).casefold()
            old_text = (
                ""
                if "add" in change_type
                else await self._get_text(pr.repository_id, path, pr.target_commit)
            )
            new_text = (
                ""
                if "delete" in change_type
                else await self._get_text(pr.repository_id, path, pr.source_commit)
            )
            if old_text is None or new_text is None:
                continue
            patch = list(
                difflib.unified_diff(
                    old_text.splitlines(),
                    new_text.splitlines(),
                    fromfile=f"a/{path}",
                    tofile=f"b/{path}",
                    lineterm="",
                )
            )
            if patch:
                changed_lines += sum(
                    1
                    for line in patch
                    if (line.startswith("+") or line.startswith("-"))
                    and not line.startswith(("+++", "---"))
                )
                patches.append("\n".join(patch))
        return "\n\n".join(patches), changed_lines

    async def _get_text(
        self, repository_id: str, path: str, commit_id: str
    ) -> str | None:
        try:
            response = await self._request(
                "GET",
                f"{self.base_url}/repositories/{repository_id}/items",
                params={
                    "path": f"/{path}",
                    "versionDescriptor.version": commit_id,
                    "versionDescriptor.versionType": "commit",
                    "includeContent": "true",
                    "api-version": "7.1",
                },
            )
        except AzureDevOpsError as exc:
            # Folder/tree objects and missing blobs are not reviewable text.
            message = str(exc).casefold()
            if "resolved to a tree" in message or "expected a blob" in message:
                return None
            raise
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            data = response.json()
            if data.get("isFolder") or str(data.get("gitObjectType", "")).casefold() == "tree":
                return None
            content = data.get("content")
            return content if isinstance(content, str) else None
        try:
            return response.content.decode("utf-8")
        except UnicodeDecodeError:
            return None

    @staticmethod
    def _excluded(path: str) -> bool:
        normalized = str(PurePosixPath(path))
        return any(
            fnmatch.fnmatch(normalized, pattern)
            or fnmatch.fnmatch(PurePosixPath(normalized).name, pattern)
            for pattern in EXCLUDED_PATHS
        )

    async def post_comment(
        self,
        pr: PullRequestData,
        file_path: str,
        line: int,
        severity: str,
        category: str,
        comment: str,
    ) -> None:
        emoji = SEVERITY_EMOJI.get(severity, "⚪")
        content = f"**AI review — {emoji} {severity} ({category})**\n\n{comment}"
        body = {
            "comments": [
                {
                    "parentCommentId": 0,
                    "content": content,
                    "commentType": 1,
                }
            ],
            "status": 1,
            "threadContext": {
                "filePath": f"/{file_path.lstrip('/')}",
                "rightFileStart": {"line": line, "offset": 1},
                "rightFileEnd": {"line": line, "offset": 1},
            },
            "properties": {
                "Microsoft.TeamFoundation.Discussion.SupportsMarkdown": {
                    "type": "System.Int32",
                    "value": 1,
                }
            },
        }
        await self._request(
            "POST",
            f"{self.base_url}/repositories/{pr.repository_id}/pullRequests/"
            f"{pr.pr_id}/threads",
            params={"api-version": "7.1"},
            json=body,
        )
