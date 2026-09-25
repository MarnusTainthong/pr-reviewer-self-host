from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import select

from ..database import session_factory
from ..llm import LlmClient, LlmConfig, LlmError
from ..models import LlmModel, utc_now


router = APIRouter(prefix="/models", tags=["models"])


class LlmModelBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(min_length=1)
    model: str = Field(min_length=1, max_length=200)
    input_cost_per_million: float = Field(default=0.0, ge=0)
    output_cost_per_million: float = Field(default=0.0, ge=0)


class LlmModelUpdateBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str | None = Field(default=None, min_length=1)
    model: str = Field(min_length=1, max_length=200)
    input_cost_per_million: float = Field(default=0.0, ge=0)
    output_cost_per_million: float = Field(default=0.0, ge=0)


def _serialize(model: LlmModel) -> dict:
    key = model.api_key
    masked = (
        f"{'*' * max(0, len(key) - 4)}{key[-4:]}"
        if len(key) > 4
        else "****"
    )
    return {
        "id": model.id,
        "name": model.name,
        "base_url": model.base_url,
        "api_key_masked": masked,
        "model": model.model,
        "input_cost_per_million": model.input_cost_per_million,
        "output_cost_per_million": model.output_cost_per_million,
        "is_active": model.is_active,
        "created_at": model.created_at,
        "updated_at": model.updated_at,
    }


def _to_llm_config(model: LlmModel) -> LlmConfig:
    return LlmConfig(
        name=model.name,
        base_url=model.base_url.rstrip("/"),
        api_key=model.api_key,
        model=model.model,
        input_cost_per_million=model.input_cost_per_million,
        output_cost_per_million=model.output_cost_per_million,
    )


@router.get("")
async def list_models():
    async with session_factory() as session:
        models = (
            await session.exec(
                select(LlmModel).order_by(LlmModel.is_active.desc(), LlmModel.name)
            )
        ).all()
    return {"items": [_serialize(model) for model in models]}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_model(body: LlmModelBody):
    async with session_factory() as session:
        existing = (await session.exec(select(LlmModel))).all()
        model = LlmModel(
            name=body.name.strip(),
            base_url=body.base_url.strip().rstrip("/"),
            api_key=body.api_key.strip(),
            model=body.model.strip(),
            input_cost_per_million=body.input_cost_per_million,
            output_cost_per_million=body.output_cost_per_million,
            is_active=len(existing) == 0,
        )
        session.add(model)
        await session.commit()
        await session.refresh(model)
    return _serialize(model)


@router.put("/{model_id}")
async def update_model(model_id: int, body: LlmModelUpdateBody):
    async with session_factory() as session:
        model = await session.get(LlmModel, model_id)
        if model is None:
            raise HTTPException(status_code=404, detail="Model not found")
        model.name = body.name.strip()
        model.base_url = body.base_url.strip().rstrip("/")
        model.model = body.model.strip()
        model.input_cost_per_million = body.input_cost_per_million
        model.output_cost_per_million = body.output_cost_per_million
        if body.api_key is not None and body.api_key.strip():
            model.api_key = body.api_key.strip()
        model.updated_at = utc_now()
        await session.commit()
        await session.refresh(model)
    return _serialize(model)


@router.post("/{model_id}/activate")
async def activate_model(model_id: int):
    async with session_factory() as session:
        model = await session.get(LlmModel, model_id)
        if model is None:
            raise HTTPException(status_code=404, detail="Model not found")
        others = (await session.exec(select(LlmModel))).all()
        for item in others:
            item.is_active = item.id == model_id
            item.updated_at = utc_now()
        await session.commit()
        await session.refresh(model)
    return _serialize(model)


@router.post("/{model_id}/test")
async def test_model(model_id: int):
    async with session_factory() as session:
        model = await session.get(LlmModel, model_id)
        if model is None:
            raise HTTPException(status_code=404, detail="Model not found")
        config = _to_llm_config(model)

    client = LlmClient()
    try:
        result = await client.test_connection(config)
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Connection test failed: {exc}",
        ) from exc
    finally:
        await client.close()

    return {
        "response_time_ms": result.response_time_ms,
        "response_preview": result.response_preview,
    }


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(model_id: int):
    async with session_factory() as session:
        model = await session.get(LlmModel, model_id)
        if model is None:
            raise HTTPException(status_code=404, detail="Model not found")
        was_active = model.is_active
        await session.delete(model)
        if was_active:
            remaining = (
                await session.exec(select(LlmModel).order_by(LlmModel.id))
            ).all()
            if remaining:
                remaining[0].is_active = True
                remaining[0].updated_at = utc_now()
        await session.commit()
    return None
