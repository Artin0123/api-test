# /// script
# dependencies = [
#   "aiohttp",
# ]
# ///

"""逐個探測 response.json 裡的模型是否能回 chat completions。

與專案主系統無關。金鑰與 endpoint 從 repo 根目錄的 .dev.vars 讀取
（API_KEY、API_ENDPOINTS），不要寫進這個檔案。
"""

import asyncio
import json
import os
from datetime import datetime, timezone

import aiohttp

# ==================== 【手動配置區：只改這裡】 ====================
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

MODELS_JSON = os.path.join(HERE, "response.json")
# 若存在則只測這份逗號分隔名單（lookup_model_release_dates.py 產出）；None 則用 JSON 全表。
MODELS_FILE = os.path.join(HERE, "released_within_year.txt")
OUTPUT_PATH = os.path.join(HERE, "test_chat_models_passed.json")
DEV_VARS = os.path.join(ROOT, ".dev.vars")

CONCURRENCY = 8
TIMEOUT_SECS = 60
PREVIEW_CHARS = 50
LIMIT = None  # 例：5，只測前 N 個；None 表示全部
# ===============================================================

BODY_TEMPLATE = {
    "model": "",
    "max_tokens": 4096,
    "messages": [
        {
            "role": "user",
            "content": "only reply answer: 17x29=?",
        }
    ],
}


def load_dev_vars(path: str) -> dict[str, str]:
    """讀 KEY=VALUE。.dev.vars 已 gitignore；已存在的環境變數優先。"""
    values: dict[str, str] = {}
    if not os.path.exists(path):
        raise SystemExit(f"找不到 {path}")
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name = name.strip()
            if name:
                values[name] = value.strip().strip("\"'")
    return values


def resolve_creds() -> tuple[str, str]:
    file_vals = load_dev_vars(DEV_VARS)
    api_key = os.environ.get("API_KEY", "").strip() or file_vals.get("API_KEY", "").strip()
    endpoint = (
        os.environ.get("API_ENDPOINTS", "").strip()
        or file_vals.get("API_ENDPOINTS", "").strip()
    )
    if not api_key:
        raise SystemExit("缺少 API_KEY（.dev.vars 或環境變數）")
    if not endpoint:
        raise SystemExit("缺少 API_ENDPOINTS（.dev.vars 或環境變數）")
    return api_key, endpoint.rstrip("/")


def load_models(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("data")
    if not isinstance(rows, list):
        raise SystemExit(f"{path} 缺少 data 陣列")
    models: list[str] = []
    seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        mid = item.get("id")
        if isinstance(mid, str) and mid and mid not in seen:
            seen.add(mid)
            models.append(mid)
    if MODELS_FILE and os.path.exists(MODELS_FILE):
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            wanted = [m.strip() for m in f.read().split(",") if m.strip()]
        allow = set(wanted)
        models = [m for m in models if m in allow]
        print(f"使用名單: {MODELS_FILE}（{len(models)} 個）")
    return models


def extract_text(data: object) -> str:
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    choice = choices[0]
    if not isinstance(choice, dict):
        return ""
    message = choice.get("message")
    if not isinstance(message, dict):
        message = {}

    def from_content(content: object) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            return "".join(parts)
        return ""

    text = from_content(message.get("content"))
    if text.strip():
        return text
    for key in ("reasoning_content", "reasoning"):
        extra = message.get(key)
        if isinstance(extra, str) and extra.strip():
            return extra
    return from_content(choice.get("text"))


def preview(text: str, n: int) -> str:
    compact = " ".join(text.split())
    return compact[:n]


async def call_one(
    session: aiohttp.ClientSession,
    sem: asyncio.Semaphore,
    endpoint: str,
    api_key: str,
    model: str,
    index: int,
    total: int,
) -> dict:
    body = dict(BODY_TEMPLATE)
    body["model"] = model
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with sem:
        try:
            async with session.post(endpoint, headers=headers, json=body) as resp:
                raw = await resp.text()
                parsed = None
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = None
                text = extract_text(parsed)
                ok = resp.status == 200 and bool(text.strip())
                status = "OK" if ok else f"HTTP {resp.status}"
                shown = preview(text, PREVIEW_CHARS) if ok else (raw or "")[:120]
                print(f"[{index}/{total}] {model}: {status} | {shown}")
                return {
                    "model": model,
                    "ok": ok,
                    "http_status": resp.status,
                    "output": text,
                }
        except asyncio.TimeoutError:
            print(f"[{index}/{total}] {model}: timeout")
            return {"model": model, "ok": False, "http_status": None, "error": "timeout"}
        except Exception as e:
            print(f"[{index}/{total}] {model}: {e}")
            return {"model": model, "ok": False, "http_status": None, "error": str(e)}


async def main() -> int:
    api_key, endpoint = resolve_creds()
    models = load_models(MODELS_JSON)
    if LIMIT is not None:
        models = models[: int(LIMIT)]
    if not models:
        raise SystemExit("沒有可測的模型")

    print(f"模型數: {len(models)} | 並發: {CONCURRENCY} | timeout: {TIMEOUT_SECS}s")
    print(f"endpoint: {endpoint}")
    print()

    timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECS)
    connector = aiohttp.TCPConnector(limit=max(CONCURRENCY, 1))
    sem = asyncio.Semaphore(max(CONCURRENCY, 1))

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        results = await asyncio.gather(
            *[
                call_one(session, sem, endpoint, api_key, model, i, len(models))
                for i, model in enumerate(models, 1)
            ]
        )

    passed = [
        {"model": r["model"], "output": preview(r.get("output") or "", PREVIEW_CHARS)}
        for r in results
        if r.get("ok")
    ]

    out = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "endpoint": endpoint,
        "total": len(models),
        "passed_count": len(passed),
        "passed": passed,
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print()
    print(f"通過: {len(passed)}/{len(models)}")
    print(f"寫入: {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
