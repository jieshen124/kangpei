#!/usr/bin/env bash
# 部署康复师实时预约系统
# 用法：sudo bash install.sh /root/rehab-src
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
APP_DIR="/opt/rehab"
DATA_DIR="/var/lib/rehab"

echo "==> [1/7] 检查 Node"
command -v node >/dev/null 2>&1 || { echo "需要先安装 nodejs"; exit 1; }
node -v

echo "==> [2/7] 创建运行用户 rehab"
id rehab >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" rehab

echo "==> [3/7] 安装应用文件"
mkdir -p "$APP_DIR/public" "$DATA_DIR"
install -m 644 "$SRC_DIR/server.js" "$APP_DIR/server.js"
install -m 644 "$SRC_DIR/public/index.html" "$APP_DIR/public/index.html"

echo "==> [4/7] 安装依赖 ws"
cd "$APP_DIR"
[ -f package.json ] || npm init -y >/dev/null 2>&1
npm install ws --omit=dev --no-audit --no-fund 2>&1 | tail -1

echo "==> [5/7] 权限"
chown -R rehab:rehab "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> [6/7] systemd"
install -m 644 "$SRC_DIR/rehab.service" /etc/systemd/system/rehab.service
systemctl daemon-reload
systemctl enable rehab >/dev/null 2>&1
systemctl restart rehab
sleep 2
systemctl is-active rehab

echo "==> [7/7] nginx"
install -m 644 "$SRC_DIR/site.conf" /etc/nginx/sites-available/site.conf
ln -sfn /etc/nginx/sites-available/site.conf /etc/nginx/sites-enabled/site.conf
nginx -t
systemctl reload nginx

echo "==> 自检"
curl -s -o /dev/null -w "    直连 3001/meta   -> HTTP %{http_code}\n" http://127.0.0.1:3001/rehab/meta
curl -s -o /dev/null -w "    nginx /rehab/    -> HTTP %{http_code}\n" http://127.0.0.1/rehab/
curl -s -o /dev/null -w "    聊天室未受影响    -> HTTP %{http_code}\n" http://127.0.0.1/
echo "==> 完成：http://<公网>:端口/rehab/"
