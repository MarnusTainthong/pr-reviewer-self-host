from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import scheduler as scheduler_state
from .auth import require_auth
from .config import get_settings
from .database import engine, init_database
from .routers.metrics import router as metrics_router
from .routers.prs import router as prs_router
from .scheduler import ReviewScheduler


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_database()
    review_scheduler = ReviewScheduler(settings)
    app.state.review_scheduler = review_scheduler
    review_scheduler.start()
    yield
    await review_scheduler.stop()
    await engine.dispose()


app = FastAPI(title="Azure DevOps AI PR Reviewer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(
    prs_router, prefix="/api", dependencies=[Depends(require_auth)]
)
app.include_router(
    metrics_router, prefix="/api", dependencies=[Depends(require_auth)]
)


@app.get("/health")
async def health(response: Response):
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        database = "connected"
    except Exception:
        database = "unavailable"
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "status": "ok" if database == "connected" else "degraded",
        "database": database,
        "last_successful_poll": scheduler_state.last_successful_poll,
    }
