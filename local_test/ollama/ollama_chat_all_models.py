# /// script
# dependencies = [
#   "aiohttp",
# ]
# ///

import asyncio
import json
import os
import re
from datetime import datetime, timezone

import aiohttp

# ==================== 【手動配置區：只改這裡】 ====================
BASE_URL = "https://ollama.com"
TAGS_URL = f"{BASE_URL}/api/tags"
CHAT_URL = f"{BASE_URL}/v1/chat/completions"

# 金鑰一律從環境變數或專案根目錄的 .env 讀取（.env 已列入 .gitignore）。
# 不要把金鑰寫回這個檔案——它會進版控。範本見 .env.example。
ENV_VAR_NAME = "OLLAMA_API_KEY"

PROMPT = "Hello! Reply with a short answer."
SYSTEM = ""  # 可留空
MAX_TOKENS = 256
TEMPERATURE = 0.6

CONCURRENCY = 2
TIMEOUT_SECS = 30

# 篩選：None 表示全部；也可用 substring 或 regex /.../
MATCH = None  # 例："qwen" 或 "/^qwen/"
LIMIT = None  # 例：10

DRY_RUN = False  # True：只列出會跑的 model 名稱，不打 API
PRINT_PER_MODEL = False  # True：每個模型在 stdout 印一行 JSON

# 輸出固定寫在 local_test 資料夾內（避免在專案到處生檔）
HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(HERE, "ollama_chat_results.json")
# ===============================================================


ENV_FILE = os.path.join(os.path.dirname(HERE), ".dev.vars")  # 專案根目錄，已 gitignore


def load_env_file(path: str | None = None) -> None:
    """讀取 KEY=VALUE 形式的 .env。真正的環境變數優先，不覆蓋已設定的值。

    刻意不引入 python-dotenv：這支腳本以 PEP 723 內嵌相依執行，只依賴 aiohttp。
    """
    path = path or ENV_FILE  # 在呼叫時才取值，方便覆寫 ENV_FILE
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name = name.strip()
            if name and name not in os.environ:
                os.environ[name] = value.strip().strip("\"'")


def resolve_key() -> str:
    load_env_file()
    key = os.environ.get(ENV_VAR_NAME, "").strip()
    if not key:
        raise SystemExit(
            f"缺少 API key。請在專案根目錄建立 .env（已 gitignore）並填入：\n"
            f"    {ENV_VAR_NAME}=你的金鑰\n"
            f"或直接設定同名環境變數。範本：.env.example"
        )
    return key


def match_name(name: str, match: str | None) -> bool:
    if not match:
        return True
    # regex if wrapped like /.../
    if len(match) >= 2 and match.startswith("/") and match.endswith("/"):
        return re.search(match[1:-1], name) is not None
    return match.lower() in name.lower()


def family_english_prefix(model_name: str) -> str | None:
    """Family key made of ONLY English letters.

    Takes the first contiguous [A-Za-z]+ segment, ignoring any leading non-letters.

    Examples:
      - qwen3-vl        -> qwen
      - qwen4-think     -> qwen
      - qwen3-v1        -> qwen
      - 1-qwen-vl       -> qwen
    """

    m = re.match(r"[^A-Za-z]*([A-Za-z]+)", model_name)
    if not m:
        return None
    return m.group(1).lower()


def collect_strings_from_json(obj, out: list[str], depth: int = 0, max_depth: int = 4):
    if depth > max_depth:
        return
    if isinstance(obj, str):
        if obj:
            out.append(obj)
        return
    if isinstance(obj, dict):
        for v in obj.values():
            collect_strings_from_json(v, out, depth + 1, max_depth)
        return
    if isinstance(obj, list):
        for v in obj:
            collect_strings_from_json(v, out, depth + 1, max_depth)
        return


def looks_like_subscription_error(result_item: dict) -> bool:
    """Detect 'requires subscription' errors.

    Only consider non-200 results to avoid false positives in successful content.
    """

    if result_item.get("ok") is True or result_item.get("http_status") == 200:
        return False

    parts: list[str] = []
    collect_strings_from_json(result_item.get("response_json"), parts)

    snip = result_item.get("response_text_snippet")
    if isinstance(snip, str) and snip:
        parts.append(snip)

    hay = "\n".join(parts).lower()
    if not hay:
        return False

    if "requires a subscription" in hay:
        return True
    if "upgrade for access" in hay and "ollama.com/upgrade" in hay:
        return True
    if "subscription" in hay and "upgrade" in hay:
        return True

    return False


async def fetch_tags(session: aiohttp.ClientSession) -> list[dict]:
    async with session.get(TAGS_URL) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"GET {TAGS_URL} -> HTTP {resp.status}: {text[:500]}")
        data = json.loads(text)

    models = data.get("models")
    if not isinstance(models, list):
        raise RuntimeError("Unexpected /api/tags response: missing 'models' list")

    entries: list[dict] = []
    for m in models:
        if not isinstance(m, dict):
            continue
        name = m.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()

        digest = m.get("digest")
        if digest is not None and not isinstance(digest, str):
            digest = str(digest)

        entries.append(
            {
                "name": name,
                "family": family_english_prefix(name),
                "digest": digest,
                "modified_at": m.get("modified_at"),
                "size": m.get("size"),
                "details": m.get("details"),
            }
        )

    # de-dup by name (stable)
    seen: set[str] = set()
    deduped: list[dict] = []
    for e in entries:
        if e["name"] in seen:
            continue
        seen.add(e["name"])
        deduped.append(e)

    return deduped


