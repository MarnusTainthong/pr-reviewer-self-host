from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    azure_devops_organization: str
    azure_devops_project: str
    azure_devops_pat: str
    azure_devops_reviewer: str

    llm_api_key: str
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_input_cost_per_million: float = 0.15
    llm_output_cost_per_million: float = 0.60
    daily_cost_cap_usd: float = 1.0

    dashboard_auth_token: str = Field(min_length=16)
    database_url: str = "sqlite+aiosqlite:///./data/pr_reviewer.db"
    frontend_origins: str = "http://localhost:5173,http://pr-reviewer-frontend"
    poll_interval_minutes: int = Field(default=5, ge=1)
    max_changed_lines: int = Field(default=3000, ge=100)

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
