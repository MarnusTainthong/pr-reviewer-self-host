from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from . import models  # noqa: F401
from .config import get_settings


settings = get_settings()
engine = create_async_engine(settings.database_url)
session_factory = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


@event.listens_for(engine.sync_engine, "connect")
def configure_sqlite(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def _ensure_sqlite_columns(connection) -> None:
    if connection.dialect.name != "sqlite":
        return
    existing = {
        row[1]
        for row in connection.execute(
            text("PRAGMA table_info(pull_requests)")
        ).fetchall()
    }
    if not existing:
        return
    if "azure_created_at" not in existing:
        connection.execute(
            text("ALTER TABLE pull_requests ADD COLUMN azure_created_at DATETIME")
        )
    if "fetched_at" not in existing:
        connection.execute(
            text("ALTER TABLE pull_requests ADD COLUMN fetched_at DATETIME")
        )


async def init_database() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(SQLModel.metadata.create_all)
        await connection.run_sync(_ensure_sqlite_columns)


async def get_session():
    async with session_factory() as session:
        yield session
