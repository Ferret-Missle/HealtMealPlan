import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from dotenv import load_dotenv

from .database import engine, Base
from .routers import auth, dashboard, meals, body, settings, meal_plan, group, shopping, chat

load_dotenv()

limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="健康ナビ API", version="1.0.0", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(meals.router, prefix="/api/meals", tags=["meals"])
app.include_router(body.router, prefix="/api/body", tags=["body"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(meal_plan.router, prefix="/api/meal-plans", tags=["meal_plan"])
app.include_router(group.router, prefix="/api/groups", tags=["group"])
app.include_router(shopping.router, prefix="/api/shopping", tags=["shopping"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])


@app.get("/health")
async def health():
    return {"status": "ok"}