def build_chat_payload(model: str) -> dict:
    messages = []
    if SYSTEM:
        messages.append({"role": "system", "content": SYSTEM})
    messages.append({"role": "user", "content": PROMPT})

    return {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
    }


async def call_chat(session: aiohttp.ClientSession, api_key: str, model: str):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "api-test/local_test/ollama_chat_all_models.py",
    }

    async with session.post(
        CHAT_URL, headers=headers, json=build_chat_payload(model)
    ) as resp:
        raw_text = await resp.text()
        content_type = resp.headers.get("Content-Type", "")

        parsed = None
        if "application/json" in content_type.lower():
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                parsed = None

        return resp.status, parsed, raw_text


async def main() -> int:
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECS)
    connector = aiohttp.TCPConnector(limit=max(CONCURRENCY, 1))
    sem = asyncio.Semaphore(max(CONCURRENCY, 1))

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        all_entries = await fetch_tags(session)
        total_models_in_tags = len(all_entries)

        model_entries = [e for e in all_entries if match_name(e["name"], MATCH)]
        if LIMIT is not None:
            model_entries = model_entries[: int(LIMIT)]
        selected_models = len(model_entries)

        if DRY_RUN:
            for e in model_entries:
                print(e["name"])
            return 0

        api_key = resolve_key()

        run_meta = {
            "base_url": BASE_URL,
            "tags_url": TAGS_URL,
            "chat_url": CHAT_URL,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "prompt": PROMPT,
            "system": SYSTEM,
            "max_tokens": MAX_TOKENS,
            "temperature": TEMPERATURE,
            "concurrency": CONCURRENCY,
            "timeout_secs": TIMEOUT_SECS,
            "stats": {
                "total_models_in_tags": total_models_in_tags,
                "selected_models": selected_models,
            },
        }

        async def one(entry: dict) -> dict:
            model_name = entry["name"]
            async with sem:
                collected_at = datetime.now(timezone.utc).isoformat()
                try:
                    status, data, raw = await call_chat(session, api_key, model_name)
                    ok = status == 200 and isinstance(data, dict)
                    item: dict = {
                        "model": model_name,
                        "model_family": entry.get("family"),
                        "tag": {
                            "digest": entry.get("digest"),
                            "modified_at": entry.get("modified_at"),
                            "size": entry.get("size"),
                            "details": entry.get("details"),
                        },
                        "http_status": status,
                        "ok": ok,
                        "collected_at": collected_at,
                        "response_json": data,
                    }

                    # only keep raw snippet if it isn't JSON
                    if not ok and data is None:
                        item["response_text_snippet"] = (raw or "")[:2000]

                except Exception as e:
                    item = {
                        "model": model_name,
                        "model_family": entry.get("family"),
                        "tag": {
                            "digest": entry.get("digest"),
                            "modified_at": entry.get("modified_at"),
                            "size": entry.get("size"),
                            "details": entry.get("details"),
                        },
                        "http_status": None,
                        "ok": False,
                        "collected_at": collected_at,
                        "error": str(e),
                    }

                if PRINT_PER_MODEL:
                    print(json.dumps(item, ensure_ascii=False))
                return item

        results = await asyncio.gather(*[one(e) for e in model_entries])

    # ---- stats ----
    ok_count = sum(1 for r in results if r.get("ok"))
    fail_count = len(results) - ok_count

    http_status_counts: dict[str, int] = {}
    for r in results:
        s = r.get("http_status")
        key = "null" if s is None else str(s)
        http_status_counts[key] = http_status_counts.get(key, 0) + 1

    # family counts + subscription annotation
    family_counts_simple: dict[str, int] = {}
    for e in model_entries:
        fam = e.get("family") or "__unknown__"
        family_counts_simple[str(fam)] = family_counts_simple.get(str(fam), 0) + 1

    family_subscription_models: dict[str, list[str]] = {}
    for r in results:
        if not looks_like_subscription_error(r):
            continue
        fam = r.get("model_family") or "__unknown__"
        model = r.get("model")
        if isinstance(model, str) and model:
            family_subscription_models.setdefault(str(fam), []).append(model)

    family_counts: dict[str, dict] = {}
    for fam, cnt in family_counts_simple.items():
        models = sorted(set(family_subscription_models.get(fam, [])))
        family_counts[fam] = {
            "count": cnt,
            "has_subscription_required": bool(models),
            "subscription_models": models,
            "subscription_models_count": len(models),
        }

    run_meta["stats"].update(
        {
            "results": len(results),
            "ok": ok_count,
            "fail": fail_count,
            "http_status_counts": http_status_counts,
            "family_counts": family_counts,
            "subscription_required_families": sorted(
                [
                    k
                    for k, v in family_counts.items()
                    if v.get("has_subscription_required")
                ]
            ),
        }
    )

    out_obj = {"meta": run_meta, "results": results}
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out_obj, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote: {OUTPUT_PATH}")
    print(
        f"Models: {selected_models}/{total_models_in_tags} | OK: {ok_count} | Fail: {fail_count}"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
