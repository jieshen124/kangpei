#!/usr/bin/env bash
# 安装依赖并部署聊天室服务
# 用法：sudo bash install.sh /root/chat-src
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
APP_DIR="/opt/chat"
DATA_DIR="/var/lib/chat"

echo "==> [1/7] 安装 Node.js"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm >/dev/null
fi
echo "    node $(node -v)，npm $(npm -v)"

echo "==> [2/7] 创建运行用户 chat"
if ! id chat >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" chat
  echo "    已创建"
else
  echo "    已存在"
fi

echo "==> [3/7] 安装应用文件"
mkdir -p "$APP_DIR/public" "$DATA_DIR"
install -m 644 "$SRC_DIR/server.js" "$APP_DIR/server.js"
install -m 644 "$SRC_DIR/public/index.html" "$APP_DIR/public/index.html"

echo "==> [4/7] 安装依赖 ws"
cd "$APP_DIR"
if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi
npm install ws --omit=dev --no-audit --no-fund 2>&1 | tail -2

echo "==> [5/7] 目录与权限"
chown -R chat:chat "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> [6/7] systemd 服务"
install -m 644 "$SRC_DIR/chat.service" /etc/systemd/system/chat.service
systemctl daemon-reload
systemctl enable chat >/dev/null 2>&1
systemctl restart chat
sleep 2
systemctl --no-pager --lines=5 status chat || true

echo "==> [7/7] nginx 反代配置"
install -m 644 "$SRC_DIR/ws_upgrade.conf" /etc/nginx/conf.d/ws_upgrade.conf
install -m 644 "$SRC_DIR/site.conf" /etc/nginx/sites-available/site.conf
ln -sfn /etc/nginx/sites-available/site.conf /etc/nginx/sites-enabled/site.conf
nginx -t
systemctl reload nginx

echo "==> 自检"
sleep 1
curl -s -o /dev/null -w "    本机 /health  -> HTTP %{http_code}\n" http://127.0.0.1:3000/health
curl -s -o /dev/null -w "    nginx  :80    -> HTTP %{http_code}\n" http://127.0.0.1/
echo "==> 完成"
