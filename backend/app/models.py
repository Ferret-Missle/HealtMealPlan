from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime,
    ForeignKey, Text, JSON, Enum as SAEnum
)
from sqlalchemy.orm import relationship
from .database import Base
import enum


class PlanType(str, enum.Enum):
    free = "free"
    byok = "byok"


class GroupType(str, enum.Enum):
    personal = "personal"
    family = "family"


class MealType(str, enum.Enum):
    breakfast = "breakfast"
    lunch = "lunch"
    dinner = "dinner"
    snack = "snack"


class SharingType(str, enum.Enum):
    shared = "shared"
    individual = "individual"


class PlanStatus(str, enum.Enum):
    draft = "draft"
    confirmed = "confirmed"


class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True)  # Firebase UID
    email = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    privacy_public = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    # ダッシュボード並び順・表示設定（cloud 同期）
    dashboard_settings_json = Column(JSON)

    oauth_tokens = relationship("OAuthToken", back_populates="user", cascade="all, delete-orphan")
    api_keys = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
    user_plan = relationship("UserPlan", back_populates="user", uselist=False, cascade="all, delete-orphan")
    user_goals = relationship("UserGoals", back_populates="user", uselist=False, cascade="all, delete-orphan")
    weight_logs = relationship("WeightLog", back_populates="user", cascade="all, delete-orphan")
    activity_logs = relationship("ActivityLog", back_populates="user", cascade="all, delete-orphan")
    meal_logs = relationship("MealLog", back_populates="user", cascade="all, delete-orphan")
    consents = relationship("UserConsent", back_populates="user", cascade="all, delete-orphan")
    calendar_settings = relationship("CalendarSetting", back_populates="user", cascade="all, delete-orphan")


class Group(Base):
    __tablename__ = "groups"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    type = Column(SAEnum(GroupType), nullable=False, default=GroupType.personal)
    created_at = Column(DateTime, default=datetime.utcnow)
    # グループ共通設定（プラン作成画面のメンバー別デフォルト設定など、メンバー全員で共有）
    shared_settings_json = Column(JSON)

    members = relationship("GroupMember", back_populates="group", cascade="all, delete-orphan")
    invitations = relationship("GroupInvitation", back_populates="group", cascade="all, delete-orphan")
    meal_plans = relationship("MealPlan", back_populates="group", cascade="all, delete-orphan")


class GroupMember(Base):
    __tablename__ = "group_members"
    group_id = Column(String, ForeignKey("groups.id"), primary_key=True)
    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    role = Column(String, default="member")  # owner / member

    group = relationship("Group", back_populates="members")
    user = relationship("User")


class GroupInvitation(Base):
    __tablename__ = "group_invitations"
    id = Column(String, primary_key=True)
    group_id = Column(String, ForeignKey("groups.id"), nullable=False)
    inviter_user_id = Column(String, ForeignKey("users.id"), nullable=False)
    invited_email = Column(String, nullable=False)
    token = Column(String, unique=True, nullable=False)
    status = Column(String, default="pending")  # pending / accepted / expired
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    group = relationship("Group", back_populates="invitations")


class OAuthToken(Base):
    __tablename__ = "oauth_tokens"
    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    service = Column(String, primary_key=True)  # fitbit / healthplanet / fatsecret / google
    access_token = Column(Text, nullable=False)   # AES-256-GCM encrypted
    refresh_token = Column(Text)                  # AES-256-GCM encrypted
    expires_at = Column(DateTime)
    extra_json = Column(JSON)  # service-specific extra data (e.g. oauth1 verifier)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="oauth_tokens")


class ApiKey(Base):
    __tablename__ = "api_keys"
    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    provider = Column(String, primary_key=True)  # anthropic / openai / gemini / groq / mistral
    encrypted_key = Column(Text, nullable=False)  # AES-256-GCM encrypted
    key_hint = Column(String, nullable=False)     # last 4 chars
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="api_keys")


class UserPlan(Base):
    __tablename__ = "user_plans"
    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    plan_type = Column(SAEnum(PlanType), default=PlanType.free)
    byok_provider = Column(String)  # active BYOK provider
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 利用するモデル名（adapter 内のデフォルトを上書き）
    byok_model = Column(String)
    # True のとき BYOK 設定を持っていても無料プラン (Groq) を使用する一時切替
    force_free_llm = Column(Boolean, default=False)

    user = relationship("User", back_populates="user_plan")


class UserGoals(Base):
    __tablename__ = "user_goals"
    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    target_weight = Column(Float)
    target_kcal = Column(Integer)
    target_protein_ratio = Column(Float, default=0.30)
    target_fat_ratio = Column(Float, default=0.25)
    target_carb_ratio = Column(Float, default=0.45)
    deadline = Column(DateTime)
    preferences_json = Column(JSON)   # {"activity_level": "sedentary", "diet_style": ["和食", "高タンパク"]}
    excluded_foods_json = Column(JSON)  # ["甲殻類"]
    age_group = Column(String)
    gender = Column(String)
    height_cm = Column(Float)
    goal_type = Column(String, default="loss")  # loss / maintain / gain
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="user_goals")


class UserConsent(Base):
    __tablename__ = "user_consents"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    document_type = Column(String, nullable=False)  # terms / privacy
    version = Column(String, nullable=False)
    agreed_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="consents")


