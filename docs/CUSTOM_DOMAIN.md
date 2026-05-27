# 自定义域名（GitHub Pages）

## 1. 买域名

国内：阿里云 / 腾讯云 / Namecheap / Cloudflare Registrar（最便宜，但需国际信用卡）。

`.com` 通常 ¥60-80/年；`.cn` 需要实名 + ICP 备案才能解析国内服务器，但 **GitHub Pages 在境外服务器，所以国际域名只买**。

## 2. 给仓库加 CNAME 文件

把 `CNAME.example` 重命名成 `CNAME`，里面只写一行你的域名（不带 `https://`）：

```
wangxing.example.com
```

提交并 push 后 GitHub Pages 会在 Settings → Pages 里自动识别。

```sh
cd web
mv CNAME.example CNAME
sed -i 's/wangxing.example.com/你的域名/' CNAME
./deploy.sh
```

## 3. DNS 解析

在域名 DNS 控制台加一条：

**裸域名（example.com）** → 加 4 条 A 记录指向 GitHub Pages：
```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

**子域名（www.example.com 或 wangxing.example.com）** → 加 1 条 CNAME 记录：
```
CNAME → <你的 GitHub 用户名>.github.io
```

## 4. 在 GitHub 启用 HTTPS

仓库 Settings → Pages → 勾上 "Enforce HTTPS"。需要等 24h DNS 全球传播 + GitHub 自动签 Let's Encrypt 证书。

## 5. 把 OG meta 的域名更新

`web/.deploy-url` 文件里改成新域名，下次 `./deploy.sh` 会自动把 `index.html` 里的 `og:image` 等 URL 更新成新域名。

```sh
echo "wangxing.example.com" > web/.deploy-url
./deploy.sh
```

## 常见坑

- **DNS 没传播**：用 [dnschecker.org](https://dnschecker.org) 查解析是否全球生效
- **HTTPS 一直是 cert 错误**：Pages 控制台勾掉 "Enforce HTTPS" → 等 5 分钟 → 再勾回来，触发重新签发
- **裸域名 + 子域名都想用**：CNAME 文件写裸域名，DNS 上再加一条 `www` 的 CNAME 到裸域名，GitHub 会自动 301 跳转
- **国内访问慢**：GitHub Pages 在国内偶有抽风，可考虑套一层 Cloudflare（免费，自动 CDN）— 在 Cloudflare 加站点 → DNS 用 CF 接管 → 速度会快很多
