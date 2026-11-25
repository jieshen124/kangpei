# 开发流程

主干分支是 `main`（等同于 master），**只接受通过 Pull Request 的合并**，不直接 push。

## 一次改动的完整流程

```bash
git checkout main && git pull          # 先同步
git checkout -b feat/supervisor-perm   # 切新分支，命名见下
# ...改代码...
npm --prefix rehab install ws          # 首次；本地跑一遍
PORT=3900 DATA_DIR=./data node rehab/server.js
git add -A
git commit -m "收紧监督者查看患者报告的权限"
git push -u origin feat/supervisor-perm
```

然后在 GitHub 上开 PR → 自己 review 一遍 → Merge。

## 分支命名

| 前缀 | 用途 |
|---|---|
| `feat/` | 新功能 |
| `fix/` | 修缺陷 |
| `docs/` | 文档、审阅稿 |
| `chore/` | 依赖、脚本、配置 |
| `hotfix/` | 线上紧急修复 |

## 提交信息

一句话说清“改了什么”，必要时第二行写“为什么”。不要写“update”“修改”这种。

## 合并方式

用 **Squash merge**，让 `main` 的历史保持一条线一功能；需要保留中间提交时用 Merge commit。

## 部署

合并进 `main` 后不等于线上生效，还要部署：

```bash
./rehab/deploy.sh
```

## 钩子

仓库自带 `.githooks/pre-push`，会拦截直接推送 `main`。克隆后执行一次：

```bash
./scripts_setup_hooks.sh
```

绕过（仅在明确知道后果时）：

```bash
ALLOW_MAIN=1 git push origin main
```
