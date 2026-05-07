import os
import uuid
from datetime import datetime, timedelta
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel
import httpx

from ..database import get_db
from .. import models, security
from ..auth_deps import get_current_user

router = APIRouter()
MAX_MEMBERS = 7


@router.get("/my/schedules")
async def get_group_schedules(
    start_date: str,
    days: int = 7,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """全グループメンバーの Google Calendar 予定を取得する。"""
    # start_date 形式チェック
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(422, "start_date must be YYYY-MM-DD format")

    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        raise HTTPException(404, "No group found")

    members = db.query(models.GroupMember).filter_by(group_id=member.group_id).all()

    end = start + timedelta(days=days)
    time_min = start.strftime("%Y-%m-%dT00:00:00Z")
    time_max = end.strftime("%Y-%m-%dT00:00:00Z")

    result = {}
    for m in members:
        user = db.query(models.User).filter_by(id=m.user_id).first()
        if not user:
            continue

        token_rec = db.query(models.OAuthToken).filter_by(user_id=m.user_id, service="google").first()
        if not token_rec:
            # Google 未連携 — null で返して frontend が識別できるようにする
            result[m.user_id] = {"name": user.name, "events": None}
            continue

        # CalendarSetting で use_for_meal_plan=True のカレンダーを優先。なければ primary を使う
        cal_settings = (
            db.query(models.CalendarSetting)
            .filter_by(user_id=m.user_id, use_for_meal_plan=True)
            .all()
        )
        calendar_ids = [cs.calendar_id for cs in cal_settings] if cal_settings else ["primary"]

        try:
            access_token = security.decrypt(token_rec.access_token)

            # 期限切れの場合はリフレッシュ
            if token_rec.expires_at and token_rec.expires_at < datetime.utcnow() and token_rec.refresh_token:
                refresh_token = security.decrypt(token_rec.refresh_token)
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        "https://oauth2.googleapis.com/token",
                        data={
                            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
                            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
                            "refresh_token": refresh_token,
                            "grant_type": "refresh_token",
                        },
                    )
                if resp.status_code == 200:
                    data = resp.json()
                    token_rec.access_token = security.encrypt(data["access_token"])
                    token_rec.expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 3600))
                    db.commit()
                    access_token = data["access_token"]

            events = []
            async with httpx.AsyncClient() as client:
                for cal_id in calendar_ids:
                    encoded_calendar_id = quote(cal_id, safe="")
                    resp = await client.get(
                        f"https://www.googleapis.com/calendar/v3/calendars/{encoded_calendar_id}/events",
                        headers={"Authorization": f"Bearer {access_token}"},
                        params={
                            "timeMin": time_min,
                            "timeMax": time_max,
                            "singleEvents": "true",
                            "orderBy": "startTime",
                            "maxResults": 30,
                        },
                    )
                    if resp.status_code == 200:
                        for ev in resp.json().get("items", []):
                            start_ev = ev.get("start", {})
                            end_ev = ev.get("end", {})
                            events.append({
                                "summary": ev.get("summary", "(無題)"),
                                "start": start_ev.get("dateTime", start_ev.get("date", "")),
                                "end": end_ev.get("dateTime", end_ev.get("date", "")),
                                "all_day": "date" in start_ev and "dateTime" not in start_ev,
                            })

            result[m.user_id] = {"name": user.name, "events": events}
        except Exception:
            result[m.user_id] = {"name": user.name, "events": []}

    return result


