#!/usr/bin/env bash
# 在目标机（Ubuntu 24.04）上部署 nginx 静态站点
# 用法：sudo bash deploy.sh /path/to/site-site
set -euo pipefail

SITE_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
WEB_ROOT="/var/www/site"
CONF="/etc/nginx/sites-available/site.conf"

echo "==> [1/6] 安装 nginx"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx >/dev/null
else
  echo "    已安装，跳过"
fi
nginx -v

echo "==> [2/6] 准备站点目录 $WEB_ROOT"
mkdir -p "$WEB_ROOT"
# 备份旧 index，方便回滚
if [ -f "$WEB_ROOT/index.html" ]; then
  cp "$WEB_ROOT/index.html" "$WEB_ROOT/index.html.bak.$(date +%Y%m%d%H%M%S)"
fi

echo "==> [3/6] 拷贝站点文件"
for f in index.html style.css 404.html; do
  if [ -f "$SITE_DIR/$f" ]; then
    install -m 644 "$SITE_DIR/$f" "$WEB_ROOT/$f"
    echo "    $f"
  fi
done

echo "==> [4/6] 写入 nginx 配置"
install -m 644 "$SITE_DIR/site.conf" "$CONF"
ln -sfn "$CONF" /etc/nginx/sites-enabled/site.conf

# 移除默认站点，避免 default_server 冲突
if [ -L /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "    已移除默认站点"
fi

echo "==> [5/6] 校验并启动"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

# ufw 如果在运行，放行 80
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  echo "    ufw 已放行 80"
fi

echo "==> [6/6] 自检"
sleep 1
systemctl is-active nginx
curl -s -o /dev/null -w "    localhost:80 -> HTTP %{http_code}\n" http://127.0.0.1/
echo "    站点根目录：$WEB_ROOT"
echo "    配置文件：  $CONF"
echo "==> 完成。浏览器访问 http://<公网IP>/"
