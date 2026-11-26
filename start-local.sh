#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed. Install Node.js LTS from https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[1/3] First-time setup: installing packages..."
  npm install
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  echo "[2/3] Created .env from .env.example."
  echo "      Optional: add a free Gemini key from https://aistudio.google.com/apikey to .env for HD voice."
fi

echo "[3/3] Starting ApexEngineer on http://localhost:3000 ..."
(sleep 2 && (command -v open >/dev/null 2>&1 && open http://localhost:3000 || command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:3000 || true)) &
npm run dev
