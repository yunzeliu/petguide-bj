# 每日自动更新（GitHub Actions）

每天北京时间 **凌晨 02:00**，GitHub 上的 Actions 会自动跑：

1. 用 Gemini grounded search 查"近 30 天新开 / 热议"宠物地点（按周期轮换查询主题）
2. 复核所有距上次核验 ≥14 天的 POI
3. 自动 geocode 新地点
4. 过滤掉状态非 open 的
5. 自动 commit + push 到 main 分支
6. GitHub Pages 自动重新部署（约 1 分钟）

**完全无需你管。** 但有一个**一次性配置**：把 Gemini API key 加到仓库 Secrets。

## 一次性配置（30 秒）

打开 https://github.com/yunzeliu/petguide-bj/settings/secrets/actions ，新建两个 secrets：

**必需**
- `GEMINI_API_KEY` = 你的 Gemini key (`AIza...`)

完成。下次 18:00 UTC（北京 02:00）自动开始跑。

## 立即测试 / 手动触发

不想等到明天？可以手动跑一次：

1. https://github.com/yunzeliu/petguide-bj/actions/workflows/daily-update.yml
2. 右上 **Run workflow** → **Run workflow**
3. 5-15 分钟后看到一条新 commit

## 看跑了什么

每次跑完会有一条 commit，标题形如：
```
daily 2026-05-28: 60 verified routes / 178 verified POIs
```

点开 commit 看具体改了哪些 JSON / md 文件。

## 出错怎么办

- Actions 运行失败 → https://github.com/yunzeliu/petguide-bj/actions 看错误日志
- 常见原因：Gemini key 过期 / GEMINI_API_KEY secret 没设
- 不会影响线上：如果 daily update 失败，旧版数据仍然在线，下次成功再覆盖

## 调整频率 / 行为

编辑 [`.github/workflows/daily-update.yml`](../.github/workflows/daily-update.yml)：

- `cron: '0 18 * * *'` — 改成每天什么时候跑（UTC 时间，加 8 小时是北京时间）
- 想隔天跑改成 `cron: '0 18 */2 * *'`
- 想一周一次：`cron: '0 18 * * 0'`（每周日）

调整 [`scripts/daily_update.py`](../scripts/daily_update.py)：

- `RECHECK_DAYS = 14` — 多久重核一次每个 POI
- `MAX_PER_RUN = 80` — 每次最多 freshness check 多少 POI（避免烧 quota）
- `DISCOVERY_TEMPLATES` — 每天的发现主题模板

## 成本估算

每天一跑：
- 1 个新发现主题：~¥0.10（gemini-2.5-pro 一次调用）
- 80 个 POI 复核：~¥1.50（gemini-2.5-flash × 80）
- **每天约 ¥1.5-2，每月 ¥50-60**

如果想省钱：
- 改成隔天跑（成本 /2）
- 减少 `MAX_PER_RUN`（默认 80 已经很保守）
- 减少 `DISCOVERY_TEMPLATES` 频率，比如一周新发现一次
