#!/usr/bin/env bash
# 一键推到 GitHub。第一次跑会问你 git 用户和远程仓库 URL，写入本目录的 git 配置。
# 之后每次跑都是：刷新数据 → commit → push → 显示 Pages URL。

set -euo pipefail
cd "$(dirname "$0")"

CYAN='\033[36m'; YELLOW='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; NC='\033[0m'

step() { echo -e "${CYAN}▸ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠ $*${NC}"; }
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
err()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

# ---------- 0. 确认 git 在 ----------
command -v git >/dev/null || err "缺 git，请先 apt/brew install git"

# ---------- 1. 同步数据（如果 build_data.py 在 + miniprogram-petguide 在） ----------
if [ -f build_data.py ] && [ -d ../miniprogram-petguide ]; then
  step "同步路书数据 (build_data.py)"
  python3 build_data.py
fi

# 顺手刷新 POI 经纬度 (geocode_pois.py 是幂等的，跑过就跳过)
if [ -f geocode_pois.py ]; then
  if [ -f data/pois.json ] && ! grep -q '"lat"' data/pois.json; then
    warn "首次跑 geocode_pois.py，会花约 3 分钟"
    python3 geocode_pois.py || warn "geocode 失败，跳过（地图页可能不准）"
  fi
fi

# ---------- 2. 初始化 git 仓库（如未初始化） ----------
if [ ! -d .git ]; then
  step "初始化 git 仓库"
  git init -q -b main

  # commit identity（仅本仓库，不污染全局）
  if ! git config user.email >/dev/null 2>&1; then
    read -rp "Git 邮箱 (用于 commit author): " GIT_EMAIL
    read -rp "Git 用户名: " GIT_NAME
    git config user.email "$GIT_EMAIL"
    git config user.name "$GIT_NAME"
  fi
fi

# ---------- 3. 确认远程仓库 ----------
if ! git remote get-url origin >/dev/null 2>&1; then
  echo
  warn "没设 origin 远程。先去 https://github.com/new 建一个公开仓库（不勾 README），名字建议 petguide-bj"
  read -rp "粘贴 git URL (如 git@github.com:youruser/petguide-bj.git): " REMOTE
  [ -n "$REMOTE" ] || err "URL 不能为空"
  git remote add origin "$REMOTE"
fi

REMOTE_URL=$(git remote get-url origin)
ok "remote: $REMOTE_URL"

# ---------- 3.5. 自动填 OG meta 里的域名 ----------
USER_REPO=$(echo "$REMOTE_URL" | sed -E 's#.*github.com[:/]([^/]+)/([^/]+?)(\.git)?$#\1/\2#')
USER=${USER_REPO%/*}
REPO=${USER_REPO#*/}
DEFAULT_DOMAIN="${USER}.github.io/${REPO}"

# 如果有 .deploy-url 文件，用里面的；否则用默认 + 询问一次
if [ -f .deploy-url ]; then
  DOMAIN=$(cat .deploy-url)
else
  echo
  echo "OG 分享卡片需要绝对域名。默认: ${DEFAULT_DOMAIN}"
  read -rp "如果用自定义域名（如 wangxing.cn）请输入，否则直接回车: " CUSTOM
  DOMAIN=${CUSTOM:-$DEFAULT_DOMAIN}
  echo "$DOMAIN" > .deploy-url
  ok "已记下域名: $DOMAIN（写在 .deploy-url 里，下次自动用）"
fi

# 用 sed 把占位符换成真实域名（在 index.html 副本上操作）
if grep -q "TODO_REPLACE_DOMAIN" index.html; then
  step "替换 index.html 中的 OG 域名"
  sed -i.bak "s|TODO_REPLACE_DOMAIN|${DOMAIN}|g" index.html && rm -f index.html.bak
fi

# ---------- 4. add / commit / push ----------
step "暂存改动"
git add -A

if git diff --cached --quiet; then
  warn "没有改动，直接 push"
else
  read -rp "Commit 信息 [默认 'content: refresh']: " MSG
  MSG=${MSG:-content: refresh}
  git commit -m "$MSG" -q
  ok "已提交"
fi

step "推送到 origin/main"
if git push -u origin main 2>&1 | grep -q 'rejected'; then
  warn "push 被拒，可能远程有内容。pull --rebase 后重试"
  git pull --rebase origin main
  git push -u origin main
fi
ok "已推送"

# ---------- 5. 解析 Pages URL ----------
USER_REPO=$(echo "$REMOTE_URL" | sed -E 's#.*github.com[:/]([^/]+)/([^/]+?)(\.git)?$#\1/\2#')
USER=${USER_REPO%/*}
REPO=${USER_REPO#*/}
PAGES_URL="https://${USER}.github.io/${REPO}/"

echo
ok "推送完成"
echo
echo "👉 下一步（只做一次）："
echo "   1. 浏览器打开: https://github.com/${USER}/${REPO}/settings/pages"
echo "   2. Source: Deploy from a branch"
echo "   3. Branch: main / (root) → Save"
echo "   4. 等 1-2 分钟，访问: ${PAGES_URL}"
echo
echo "之后只要 ./deploy.sh 一句就能更新内容。"
