#!/usr/bin/env bash
# 知识库工作台一键启动（Linux / macOS）
# 默认使用 Python 运行时；未安装 Python 时自动回退到 Node 运行时。
set -e
cd "$(dirname "$0")"

export KB_HOST=${KB_HOST:-127.0.0.1}
export KB_PORT=${KB_PORT:-8787}
export KB_DATA_DIR=${KB_DATA_DIR:-"$(pwd)/data"}

open_browser() {
  ( sleep 3
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:${KB_PORT}" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "http://127.0.0.1:${KB_PORT}" >/dev/null 2>&1
    fi
  ) &
}

echo "=================================================="
echo "  Knowledge Workbench - unified knowledge base"
echo "=================================================="

if command -v python3 >/dev/null 2>&1; then
  echo "[1/2] Starting Python server on port ${KB_PORT} ..."
  echo "      Web UI  : http://127.0.0.1:${KB_PORT}"
  echo "      Data dir: ${KB_DATA_DIR}"
  echo "      Press Ctrl+C to stop."
  open_browser
  exec python3 server_py/main.py serve
elif command -v node >/dev/null 2>&1; then
  echo "[!] python3 not found, falling back to Node runtime ..."
  open_browser
  exec node server/src/index.js
else
  echo "[X] Neither python3 nor node was found. Please install Python 3.9+ or Node.js 18+."
  exit 1
fi
