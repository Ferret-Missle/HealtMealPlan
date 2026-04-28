#!/bin/bash
# 健康ナビ 開発サーバー起動スクリプト
set -e

echo "=== 健康ナビ 開発サーバー ==="

# Backend
echo "[1/2] FastAPI バックエンドを起動..."
cd backend
python -m uvicorn app.main:app --reload --port 8000 &
BACKEND_PID=$!
echo "  → http://localhost:8000/docs"

# Frontend
echo "[2/2] Vite フロントエンドを起動..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!
echo "  → http://localhost:5173"

echo ""
echo "Ctrl+C で両方を停止します"

cleanup() {
  echo "停止中..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
