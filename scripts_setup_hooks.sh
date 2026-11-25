#!/usr/bin/env bash
# 克隆后执行一次：启用仓库自带的 git 钩子
set -e
cd "$(dirname "$0")"
git config core.hooksPath .githooks
chmod +x .githooks/pre-push
echo "已启用钩子：.githooks（禁止直接 push main/master）"
