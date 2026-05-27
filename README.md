# 汪行 · 北京宠物友好周末路书（网页版）

纯静态 SPA，可直接部署到 GitHub Pages / Vercel / Netlify / 任何静态托管。

- 30 篇北京宠物友好周末路书
- 132 个真实地点（公园 / 餐厅 / 民宿 / 营地等）
- 每条信息附原始网络来源
- 浏览器直连 Gemini 的个性化定制（用户自带 API key）

## 本地预览

```sh
cd web
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

不需要 npm install，不需要构建，刷新即看。

## 部署到 GitHub Pages

### 一键脚本（推荐）

```sh
cd web
./deploy.sh
```

第一次跑会问你 git 邮箱、用户名、GitHub 仓库 URL，之后自动 add/commit/push。脚本还会：
- 自动把 `index.html` 里 OG meta 的 `TODO_REPLACE_DOMAIN` 替换成你的 Pages 域名（写在 `.deploy-url`，下次自动用）
- 如果没跑过 geocoding 还会先帮你跑

然后去 `https://github.com/<user>/<repo>/settings/pages` 把 Source 设为 main 分支即可。

### 或者手动 3 步

1. **新建 GitHub 仓库**（公开仓库可免费用 Pages）
2. 复制 `web/` 内容到仓库根目录 → push
3. 仓库 → Settings → Pages → Source: Deploy from a branch → Branch: `main` → Save

> `.nojekyll` 防止 GitHub 把 `_` 开头文件忽略 · `.github/workflows/pages.yml` 已配好自动部署，推 main 后 1 分钟上线。

## 部署到 Vercel / Netlify

把仓库连过去，Build command 留空，Output directory 填仓库根。1 分钟上线。

## 个性化定制功能

