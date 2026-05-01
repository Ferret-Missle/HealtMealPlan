import uuid
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user

router = APIRouter()
MAX_MEMBERS = 7


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

    frontend_url = __import__("os").getenv("FRONTEND_URL", "http://localhost:5173")
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
