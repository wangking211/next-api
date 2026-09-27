# Nginx 站点配置

本目录保存生产宿主机上 nginx 的站点配置，便于版本管理与审计。TLS 证书文件（`/etc/letsencrypt/`）由 Certbot 管理，不入库。

| 文件 | 安装位置 | 站点 |
| --- | --- | --- |
| `xiaopuyun.com.conf` | `/etc/nginx/conf.d/aigateway.conf` | `xiaopuyun.com` / `www.xiaopuyun.com` |

## 应用配置

```bash
sudo cp ops/nginx/xiaopuyun.com.conf /etc/nginx/conf.d/aigateway.conf
sudo nginx -t && sudo systemctl reload nginx
```

## 首次为新域名签发证书

Certbot 会自动改写该 server 块并插入证书相关行（`ssl_certificate`、`options-ssl`、`dhparam`）：

```bash
sudo certbot --nginx -d xiaopuyun.com -d www.xiaopuyun.com
```

> 说明：容器只监听回环地址，因此 nginx 把站点流量整体转发到 web 容器（`127.0.0.1:8081`），`/api/` 与 `/v1/` 由 web 容器内的 nginx 再转发到 api 容器（`apps/web/nginx.conf`）。