class CalendarSetting(Base):
    __tablename__ = "calendar_settings"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    calendar_id = Column(String, nullable=False)
    calendar_name = Column(String, nullable=False)
    is_shared = Column(Boolean, default=False)
    use_for_meal_plan = Column(Boolean, default=True)

    user = relationship("User", back_populates="calendar_settings")


class WeightLog(Base):
    __tablename__ = "weight_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    date = Column(String, nullable=False)  # YYYY-MM-DD
    weight = Column(Float)
    body_fat = Column(Float)
    muscle_mass = Column(Float)
    bmi = Column(Float)
    basal_metabolism_kcal = Column(Float)
    body_age = Column(Integer)
    bone_mass = Column(Float)
    visceral_fat_level = Column(Float)
    source = Column(String, default="manual")  # healthplanet / fitbit / manual
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="weight_logs")


class ActivityLog(Base):
    __tablename__ = "activity_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    date = Column(String, nullable=False)
    steps = Column(Integer)
    active_kcal = Column(Integer)
    calories_out = Column(Integer)
    sleep_hours = Column(Float)
    sleep_score = Column(Integer)
    heart_rate_zones_json = Column(JSON)
    source = Column(String, default="fitbit")
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="activity_logs")


class MealLog(Base):
    __tablename__ = "meal_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    date = Column(String, nullable=False)
    meal_type = Column(SAEnum(MealType), nullable=False)
    food_name = Column(String, nullable=False)
    food_id = Column(String)  # FatSecret food_id
    kcal = Column(Float, nullable=False)
    protein_g = Column(Float, default=0)
    fat_g = Column(Float, default=0)
    carb_g = Column(Float, default=0)
    serving_grams = Column(Float)
    source = Column(String, default="manual")  # fatsecret / llm_vision / manual
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="meal_logs")


class MealPlan(Base):
    __tablename__ = "meal_plans"
    id = Column(String, primary_key=True)
    group_id = Column(String, ForeignKey("groups.id"), nullable=False)
    start_date = Column(String, nullable=False)
    end_date = Column(String, nullable=False)
    status = Column(SAEnum(PlanStatus), default=PlanStatus.draft)
    conditions_json = Column(JSON, nullable=True)   # generation conditions
    progress_json = Column(JSON, nullable=True)     # runtime generation progress
    created_at = Column(DateTime, default=datetime.utcnow)

    group = relationship("Group", back_populates="meal_plans")
    days = relationship("MealPlanDay", back_populates="plan", cascade="all, delete-orphan")
    shopping_lists = relationship("ShoppingList", back_populates="plan", cascade="all, delete-orphan")


class MealPlanDay(Base):
    __tablename__ = "meal_plan_days"
    id = Column(String, primary_key=True)
    meal_plan_id = Column(String, ForeignKey("meal_plans.id"), nullable=False)
    date = Column(String, nullable=False)

    plan = relationship("MealPlan", back_populates="days")
    slots = relationship("MealPlanSlot", back_populates="day", cascade="all, delete-orphan")


class MealPlanSlot(Base):
    __tablename__ = "meal_plan_slots"
    id = Column(String, primary_key=True)
    meal_plan_day_id = Column(String, ForeignKey("meal_plan_days.id"), nullable=False)
    meal_type = Column(SAEnum(MealType), nullable=False)
    sharing_type = Column(SAEnum(SharingType), default=SharingType.shared)
    is_dining_out = Column(Boolean, default=False)   # S2: 外食フラグ
    dining_out_kcal = Column(Float, nullable=True)    # S2: 外食時の手動入力カロリー
    source_type = Column(String, nullable=True)       # conbini / homecook (生成条件から設定)
    kcal_budget = Column(Float, nullable=True)        # この食事の目標カロリー

    day = relationship("MealPlanDay", back_populates="slots")
    items = relationship("MealPlanItem", back_populates="slot", cascade="all, delete-orphan")


class MealPlanItem(Base):
    __tablename__ = "meal_plan_items"
    id = Column(String, primary_key=True)
    meal_plan_slot_id = Column(String, ForeignKey("meal_plan_slots.id"), nullable=False)
    user_id = Column(String)  # NULL = shared food
    menu_name = Column(String, nullable=False)
    kcal = Column(Float)
    protein_g = Column(Float)
    fat_g = Column(Float)
    carb_g = Column(Float)
    serving_grams = Column(Float)
    ingredients_json = Column(JSON)
    cooking_summary = Column(Text)
    # 生成時のLLMトークン使用量
    input_tokens = Column(Integer)
    output_tokens = Column(Integer)
    llm_model = Column(String)
    # 生成時に LLM へ送ったプロンプト（デバッグ用）
    system_prompt = Column(Text)
    user_prompt = Column(Text)

    slot = relationship("MealPlanSlot", back_populates="items")


class ShoppingList(Base):
    __tablename__ = "shopping_lists"
    id = Column(String, primary_key=True)
    meal_plan_id = Column(String, ForeignKey("meal_plans.id"), nullable=False)
    list_type = Column(String)  # shared / individual
    user_id = Column(String)    # NULL for shared
    items_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

    plan = relationship("MealPlan", back_populates="shopping_lists")


class UsageLog(Base):
    __tablename__ = "usage_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    feature = Column(String, nullable=False)  # meal_plan_daily / meal_plan_weekly / chat / recalculate
    plan_type = Column(SAEnum(PlanType), nullable=False)
    used_at = Column(DateTime, default=datetime.utcnow)
