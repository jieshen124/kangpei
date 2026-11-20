# 静态站点源码

这是部署在 `/var/www/site` 的页面源稿，放在 `/root/site-src` 方便你直接编辑和重新部署。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 首页 |
| `style.css` | 样式（通过 `/style.css` 引用） |
| `404.html` | 自定义 404 页 |
| `site.conf` | nginx 站点配置，部署时复制到 `/etc/nginx/sites-available/site.conf` |
| `deploy.sh` | 幂等部署脚本，`bash deploy.sh /root/site-src` 即可重新部署 |

## 改页面的流程

```bash
# 1. 改文件
vim /root/site-src/index.html

# 2. 推到站点目录（html 不做缓存，改完刷新即可）
install -m 644 /root/site-src/index.html /var/www/site/index.html

# 只有改了 site.conf 才需要下面两步
nginx -t && systemctl reload nginx
```

## 从本地推送

```bash
scp -P 40851 -r ./site root@103.236.73.76:/root/site-src
```

## 当前运行状态

- 站点根目录：`/var/www/site`
- 监听：80（`ss -tln | grep :80`）
- 日志：`/var/log/nginx/site.access.log`、`site.error.log`
- 服务：`systemctl status nginx`
