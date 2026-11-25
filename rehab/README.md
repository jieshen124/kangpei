# 康陪服务端（rehab）

居家康复陪练与监督平台的服务端。定位是非医疗的陪伴与记录，不做诊断、不做治疗、不开处方。

## 目录结构

```
server.js                  # 入口：HTTP 分发 + 业务 handler（下一步再逐步拆到 modules/）
src/
  config.js                # 端口、路径、会话时长、测试模式等配置
  routes.js                # 路由权限清单（一处声明，中间件统一执行）
  lib/http.js              # JSON 响应、请求体解析、Cookie 解析
  middleware/access.js     # 患者数据可见性（canViewPatient 唯一出口）
  data/
    catalog.js             # 区域、时段、量表工具箱、70 项病种目录、主诉选项
    flows.js               # 8 套陪练流程、共用步骤、异常卡、步序推导
    courses.js             # 监督者培训课程与考题
  db/
    schema.sql             # 表结构
    index.js               # 打开数据库、事务包装
    repo.js                # 读写与历史数据导入
test/framework.test.js     # 框架级测试（流程/鉴权/可见性/预约状态机/落库）
```

## 数据存储

SQLite 单文件：默认 `/var/lib/rehab/rehab.db`（可用 `DB_FILE` 覆盖）。

设计取舍：业务对象的完整结构仍以 JSON 存在 `data` 列，关键字段（患者、监督者、状态、时间）单列建索引。
第一步先解决"多进程写 JSON 文件会丢数据、没有事务、没有索引"的问题；等接口稳定后再逐步拆字段。
写入带"内容未变就跳过"的比对：实测全量写 109ms，而单条变更 8ms、无变化 2ms。
历史 JSON 文件在首次启动时自动导入（`meta.legacy_imported` 标记防止重复），原文件保留作备份、不再写入。

## 鉴权模型

两层：

1. **路由清单**（`src/routes.js`）：`/api/` 下未登记路径直接 404，未登录 401，角色不符 403。默认拒绝。
2. **资源归属**（handler 内）：这条预约是不是你的、这个患者你能不能看。

患者数据可见性统一走 `src/middleware/access.js`：

- 本人、管理员：可以看
- 家属：只能看 `linkedPatient`
- 监督者：**必须与该患者有业务关系**（有未取消的预约，或执行过陪练流程）
- 其他人：拒绝

## 本地运行与测试

```bash
cd rehab
npm install
npm test                 # 8 个框架级测试
DATA_DIR=/tmp/rehab-dev DB_FILE=/tmp/rehab-dev/rehab.db PORT=3999 node server.js
```

## 部署

```bash
bash rehab/deploy.sh
```

脚本会：语法检查（server.js 与 src 全部）→ 上传代码 → 在服务器上 `npm install` → 重启 `rehab.service` → 同步一份到 `/root/rehab-src`。

## 已知限制（下一步）

- handler 仍集中在 `server.js`，可以按 `booking / flow / scale / report / training / admin` 继续拆模块
- 会话存在内存里，重启后所有人需要重新登录（可考虑落库）
- 生产环境仍是 HTTP，没有域名与 TLS
- `TEST_MODE` 默认开启（免登录 + 一键认证），正式启用前要设 `TEST_MODE=0`