调用 Gemini API，需要用户在 [Google AI Studio](https://aistudio.google.com/apikey) 免费申请 key，粘到站内"定制"页面里。

**key 只保存在用户浏览器的 localStorage**，不上传任何服务器（本站没有后端，整个就是几个静态文件）。

如果你想集中托管 key（让访客无门槛使用），可以加一层 [Cloudflare Workers](https://workers.cloudflare.com/) 或 Vercel Edge Functions 当代理，把 key 放在环境变量。但那就不是纯静态了。

## 地图页 (#/map)

132 个 POI 全部带 WGS-84 经纬度，已通过 [Photon](https://photon.komoot.io) 一次性 geocoded（精确 104，模糊到区中心 28）。地图基于 [Leaflet](https://leafletjs.com) + CartoDB Voyager tile，支持按类别 / 区域筛选。

重新 geocode：
```sh
python3 geocode_pois.py    # 幂等：只跑 lat/lng 缺失的
```

## 分享卡片 (OG meta)

[`assets/og-cover.jpg`](assets/og-cover.jpg) 是 1200x630 的分享缩略图，已写入 og:image 和 twitter:image。

`index.html` 里有 `TODO_REPLACE_DOMAIN` 占位符，`deploy.sh` 第一次跑会问域名并自动替换。微信发链接、Facebook、Twitter、Slack 都会显示卡片。

微信生态特别注意：微信群分享是 `<meta itemprop>` 优先（已写），朋友圈 / 公众号引用看 `og:image`。

## 访问统计

默认未启用，要开就编辑 [`js/config.js`](js/config.js)：

**Umami Cloud（推荐，10k 事件/月免费）**：
1. 注册 https://cloud.umami.is
2. 新建网站 → 复制 Website ID
3. 填到 `config.js` 的 `umami.websiteId`

**GoatCounter（更轻量，3 个域名免费）**：
1. 注册 https://goatcounter.com
2. 拿到一个 code（比如 `yourname`）
3. 填到 `config.js` 的 `goatCounter.code`

两者填一个就行。不填则站点完全无统计、不发送任何第三方请求。

## 内容更新流程

```sh
# 在 ../miniprogram-petguide/ 里跑 Gemini 重新生成
cd ../miniprogram-petguide
python3 scripts/batch_generate.py             # 全量
python3 scripts/batch_generate.py spring-flower  # 单篇增量

# 把数据同步到 web/data/
cd ../web
python3 build_data.py

# 提交即上线
git add data/
git commit -m "content: refresh routes"
git push
```

## 目录结构

```
web/
├── index.html             # SPA 壳 + OG meta + PWA manifest 引用
├── manifest.json          # PWA 清单
├── sw.js                  # Service worker（离线缓存 + 自动更新提示）
├── css/style.css          # 设计系统 + Leaflet 主题覆盖
├── js/
│   ├── app.js             # 主体应用（路由 / 渲染 / Gemini / 地图 / 热力）
│   └── config.js          # 站点配置（统计 ID、Gemini 代理、联系方式）
├── assets/
│   ├── logo.svg
│   ├── og-cover.jpg       # 1200x630 分享卡片
│   ├── icon-192.png       # PWA 图标
│   ├── icon-512.png
│   ├── icon-maskable-512.png
│   └── apple-touch-icon.png
├── data/
│   ├── cities.json        # [{key,name,count}] 城市清单
│   ├── routes.json        # 全部城市路书元数据
│   ├── pois.json          # 全部 POI（含 lat/lng、freshness）
│   └── routes/            # markdown 正文
├── cf-worker/
│   ├── gemini-proxy.js    # Cloudflare Worker 代码（代理 Gemini）
│   └── wrangler.toml
├── docs/
│   └── CUSTOM_DOMAIN.md   # 自定义域名 + DNS 教程
├── build_data.py          # 多城市数据聚合
├── geocode_pois.py        # Photon geocode POI 经纬度（幂等）
├── check_freshness.py     # Gemini grounded 检查 POI 是否还在营
├── deploy.sh              # 一键 GitHub push + OG 域名自动填
├── CNAME.example          # 自定义域名模板（rename to CNAME）
├── .github/workflows/pages.yml  # 自动部署
├── .nojekyll
└── README.md
```

## 路由

| 路径 | 页面 |
|---|---|
| `#/` | 发现 / 首页 feed（带筛选 + 城市切换） |
| `#/map` | 地图（POI 散点 / 热力图切换，按类别/区域筛选） |
| `#/route/<slug>` | 路书详情 |
| `#/poi/<id>` | 单地点详情（含 freshness 状态） |
| `#/search?q=...` | 搜索 |
| `#/personalize` | AI 定制（站点配代理就无门槛，否则自带 key） |
| `#/favs` | 我的收藏 |
| `#/about` | 关于 |

## 进阶能力

### PWA（手机可"加到主屏幕"）
[`manifest.json`](manifest.json) + [`sw.js`](sw.js) 实现：
- 首次访问后所有资源会被 Service Worker 缓存，**断网也能浏览已访问过的路书**
- 内容更新时弹"刷新"提示，用户点一下即可拿到新版本
- 移动端浏览器会弹"安装"提示，加到主屏后是独立 App 体验
- iOS Safari "添加到主屏幕"也能识别

### 热力图（地图页）
点 `#/map` 上方的 "🔥 热力" 切到热力图模式，能一眼看出宠物友好密度集中区域。

### 多城市
内置 北京 / 上海 / 杭州 三套数据，首页顶部有城市切换 tab。要加新城市：

```sh
cd ../miniprogram-petguide
python3 scripts/generate_city.py shanghai     # 已有
python3 scripts/generate_city.py chengdu      # 改 generate_city.py 的 CITIES dict 添加
```

聚合数据：
```sh
cd ../web
python3 build_data.py          # 重新生成 routes.json/pois.json/cities.json
python3 geocode_pois.py        # 给新 POI 补经纬度
python3 check_freshness.py     # 给新 POI 补 freshness（可选）
```

### Freshness 状态
[`check_freshness.py`](check_freshness.py) 调用 Gemini grounded search，给每个 POI 标注：
- **✓ 最近确认在营** (open)
- **⚠️ 政策有变** (policy_changed) — 例如禁宠 / 涨价 / 只允许小型犬
- **✕ 可能已关停** (closed)
- **? 信息较旧** (unclear) — 6 个月内没找到证据

POI 卡片和详情页都会显示这个 pill，提升信息可信度。建议每月跑一次：
```sh
python3 check_freshness.py
```
（脚本是幂等的，已有 freshness 的不会重查；想强制全量重查就清空 pois.json 里 `freshness` 字段）

### Gemini 代理（让访客无需自带 key）

部署 [cf-worker/gemini-proxy.js](cf-worker/gemini-proxy.js) 到 Cloudflare Workers（免费 100k 次/天）：

1. 注册 Cloudflare → Workers → 新建 → 粘贴代码 → Deploy
2. Settings → Variables：
   - Secret `GEMINI_API_KEY` = 你的 key
   - Variable `ALLOWED_ORIGINS` = `https://你的.github.io,https://你的域名.com`
3. 拿到 worker URL（如 `https://gemini-proxy.your-sub.workers.dev`）
4. 编辑 [`js/config.js`](js/config.js) 的 `geminiProxy.url` 填进去

之后访客打开"定制"页直接能用，不需要自己申请 key。

### 自定义域名
见 [docs/CUSTOM_DOMAIN.md](docs/CUSTOM_DOMAIN.md)。

### 访问统计
默认未启用。编辑 [`js/config.js`](js/config.js) 填 Umami Cloud（10k/月免费）或 GoatCounter（3 个域名免费）的 ID。

## 依赖（全部 CDN 引用，无 npm 无构建）

- [marked@12](https://github.com/markedjs/marked) — markdown 渲染，~16KB
- [leaflet@1.9](https://leafletjs.com) — 地图引擎，~42KB
- [leaflet.heat@0.2](https://github.com/Leaflet/Leaflet.heat) — 热力图层，~3KB
- 地图瓦片：CartoDB Voyager（OpenStreetMap-based，免费）

总额外加载 < 70KB，首屏 + 数据 < 300KB。
