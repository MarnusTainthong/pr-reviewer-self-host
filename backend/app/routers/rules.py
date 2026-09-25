from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import select

from ..database import session_factory
from ..models import ReviewRule, utc_now


router = APIRouter(prefix="/rules", tags=["rules"])


class ReviewRuleBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=4000)
    is_enabled: bool = True


class ReviewRuleUpdateBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=4000)
    is_enabled: bool = True


def _serialize(rule: ReviewRule) -> dict:
    return {
        "id": rule.id,
        "title": rule.title,
        "body": rule.body,
        "is_enabled": rule.is_enabled,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


@router.get("")
async def list_rules():
    async with session_factory() as session:
        rules = (
            await session.exec(
                select(ReviewRule).order_by(
                    ReviewRule.is_enabled.desc(), ReviewRule.id
                )
            )
        ).all()
    return {"items": [_serialize(rule) for rule in rules]}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_rule(body: ReviewRuleBody):
    async with session_factory() as session:
        rule = ReviewRule(
            title=body.title.strip(),
            body=body.body.strip(),
            is_enabled=body.is_enabled,
        )
        session.add(rule)
        await session.commit()
        await session.refresh(rule)
    return _serialize(rule)


class ReviewRuleImportBody(BaseModel):
    rules: list[ReviewRuleBody] = Field(min_length=1, max_length=200)


@router.post("/import")
async def import_rules(body: ReviewRuleImportBody):
    created: list[ReviewRule] = []
    async with session_factory() as session:
        for item in body.rules:
            rule = ReviewRule(
                title=item.title.strip(),
                body=item.body.strip(),
                is_enabled=item.is_enabled,
            )
            session.add(rule)
            created.append(rule)
        await session.commit()
        for rule in created:
            await session.refresh(rule)
    return {
        "imported": len(created),
        "items": [_serialize(rule) for rule in created],
    }


@router.put("/{rule_id}")
async def update_rule(rule_id: int, body: ReviewRuleUpdateBody):
    async with session_factory() as session:
        rule = await session.get(ReviewRule, rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail="Rule not found")
        rule.title = body.title.strip()
        rule.body = body.body.strip()
        rule.is_enabled = body.is_enabled
        rule.updated_at = utc_now()
        await session.commit()
        await session.refresh(rule)
    return _serialize(rule)


@router.post("/{rule_id}/toggle")
async def toggle_rule(rule_id: int):
    async with session_factory() as session:
        rule = await session.get(ReviewRule, rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail="Rule not found")
        rule.is_enabled = not rule.is_enabled
        rule.updated_at = utc_now()
        await session.commit()
        await session.refresh(rule)
    return _serialize(rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(rule_id: int):
    async with session_factory() as session:
        rule = await session.get(ReviewRule, rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail="Rule not found")
        await session.delete(rule)
        await session.commit()
    return None
