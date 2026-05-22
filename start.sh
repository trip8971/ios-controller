#!/bin/bash
# 启动 iOS 远程控制系统
# 自动检测：有运行中的 Simulator 则启动画面捕获，否则只启动 server + web（真机模式）
# 停止: Ctrl+C

DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
    echo ""
    echo "[Stop] Shutting down..."
    kill $PID_SERVER $PID_WEB $PID_CAPTURE 2>/dev/null
    wait $PID_SERVER $PID_WEB $PID_CAPTURE 2>/dev/null
    echo "[Stop] Done"
    exit 0
}
trap cleanup INT TERM

lsof -ti:8080 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# 1. 信令服务器 (TypeScript via tsx)
echo "[Start] Server on :8080"
(cd "$DIR/server" && npx tsx src/server.ts) &
PID_SERVER=$!
sleep 1

# 2. Web 前端 (Vite dev server)
echo "[Start] Web on :5173"
(cd "$DIR/web" && npx vite --host) &
PID_WEB=$!

# 3. 检测 Simulator
BOOTED=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted")
if [ "$BOOTED" -gt 0 ]; then
    echo "[Start] Simulator detected, building capture..."
    (cd "$DIR/simulator-capture" && swift build -q 2>&1)
    echo "[Start] Simulator capture"
    (cd "$DIR/simulator-capture" && swift run -q) &
    PID_CAPTURE=$!
    echo ""
    echo "==================================="
    echo "  模式: Simulator"
    echo "  浏览器打开: http://localhost:5173"
    echo "  Ctrl+C 停止所有服务"
    echo "==================================="
else
    echo ""
    echo "==================================="
    echo "  模式: 真机"
    echo "  浏览器打开: http://localhost:5173"
    echo "  Ctrl+C 停止所有服务"
    echo "==================================="
fi

echo ""
wait
