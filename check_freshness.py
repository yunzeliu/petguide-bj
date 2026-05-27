"""
For each POI lacking a `freshness` field, ask Gemini grounded search:
  "近 6 个月有没有网友提到 <POI 名> 还能带狗 / 营业 / 政策有变？"

Output structured:
  { status: "open"|"unclear"|"closed"|"policy_changed",
    latest_mention: "2024-12 / 2025-03 / ...",
    note: "<= 80 字",
    sources: [{name, url}]
  }

Writes back into web/data/pois.json under `freshness` key.
Idempotent: only checks POIs without a freshness field.

Cost estimate: 132 POI * gemini-2.5-flash grounded ≈ ¥3-5.
Concurrency 4 to be polite to Gemini and Google search.
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API_KEY = os.environ.get("GEMINI_API_KEY", "AIzaSyAh8I-OiV9q0EoOAt7J9mN39ENipswDUFQ")
MODEL = "gemini-2.5-flash"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.join(HERE, "data", "pois.json")


def prompt_for(p):
    return f"""用 Google 搜索查证下面这个宠物友好地点近 6 个月的最新情况：

地点：{p.get('name')}
所在：{p.get('city_name','')}{p.get('district','')}区
原本特点：{p.get('why_friendly','')}

输出严格要求：
- 第一个字符必须是 {{
- 只输出一个 JSON 对象
- 不要 markdown 代码块、不要解释、不要重复输出
- note 严格 ≤ 60 字

JSON 结构：
{{"status":"open|unclear|closed|policy_changed","latest_mention":"YYYY-MM或空","note":"≤60字","sources":[{{"name":"...","url":"..."}}]}}

status 取值：
- open: 仍正常营业且对宠物友好
- policy_changed: 营业但宠物政策变更
- closed: 已关停或完全禁宠
- unclear: 6 个月内没找到明确信息
"""


def call_gemini(prompt, retries=2):
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and i < retries:
                time.sleep(10 * (i + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}: {e.read()[:200]}")
        except urllib.error.URLError as e:
            if i < retries:
                time.sleep(5)
                continue
            raise
    return None


def parse_json(text):
    """Extract the first complete top-level JSON object, tolerating Gemini's
    habit of emitting the object twice or wrapping in markdown."""
    if not text:
        return None
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"```\s*$", "", s)

    start = s.find("{")
    if start < 0:
        return None

    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    chunk = s[start:i+1]
                    try:
                        return json.loads(chunk)
                    except json.JSONDecodeError:
                        return None
    return None


def process(pid_p):
    pid, p = pid_p
    if "freshness" in p:
        return {"pid": pid, "skip": True}
    try:
        resp = call_gemini(prompt_for(p))
    except Exception as e:
        return {"pid": pid, "ok": False, "error": str(e)[:120]}

    cand = (resp.get("candidates") or [{}])[0]
    content = cand.get("content") or {}
    parts = content.get("parts") or []
    text = "".join(part.get("text", "") for part in parts if "text" in part)
    obj = parse_json(text)
    if not obj or "status" not in obj:
        return {"pid": pid, "ok": False, "error": "json parse failed"}

    obj["checked_at"] = time.strftime("%Y-%m-%d")
    return {"pid": pid, "ok": True, "freshness": obj}


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    todo = [(pid, p) for pid, p in pois.items() if "freshness" not in p]
    print(f"to check: {len(todo)} / total {len(pois)}", flush=True)

    completed = 0
    fail = 0
    status_count = {}
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(process, todo):
            if r.get("skip"):
                continue
            if r.get("ok"):
                pois[r["pid"]]["freshness"] = r["freshness"]
                completed += 1
                s = r["freshness"].get("status", "?")
                status_count[s] = status_count.get(s, 0) + 1
                name = pois[r["pid"]].get("name", "?")[:24]
                print(f"  [{completed}] {name:24} | {s} | {r['freshness'].get('latest_mention','-')}", flush=True)
            else:
                fail += 1
                print(f"  FAIL {r.get('pid')}: {r.get('error')}", flush=True)

            if (completed + fail) % 15 == 0:
                with open(POIS_PATH, "w", encoding="utf-8") as f:
                    json.dump(pois, f, ensure_ascii=False, indent=1)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n=== done ===")
    print(f"ok={completed} fail={fail}")
    print(f"status counts: {status_count}")


if __name__ == "__main__":
    main()
