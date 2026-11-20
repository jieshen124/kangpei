# 康陪 · 居家康复监督平台

面向居家场景的康复陪伴与训练监督平台。患者线上预约，陪练人员（监督者）上门按固定流程陪练、记录量表，家属可查看进度。

平台定位为**非医疗**：不诊断、不解读检查报告、不调整医嘱、不做疗效承诺；发现异常只做识别、记录与转介。

## 线上地址

| 入口 | 地址 |
|---|---|
| 康复系统 | http://103.236.73.76:29250/rehab/ |
| 临床审阅稿 | http://103.236.73.76:29250/rehab/docs/ |
| 聊天室（早期原型） | http://103.236.73.76:29250/ |

公网入口只有一条 NAT 转发：`103.236.73.76:29250` → 内网 `80`。

## 目录结构

```
rehab/
├── server.js            # 服务端全集（Node 原生 http + ws），监听 127.0.0.1:3001
├── public/index.html    # 单页前端（约 133KB，含样式与脚本）
├── docs/                # 临床审阅稿（页面 + PDF + Word）
├── demo/                # 培训模块示范视频
├── rehab.service        # systemd 单元（User=rehab）
├── site.conf            # nginx 站点配置（服务器上的为准，本地为副本）
├── install.sh           # 首次部署脚本
├── deploy.sh            # 日常部署：传代码 + 重启
└── make_review_doc.py   # 生成临床审阅稿 Word 的脚本
site/                    # 早期静态站源稿
chat/                    # 聊天室源码
```

线上代码在 `/opt/rehab`，数据在 `/var/lib/rehab`（不进仓库）。

## 功能模块

- 账号与角色：患者 / 家属 / 监督者 / 管理员
- 预约：区域、时段、监督者选择；填写病种、主诉（最想解决的问题）、诊断报告上传
- 病种目录：70 项，分 7 组，前端支持关键词筛选
- 流程引擎：8 套流程（Brunnstrom 四期、骨科术后、心肺、神经非偏瘫、通用），按病种自动选择
- 流程执行：逐步推进、乱序拦截、跳过需填原因、异常指引卡（9 类）、结束时填量表
- 量表与预警：疼痛、完成度、肌力、疲劳；异常值触发提醒
- 培训：课程视频上传、观看进度、认证
- 审阅稿：`/rehab/docs/` 提供 PDF 在线阅读与 Word 下载

## 本地运行

```bash
cd rehab
npm install ws          # server.js 依赖 ws
PORT=3001 DATA_DIR=./data node server.js
# 打开 http://127.0.0.1:3001/rehab/
```

测试模式下可用 `POST /rehab/api/dev-login`（body `{"role":"patient"}`）直接登录。

## 部署

```bash
cd rehab
./deploy.sh            # scp server.js + public/index.html 到 /opt/rehab，然后重启 rehab 服务
```

部署前务必 `node --check server.js`。

服务器：

```
ssh -i ~/.ssh/deploy_site -p 40851 root@103.236.73.76
systemctl status rehab
journalctl -u rehab -f
```

## 版本

- v0.9（2026-11-20）：病种扩至 70 项，通用流程拆为骨科术后 / 心肺 / 神经三套，新增临床审阅稿与文档页。
