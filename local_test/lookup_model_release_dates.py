# /// script
# dependencies = []
# ///

"""查發布／上架日。

date = 可靠來源裡最早的那天（不含 gateway）。
可靠來源：id 日期、平台目錄、OpenRouter、Hugging Face。

- 阿里雲：Qwen Cloud changelog
- Silicon Flow：www.siliconflow.com/models 的 Release on（created 全是 0，不用來排除）

gateway created 只用來排除（且必須 > 0）。
gateway 在期限內或缺失、可靠來源都沒日期 → Pending。
任一可靠來源確認超過 WITHIN_DAYS → 刪。
Pending / 仍查不到 → 保留。
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ==================== 【手動配置區：只改這裡】 ====================
HERE = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(HERE, "response.json")
DATES_JSON = os.path.join(HERE, "model_release_dates.json")
OUTPUT_TXT = os.path.join(HERE, "released_within_year.txt")

WITHIN_DAYS = 365
# None = 依模型 id 自動判斷（多數含 org/name → siliconflow）
PROVIDER = None  # "siliconflow" | "alibaba"
QWEN_CHANGELOG_URL = "https://docs.qwencloud.com/changelog/models.md"
SF_MODELS_URL = "https://www.siliconflow.com/models"
OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
HF_API = "https://huggingface.co/api/models"
HF_WORKERS = 8
# ===============================================================

ISO_DATE_RE = re.compile(r"(20\d{2})-(\d{2})-(\d{2})")
YYMM_RE = re.compile(r"-(\d{2})(\d{2})$")
UPDATE_RE = re.compile(r'<Update label="([^"]+)">(.*?)</Update>', re.S)
HEADING_RE = re.compile(r"^\s*### (.+)$", re.M)
TIME_RE = re.compile(r'<time datetime="(20\d{2}-\d{2}-\d{2})T')
SF_SKIP_LABELS = frozenset(
    {"chat", "image", "video", "audio", "vision", "llm", "embedding", "rerank"}
)
SF_PREFIXES = ("Pro/", "LoRA/")
UA = {"User-Agent": "api-test/local_test/lookup_model_release_dates.py"}
RELIABLE_SOURCES = frozenset(
    {"id_iso", "id_yymm", "changelog", "sf_catalog", "openrouter", "huggingface"}
)


def http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def strip_sf_prefix(model_id: str) -> str:
    s = model_id
    for p in SF_PREFIXES:
        if s.startswith(p):
            return s[len(p) :]
    return s


def compact(name: str) -> str:
    s = strip_sf_prefix(name).lower().strip().split("/")[-1]
    s = ISO_DATE_RE.sub(lambda m: "".join(m.groups()), s)
    return s.replace("_", "-")


def parse_iso(text: str) -> datetime | None:
    m = ISO_DATE_RE.search(text)
    if not m:
        return None
    y, mo, d = map(int, m.groups())
    try:
        return datetime(y, mo, d, tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_yymm(model_id: str) -> datetime | None:
    """Qwen-Image-Edit-2509 → 2025-09-01。MMDD 無年份不採用。"""
    m = YYMM_RE.search(compact(model_id))
    if not m:
        return None
    yy, mm = int(m.group(1)), int(m.group(2))
    if yy < 23 or yy > 29 or mm < 1 or mm > 12:
        return None
    return datetime(2000 + yy, mm, 1, tzinfo=timezone.utc)


def detect_provider(models: list[str]) -> str:
    if PROVIDER in {"siliconflow", "alibaba"}:
        return PROVIDER
    slashed = sum(1 for m in models if "/" in m)
    return "siliconflow" if slashed >= max(len(models) * 0.5, 1) else "alibaba"


def parse_qwen_changelog(md: str) -> dict[str, datetime]:
    exact: dict[str, datetime] = {}
    by_compact: dict[str, datetime] = {}
    for label, body in UPDATE_RE.findall(md):
        try:
            dt = datetime.strptime(label.strip(), "%B %d, %Y").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue
        for hm in HEADING_RE.finditer(body):
            for raw in hm.group(1).split(","):
                name = raw.strip().strip("`")
                if not name:
                    continue
                exact.setdefault(name.lower(), dt)
                by_compact.setdefault(compact(name), dt)
    return {**by_compact, **exact}


def load_sf_catalog() -> dict[str, datetime]:
    """www.siliconflow.com/models 卡片上的 <time datetime> + 顯示名。"""
    html = http_get(SF_MODELS_URL, timeout=45)
    out: dict[str, datetime] = {}
    for m in TIME_RE.finditer(html):
        try:
            dt = datetime.fromisoformat(m.group(1)).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        chunk = html[max(0, m.start() - 1500) : m.start()]
        texts = re.findall(r">([A-Za-z0-9][A-Za-z0-9._/-]{2,80})<", chunk)
        name = None
        for cand in reversed(texts):
            if cand.lower() in SF_SKIP_LABELS:
                continue
            name = cand
            break
        if not name:
            continue
        key = compact(name)
        out.setdefault(key, dt)
        out.setdefault(name.lower(), dt)
    return out


def load_openrouter() -> dict[str, datetime]:
    data = json.loads(http_get(OPENROUTER_URL))
    out: dict[str, datetime] = {}
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        oid = item.get("id")
        created = item.get("created")
        if not isinstance(oid, str) or not isinstance(created, (int, float)):
            continue
        dt = datetime.fromtimestamp(created, tz=timezone.utc)
        out.setdefault(oid.lower(), dt)
        out.setdefault(compact(oid), dt)
    return out


def hf_created(hf_id: str) -> datetime | None:
    url = f"{HF_API}/{urllib.parse.quote(hf_id, safe='/')}"
    try:
        data = json.loads(http_get(url, timeout=20))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    created = data.get("createdAt")
    if not isinstance(created, str) or not created:
        return None
    return datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone(
        timezone.utc
    )


def lookup_hf(model_id: str) -> tuple[datetime, str] | None:
    hf_id = strip_sf_prefix(model_id)
    if "/" not in hf_id:
        return None
    dt = hf_created(hf_id)
    if dt:
        return dt, hf_id
    return None


def sibling_date(model_id: str, all_ids: list[str]) -> datetime | None:
    leaf = strip_sf_prefix(model_id)
    prefix = leaf + "-"
    dates: list[datetime] = []
    for other in all_ids:
        other_leaf = strip_sf_prefix(other)
        if other_leaf == leaf or not other_leaf.startswith(prefix):
            continue
        suffix = other_leaf[len(prefix) :]
        if ISO_DATE_RE.fullmatch(suffix):
            dt = parse_iso(suffix)
            if dt:
                dates.append(dt)
    return max(dates) if dates else None


def iso_or_none(dt: datetime | None) -> str | None:
    return dt.date().isoformat() if dt else None


def pick_earliest(src_dates: dict[str, datetime]) -> tuple[datetime | None, str | None]:
    reliable = {k: v for k, v in src_dates.items() if k in RELIABLE_SOURCES}
    if not reliable:
        return None, None
    src = min(reliable, key=lambda k: (reliable[k], k))
    return reliable[src], src


def apply_verdict(
    rec: dict,
    src_dates: dict[str, datetime],
    gw: datetime | None,
    cutoff: datetime,
) -> None:
    earliest, src = pick_earliest(src_dates)
    rec["date"] = iso_or_none(earliest)
    rec["source"] = src
    rec["sources"] = {k: iso_or_none(v) for k, v in sorted(src_dates.items())}

    drop_reason = None
    if gw is not None and gw < cutoff:
        drop_reason = "gateway_created"
    if earliest is not None and earliest < cutoff:
        drop_reason = drop_reason or src

    rec["drop_reason"] = drop_reason
    if drop_reason:
        rec["status"] = "dropped"
        rec["keep"] = False
    elif earliest is None:
        rec["status"] = "pending"
        rec["keep"] = True
    else:
        rec["status"] = "kept"
        rec["keep"] = True


def main() -> int:
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        payload = json.load(f)
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise SystemExit(f"{INPUT_FILE} 缺少 data 陣列")

    models: list[str] = []
    gateway_created: dict[str, datetime] = {}
    seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        mid = item.get("id")
        if not isinstance(mid, str) or not mid or mid in seen:
            continue
        seen.add(mid)
        models.append(mid)
        created = item.get("created")
        # Silicon Flow 的 created 恆為 0，不能當上架日。
        if isinstance(created, (int, float)) and created > 0:
            gateway_created[mid] = datetime.fromtimestamp(created, tz=timezone.utc)

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=WITHIN_DAYS)
    provider = detect_provider(models)

    print(f"模型數: {len(models)} | 平台: {provider} | 期限: {WITHIN_DAYS} 天（{cutoff.date()} 起）")

    catalog: dict[str, datetime] = {}
    catalog_name = ""
    if provider == "alibaba":
        print("抓 Qwen Cloud changelog / OpenRouter …")
        catalog = parse_qwen_changelog(http_get(QWEN_CHANGELOG_URL))
        catalog_name = "changelog"
    else:
        print("抓 SiliconFlow 模型目錄 / OpenRouter …")
        catalog = load_sf_catalog()
        catalog_name = "sf_catalog"
    openrouter = load_openrouter()
    print(f"{catalog_name}: {len(catalog)} keys | OpenRouter: {len(openrouter)} keys")

    all_dates: dict[str, dict[str, datetime]] = {m: {} for m in models}
    hf_detail: dict[str, str] = {}

    for mid in models:
        iso = parse_iso(mid)
        if iso:
            all_dates[mid]["id_iso"] = iso
        yymm = parse_yymm(mid)
        if yymm:
            all_dates[mid]["id_yymm"] = yymm
        cl = catalog.get(mid.lower()) or catalog.get(compact(mid))
        if cl:
            all_dates[mid][catalog_name] = cl
        or_dt = (
            openrouter.get(mid.lower())
            or openrouter.get(strip_sf_prefix(mid).lower())
            or openrouter.get(compact(mid))
        )
        if or_dt:
            all_dates[mid]["openrouter"] = or_dt
        sib = sibling_date(mid, models)
        if sib:
            all_dates[mid]["sibling_snapshot"] = sib

    need_hf = [m for m in models if "/" in strip_sf_prefix(m)]
    if need_hf:
        print(f"Hugging Face 補查 {len(need_hf)} 個 …")
        with ThreadPoolExecutor(max_workers=HF_WORKERS) as pool:
            futs = {pool.submit(lookup_hf, mid): mid for mid in need_hf}
            for fut in as_completed(futs):
                mid = futs[fut]
                try:
                    hit = fut.result()
                except Exception as e:
                    hf_detail[mid] = str(e)
                    continue
                if hit:
                    dt, hf_id = hit
                    all_dates[mid]["huggingface"] = dt
                    hf_detail[mid] = hf_id

    results: dict[str, dict] = {}
    for mid in models:
        gw = gateway_created.get(mid)
        rec = {
            "model": mid,
            "gateway_created": iso_or_none(gw),
            "detail": hf_detail.get(mid),
        }
        apply_verdict(rec, all_dates[mid], gw, cutoff)
        results[mid] = rec

    kept: list[str] = []
    dropped: list[str] = []
    pending_left: list[str] = []
    status_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    for mid in models:
        rec = results[mid]
        st = rec["status"]
        status_counts[st] = status_counts.get(st, 0) + 1
        src = rec.get("source") or "none"
        source_counts[src] = source_counts.get(src, 0) + 1
        if rec["keep"]:
            kept.append(mid)
        else:
            dropped.append(mid)
        if st == "pending":
            pending_left.append(mid)

    blob = {
        "collected_at": now.isoformat(),
        "provider": provider,
        "cutoff": cutoff.date().isoformat(),
        "within_days": WITHIN_DAYS,
        "date_meaning": "earliest reliable source (not gateway)",
        "stats": {
            "total": len(models),
            "kept": len(kept),
            "dropped": len(dropped),
            "pending": len(pending_left),
            "status": status_counts,
            "date_source": source_counts,
        },
        "models": [results[m] for m in models],
        "pending": pending_left,
        "dropped": dropped,
    }
    with open(DATES_JSON, "w", encoding="utf-8") as f:
        json.dump(blob, f, ensure_ascii=False, indent=2)
        f.write("\n")

    with open(OUTPUT_TXT, "w", encoding="utf-8") as f:
        f.write(",".join(kept))

    print()
    print(f"保留: {len(kept)} | 排除: {len(dropped)} | Pending: {len(pending_left)}")
    print(f"date 來源: {source_counts}")
    print(f"寫入: {OUTPUT_TXT}")
    print(f"寫入: {DATES_JSON}")
    if pending_left:
        print("Pending:")
        for m in pending_left:
            print(f"  {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