@router.get("/my")
async def get_my_group(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        raise HTTPException(404, "No group found")

    group = db.query(models.Group).filter_by(id=member.group_id).first()
    members = db.query(models.GroupMember).filter_by(group_id=group.id).all()
    pending_invites = (
        db.query(models.GroupInvitation)
        .filter_by(group_id=group.id, status="pending")
        .all()
    )

    member_details = []
    for m in members:
        user = db.query(models.User).filter_by(id=m.user_id).first()
        if user:
            member_details.append({
                "user_id": user.id,
                "name": user.name,
                "role": m.role,
                "privacy_public": user.privacy_public,
            })

    pending_invite_list = [
        {
            "id": inv.id,
            "email": inv.invited_email,
            "expires_at": inv.expires_at.isoformat(),
        }
        for inv in pending_invites
    ]

    return {
        "id": group.id,
        "name": group.name,
        "type": group.type,
        "role": member.role,
        "members": member_details,
        "pending_invitations": len(pending_invites),
        "pending_invitation_list": pending_invite_list,
        "total_slots_used": len(members) + len(pending_invites),
    }


@router.get("/my/shared-settings")
async def get_shared_settings(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """グループ共通設定（プラン作成画面のメンバー別デフォルトなど）を取得。"""
    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        raise HTTPException(404, "No group found")
    group = db.query(models.Group).filter_by(id=member.group_id).first()
    return {"settings": group.shared_settings_json or {}}


class SharedSettingsUpdate(BaseModel):
    settings: dict


@router.put("/my/shared-settings")
async def update_shared_settings(
    payload: SharedSettingsUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """グループ共通設定を更新（メンバー全員で共有）。"""
    from sqlalchemy.orm.attributes import flag_modified
    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        raise HTTPException(404, "No group found")
    group = db.query(models.Group).filter_by(id=member.group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")
    group.shared_settings_json = payload.settings
    flag_modified(group, "shared_settings_json")
    db.commit()
    return {"updated": True}


class GroupCreate(BaseModel):
    name: str
    type: str = "family"


@router.post("/create")
async def create_group(
    payload: GroupCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Remove from current group first (only allow one group)
    existing = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if existing:
        _handle_member_leave(current_user.id, existing.group_id, db)

    group_id = str(uuid.uuid4())
    group = models.Group(
        id=group_id,
        name=payload.name,
        type=models.GroupType.family if payload.type == "family" else models.GroupType.personal,
    )
    db.add(group)
    member = models.GroupMember(group_id=group_id, user_id=current_user.id, role="owner")
    db.add(member)
    db.commit()
    return {"group_id": group_id}


class InviteCreate(BaseModel):
    email: str


@router.get("/invitations/pending")
async def get_my_pending_invitations(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    now = datetime.utcnow()

    invitations = (
        db.query(models.GroupInvitation, models.Group, models.User)
        .join(models.Group, models.Group.id == models.GroupInvitation.group_id)
        .join(models.User, models.User.id == models.GroupInvitation.inviter_user_id)
        .filter(
            func.lower(models.GroupInvitation.invited_email) == current_user.email.lower(),
            models.GroupInvitation.status == "pending",
        )
        .order_by(models.GroupInvitation.created_at.desc())
        .all()
    )

    active_invitations = []
    expired_invitations = []

    for invitation, group, inviter in invitations:
        if invitation.expires_at <= now:
            invitation.status = "expired"
            expired_invitations.append(invitation)
            continue

        active_invitations.append({
            "id": invitation.id,
            "token": invitation.token,
            "invite_url": f"{frontend_url}/invite/{invitation.token}",
            "group_id": group.id,
            "group_name": group.name,
            "inviter_name": inviter.name,
            "expires_at": invitation.expires_at.isoformat(),
        })

    if expired_invitations:
        db.commit()

    return {"invitations": active_invitations}


@router.post("/{group_id}/invite")
async def invite_member(
    group_id: str,
    payload: InviteCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(group_id=group_id, user_id=current_user.id, role="owner").first()
    if not member:
        raise HTTPException(403, "Only group owner can invite")

    # Check capacity
    current_members = db.query(models.GroupMember).filter_by(group_id=group_id).count()
    pending = db.query(models.GroupInvitation).filter_by(group_id=group_id, status="pending").count()
    if current_members + pending >= MAX_MEMBERS:
        raise HTTPException(400, f"Group is full (max {MAX_MEMBERS} members)")

    token = str(uuid.uuid4())
    invite = models.GroupInvitation(
        id=str(uuid.uuid4()),
        group_id=group_id,
        inviter_user_id=current_user.id,
        invited_email=payload.email,
        token=token,
        status="pending",
        expires_at=datetime.utcnow() + timedelta(hours=72),
    )
    db.add(invite)
    db.commit()

    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    return {
        "invite_url": f"{frontend_url}/invite/{token}",
        "expires_at": invite.expires_at.isoformat(),
    }


@router.post("/join/{token}")
async def join_group(
    token: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    invite = db.query(models.GroupInvitation).filter_by(token=token).first()
    if not invite:
        raise HTTPException(404, "Invitation not found")
    if invite.status != "pending":
        raise HTTPException(400, "Invitation already used or expired")
    if invite.expires_at < datetime.utcnow():
        invite.status = "expired"
        db.commit()
        raise HTTPException(400, "Invitation has expired")

    # Leave current group
    existing = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if existing:
        _handle_member_leave(current_user.id, existing.group_id, db)

    member = models.GroupMember(group_id=invite.group_id, user_id=current_user.id, role="member")
    db.add(member)
    invite.status = "accepted"
    db.commit()
    return {"joined_group_id": invite.group_id}


@router.put("/{group_id}/transfer-owner/{target_user_id}")
async def transfer_ownership(
    group_id: str,
    target_user_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """オーナー権限を別のメンバーに移譲する。"""
    # 現在のユーザーがオーナーであることを確認
    my_member = db.query(models.GroupMember).filter_by(
        group_id=group_id, user_id=current_user.id, role="owner"
    ).first()
    if not my_member:
        raise HTTPException(403, "Only group owner can transfer ownership")

    # 移譲先がグループメンバーであることを確認
    target_member = db.query(models.GroupMember).filter_by(
        group_id=group_id, user_id=target_user_id
    ).first()
    if not target_member:
        raise HTTPException(404, "Target user is not a member of this group")
    if target_user_id == current_user.id:
        raise HTTPException(400, "Cannot transfer ownership to yourself")

    # 権限を入れ替える
    my_member.role = "member"
    target_member.role = "owner"
    db.commit()
    return {"transferred_to": target_user_id}


@router.delete("/{group_id}/invitations/{invite_id}")
async def cancel_invitation(
    group_id: str,
    invite_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(
        group_id=group_id, user_id=current_user.id, role="owner"
    ).first()
    if not member:
        raise HTTPException(403, "Only group owner can cancel invitations")

    invite = db.query(models.GroupInvitation).filter_by(
        id=invite_id, group_id=group_id, status="pending"
    ).first()
    if not invite:
        raise HTTPException(404, "Invitation not found or already used")

    invite.status = "cancelled"
    db.commit()
    return {"cancelled": True}


@router.delete("/{group_id}/leave")
async def leave_group(
    group_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(group_id=group_id, user_id=current_user.id).first()
    if not member:
        raise HTTPException(404, "Not a member")

    if member.role == "owner":
        other_members = (
            db.query(models.GroupMember)
            .filter_by(group_id=group_id)
            .filter(models.GroupMember.user_id != current_user.id)
            .count()
        )
        if other_members > 0:
            raise HTTPException(400, "Transfer ownership before leaving")

    _handle_member_leave(current_user.id, group_id, db)

    # Create personal group
    personal_id = str(uuid.uuid4())
    group = models.Group(id=personal_id, name="個人グループ", type=models.GroupType.personal)
    db.add(group)
    new_member = models.GroupMember(group_id=personal_id, user_id=current_user.id, role="owner")
    db.add(new_member)
    db.commit()
    return {"new_group_id": personal_id}


def _handle_member_leave(user_id: str, group_id: str, db: Session):
    member = db.query(models.GroupMember).filter_by(group_id=group_id, user_id=user_id).first()
    if member:
        db.delete(member)
        remaining = db.query(models.GroupMember).filter_by(group_id=group_id).count() - 1
        if remaining == 0:
            group = db.query(models.Group).filter_by(id=group_id).first()
            if group:
                group.type = models.GroupType.personal
    db.commit()
