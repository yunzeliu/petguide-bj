#!/usr/bin/env python3
"""
Enrich each POI with structured pet_features.

For each POI lacking `pet_features`, ask Gemini grounded search to extract
structured details about how this place handles pets:
  - access rules (indoor/outdoor, leash, diaper, vaccination)
  - size limits (max shoulder height, large dog OK, banned breeds)
  - facilities (grass, fence, pool, etc.)
  - services (water bowl, pet menu, grooming)
  - fees / policies
  - best_for / not_for tags
  - one-line pet hook

Idempotent: skips POIs that already have pet_features.

Cost: ~175 POIs × 1 grounded call ≈ ¥5 / 25 min runtime.
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API_KEY = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY:
    print("FATAL: GEMINI_API_KEY env var required", file=sys.stderr)
    sys.exit(1)

MODEL = "gemini-2.5-flash"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))


def prompt_for(p):
    return f"""你是宠物友好场所信息核查员。用 Google 搜索（优先小红书、大众点评、马蜂窝等中文网友实测）查证下面这个北京地点对宠物的具体政策与设施。

地点：{p.get('name')}
所在：{p.get('district','')}区
类型：{p.get('category','')}
已知特点：{p.get('why_friendly','')}
现有提示：{p.get('tips','')}

请基于网友实测结果，输出一个 JSON 对象（**严格输出，不要解释、不要 markdown 包裹、第一字符必须是 {{**）。每个字段都基于真实证据，**搜不到证据的字段填 null 或空数组**，不要瞎猜。

JSON schema：
{{
  "access": {{
    "indoor_allowed": true/false/null,        // 室内是否允许宠物进入
    "outdoor_only": true/false,               // 仅限户外（true=只能在外摆/户外区）
    "leash_required": true/false,             // 必须牵绳
    "diaper_required": true/false,            // 必须穿尿不湿
    "carrier_required": true/false,           // 必须装航空箱/推车
    "vaccination_proof": true/false           // 是否查免疫本
  }},
  "size_limit": {{
    "max_shoulder_height_cm": 35/null,        // 肩高上限（cm，搜不到填 null）
    "large_dog_allowed": true/false/null,     // 大型犬（肩高>35cm）是否允许
    "banned_breeds": []                       // 明确禁止的烈性犬品种数组
  }},
  "facilities": [],
  // 从下面选项里勾，多选: ["grass_area","fenced_area","swimming_pool","indoor_pet_zone","outdoor_seating","pet_bathroom","shower","large_open_space","tree_shade"]
  "services": [],
  // 多选: ["water_bowl","free_treats","pet_menu","pet_dessert","grooming_onsite","pet_sitter","pet_photo"]
  "fees": {{
    "pet_extra_fee": "免费"或"押金 200 元"或"每晚加 50 元"等具体描述,
    "sterilization_required": true/false      // 是否要求绝育
  }},
  "best_for": [],                              // 适合: ["小型犬","中型犬","大型犬","幼犬","老年犬","怕热","怕生狗","高能量犬","多狗家庭"]
  "not_for": [],                               // 不适合: 同上集合
  "pet_hook": "≤20 字一句话，店与狗的核心关联点（具体细节，不要通用形容）"
}}

关键规则：
- 一切基于网友实测；不确定就填 null/false/空数组
- pet_hook 是核心：必须具体（如"会主动送狗狗鸡胸肉零食"而非"对狗友好"）
- 不要返回 markdown 代码块
"""


def call_gemini(prompt, retries=2):
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096, "thinkingConfig": {"thinkingBudget": 0}},
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
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if i < retries:
                time.sleep(5 * (i + 1))
                continue
            raise
    return None


def parse_first_object(text):
    if not text:
        return None
    s = re.sub(r"^```(?:json)?\s*", "", text.strip())
    s = re.sub(r"```\s*$", "", s)
    start = s.find("{")
    if start < 0:
        return None
    depth = 0; in_str = False; esc = False
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
                    try:
                        return json.loads(s[start:i+1])
                    except json.JSONDecodeError:
                        return None
    return None


def process(pid_p):
    pid, p = pid_p
    if "pet_features" in p:
        return {"pid": pid, "skip": True}
    try:
        resp = call_gemini(prompt_for(p))
    except Exception as e:
        return {"pid": pid, "ok": False, "error": str(e)[:120]}
    parts = (resp.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts if "text" in p)
    obj = parse_first_object(text)
    if not obj:
        return {"pid": pid, "ok": False, "error": "json parse failed"}
    # 简单 sanity-check
    if not isinstance(obj.get("facilities"), list):
        obj["facilities"] = []
    if not isinstance(obj.get("services"), list):
        obj["services"] = []
    if not isinstance(obj.get("best_for"), list):
        obj["best_for"] = []
    if not isinstance(obj.get("not_for"), list):
        obj["not_for"] = []
    return {"pid": pid, "ok": True, "pet_features": obj}


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)
    todo = [(pid, p) for pid, p in pois.items() if "pet_features" not in p]
    print(f"to enrich: {len(todo)} / total {len(pois)}", flush=True)

    completed = 0
    fail = 0
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(process, todo):
            if r.get("skip"):
                continue
            if r.get("ok"):
                pois[r["pid"]]["pet_features"] = r["pet_features"]
                completed += 1
                p = pois[r["pid"]]
                hook = r["pet_features"].get("pet_hook", "")[:30]
                fac = r["pet_features"].get("facilities", [])
                print(f"  [{completed}] {p['name'][:24]:24} | {len(fac)} fac | {hook}", flush=True)
            else:
                fail += 1
                print(f"  FAIL {r.get('pid')}: {r.get('error')}", flush=True)
            # checkpoint every 15
            if (completed + fail) % 15 == 0:
                with open(POIS_PATH, "w", encoding="utf-8") as f:
                    json.dump(pois, f, ensure_ascii=False, indent=1)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)
    print(f"\n=== done === ok={completed} fail={fail}")


if __name__ == "__main__":
    main()
