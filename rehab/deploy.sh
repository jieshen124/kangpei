#!/usr/bin/env bash
set -euo pipefail

KEY="${KEY:-$HOME/.ssh/deploy_site}"
HOST="${HOST:-root@103.236.73.76}"
PORT="${PORT:-40851}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> 语法检查"
node --check "$DIR/server.js"
find "$DIR/src" -name '*.js' -print0 | xargs -0 -n1 node --check
echo "    server.js + src 全部通过"

echo "==> 上传代码"
scp -i "$KEY" -P "$PORT" "$DIR/server.js" "$DIR/package.json" "$HOST:/opt/rehab/"
scp -i "$KEY" -P "$PORT" "$DIR/public/index.html" "$HOST:/opt/rehab/public/index.html"
tar -C "$DIR" -czf - src | ssh -i "$KEY" -p "$PORT" "$HOST" 'tar -C /opt/rehab -xzf -'

if [ -f "$DIR/docs/index.html" ]; then
  echo "==> 上传审阅稿"
  ssh -i "$KEY" -p "$PORT" "$HOST" 'mkdir -p /opt/rehab/docs'
  scp -i "$KEY" -P "$PORT" "$DIR"/docs/review-v*.pdf "$DIR"/docs/review-v*.docx "$DIR/docs/index.html" "$HOST:/opt/rehab/docs/"
fi

echo "==> 安装依赖"
ssh -i "$KEY" -p "$PORT" "$HOST" 'cd /opt/rehab && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2'

echo "==> 重启服务"
ssh -i "$KEY" -p "$PORT" "$HOST" 'chown -R rehab:rehab /opt/rehab
systemctl restart rehab
sleep 2
systemctl is-active rehab
cp /opt/rehab/server.js /root/rehab-src/server.js 2>/dev/null || true
cp /opt/rehab/public/index.html /root/rehab-src/public/index.html 2>/dev/null || true
rm -rf /root/rehab-src/src && cp -r /opt/rehab/src /root/rehab-src/src 2>/dev/null || true'

echo "==> 完成"
