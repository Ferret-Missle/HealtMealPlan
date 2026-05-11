#!/bin/bash
# 健康ナビ 開発サーバー起動スクリプト
set -e

echo "=== 健康ナビ 開発サーバー ==="

# Backend
echo "[1/2] FastAPI バックエンドを起動..."
cd backend

# Create project virtualenv if missing.
if [ ! -d ".venv" ]; then
  echo "  → .venv がないため作成します..."
  if command -v py >/dev/null 2>&1; then
    py -3.12 -m venv .venv || py -3 -m venv .venv
  else
    python -m venv .venv
  fi
fi

# Activate virtualenv (Git Bash on Windows or standard Unix path).
if [ -f ".venv/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source .venv/Scripts/activate
elif [ -f ".venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
else
  echo "  → 仮想環境の activate スクリプトが見つかりません"
  exit 1
fi

# Auto-install backend dependencies when uvicorn is missing.
if ! python -c "import uvicorn" >/dev/null 2>&1; then
  echo "  → uvicorn が見つからないため依存関係をインストールします..."
  python -m pip install -r requirements.txt
fi

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
