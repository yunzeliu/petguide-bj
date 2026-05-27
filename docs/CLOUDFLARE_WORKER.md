# 部署 Cloudflare Worker 代理（5 分钟）

目标：让"定制路书"功能在浏览器调 Gemini 时，把你的 API key 藏在 Cloudflare 服务端，不被任何人爬走。

## 0. 你需要

- 一个 Cloudflare 账号（[免费注册](https://dash.cloudflare.com/sign-up)，邮箱+密码就行）
- 一个 Gemini API key（已有的那个）
- 5 分钟

## 1. 创建 Worker

1. 登录 https://dash.cloudflare.com
2. 左侧菜单 → **Workers & Pages** → **Create application** → **Create Worker**
3. 给 Worker 起个名字：`petguide-gemini`（或者任何）
4. 点 **Deploy** —— 默认会生成一个 "Hello World" Worker，先 deploy 占位
5. Deploy 完会跳到 Worker 详情页

## 2. 粘贴代码

1. 详情页点 **Edit code** 进编辑器
2. **全选删除**默认那段 hello world
3. 打开本仓库 [`cf-worker/gemini-proxy.js`](../cf-worker/gemini-proxy.js)，**全部内容复制粘贴**进编辑器
4. 右上角 **Save and deploy** → 弹框确认 → 等几秒部署

## 3. 配置环境变量 + 密钥

回到 Worker 详情页 → **Settings** → **Variables and Secrets**：

### 3.1 加 Secret：`GEMINI_API_KEY`
1. 点 **Add** → 选 **Secret**
2. Name: `GEMINI_API_KEY`
3. Value: 粘贴你的 Gemini key（`AIza...`）
4. Save

### 3.2 加 Plain text：`ALLOWED_ORIGINS`
1. 点 **Add** → 选 **Text**（默认就是）
2. Name: `ALLOWED_ORIGINS`
3. Value: `https://yunzeliu.github.io`
   - 如果以后用了自定义域名，改成 `https://yunzeliu.github.io,https://wangxing.cn` 这种逗号分隔
4. Save

两个变量都加好后，Worker 会自动重新部署（5 秒）。

## 4. 拿到 Worker URL

Worker 详情页顶部会显示一个 URL，形如：
```
https://petguide-gemini.<你的子域>.workers.dev
```

完整复制下来。

## 5. 测试 Worker 是否在线

在浏览器或终端访问：
```
https://petguide-gemini.<你的子域>.workers.dev/health
```

应该看到：
```json
{"ok":true,"service":"gemini-proxy","has_key":true}
```

如果 `has_key: false`，说明 Secret 没设好，回到 Step 3.1 重做。

## 6. 把 Worker URL 接到网站

把上面那个 URL 发给我，我帮你填到 [`js/config.js`](../js/config.js) 的 `geminiProxy.url` 字段并 push 到 GitHub Pages。

或者你自己改也行：

```js
// js/config.js
geminiProxy: {
  url: 'https://petguide-gemini.你的子域.workers.dev',
},
```

然后 `cd web && ./deploy.sh` 推上去。

## 推完之后

打开 https://yunzeliu.github.io/petguide-bj/#/personalize ：
- 看不到"功能升级中"提示了
- 填表 → 点"生成路书" → ~20 秒出结果
- 浏览器 F12 → Network 看请求，发到的是 `*.workers.dev`，**没有你的 Gemini key**

## 成本

- Cloudflare Workers 免费层：**100,000 次/天**，按目前流量绝对够用
- Gemini API：免费层每天 1500 次 gemini-2.5-flash 调用；超出后按 token 计费，单次定制 ≈ ¥0.02-0.05
- 想给 worker 设个保险，可以在 Worker → Settings → 加 Rate Limiting（也免费）

## 想撤就撤

- 把 `js/config.js` 的 `geminiProxy.url` 改回空字符串 → push → 定制功能立即停用
- 或在 CF 仪表盘把 Worker 删了/禁用

## 想看流量

CF 仪表盘 Worker 详情页 **Metrics** 标签会显示每天请求数、错误率、CPU 时间，免费层都能看。

## 自定义域名（可选）

如果不想用 `*.workers.dev`：
- Worker → Triggers → Add Custom Domain → 输入 `api.wangxing.cn`
- CF 会自动建一条 CNAME，零配置
- 然后 ALLOWED_ORIGINS 和前端 config.js 都用新域名

---

部署遇到任何问题贴报错截图，我帮你看。
