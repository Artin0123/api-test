"""
runner.py — Cloud-native API tester for GitHub Actions
Replaces api_tester.py + consolidate_results.py

Flow:
  1. generate run_id
  2. GET /api/config?full=1  (Worker)
  3. GET /api/checkpoint
  4. for each provider → fetch models → run tester
  5. run benchmark (success models, 3 runs)
  6. POST /api/results
  7. DELETE /api/checkpoint
"""

import json
import os
import random
import re
import string
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib import error, request as urllib_request

# ── Constants ──────────────────────────────────────────────────────────────────

TIMEOUT_SECONDS          = 30
MAX_RETRIES              = 2
RETRY_BACKOFF_SECONDS    = [0.8, 1.6]
BENCHMARK_RUNS_PER_MODEL = 3
CHECKPOINT_EVERY_N       = 3

TESTER_PROMPT_THINKING   = "What is 17 multiplied by 19? Think step by step."
TESTER_PROMPT_VISION     = "Describe this image in one word."
BENCHMARK_PROMPT_THINKING = "What is 17 multiplied by 19? Reply with the number only."
BENCHMARK_PROMPT_VISION  = "Describe this image in one word."

VISION_IMAGE_MIME = "image/svg+xml"
VISION_IMAGE_B64  = (
    "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iNjAi"
    "IHZpZXdCb3g9IjAgMCAxNjAgNjAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9India"
    "aXRlIi8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9"
    "IjQwIiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iYmxhY2siIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWlu"
    "YW50LWJhc2VsaW5lPSJtaWRkbGUiPk1FT1c8L3RleHQ+PC9zdmc+"
)

DEFAULT_ENDPOINT_PATHS = {
    "openai": "/v1/chat/completions",
    "ollama": "/api/chat",
    "gemini": "/v1beta/models/{model}:streamGenerateContent?alt=sse",
}

DEFAULT_MODELS_ENDPOINTS = {
    "openai": "/v1/models",
    "ollama": "/api/tags",
    "gemini": "/v1beta/models",
}



# ── Utilities ──────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def mask_key(v: str) -> str:
    if not v or len(v) <= 6:
        return "***"
    return f"{v[:4]}***{v[-2:]}"

def generate_run_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    sfx = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{ts}_{sfx}"

def normalize_url(base: str, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{base.rstrip('/')}/{path.lstrip('/')}"

def pick_endpoint(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback

def is_benchmark_enabled(provider: dict) -> bool:
    if isinstance(provider.get("benchmark_enabled"), bool):
        return provider["benchmark_enabled"]
    if isinstance(provider.get("enabled"), bool):
        return provider["enabled"]
    return True

# ── Worker client ──────────────────────────────────────────────────────────────

class WorkerClient:
    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.token = token

    def _req(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        req = urllib_request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode())
        except error.HTTPError as exc:
            raise RuntimeError(f"Worker {method} {path} → HTTP {exc.code}: {exc.read().decode()[:200]}")

    def get_config(self)                  -> dict: return self._req("GET",    "/api/config?full=1")
    def get_checkpoint(self)              -> dict: return self._req("GET",    "/api/checkpoint")
    def post_checkpoint(self, ck: dict)   -> None: self._req("POST",   "/api/checkpoint", ck)
    def delete_checkpoint(self)           -> None: self._req("DELETE", "/api/checkpoint")
    def post_results(self, payload: dict) -> None: self._req("POST",   "/api/results", payload)

# ── Thinking extraction ────────────────────────────────────────────────────────

def extract_xml_think(content: str) -> tuple[str, str]:
    """Returns (thinking, cleaned_content)."""
    thinks = re.findall(r"<think>(.*?)</think>", content, flags=re.DOTALL)
    thinking = "\n".join(t.strip() for t in thinks if t.strip())
    cleaned = re.sub(r"<think>.*?</think>\n?", "", content, flags=re.DOTALL).strip()
    return thinking, cleaned

def extract_reasoning_details(details: Any) -> str:
    if not isinstance(details, list):
        return ""
    parts: list[str] = []
    for d in details:
        if not isinstance(d, dict):
            continue
        r = d.get("reasoning")
        if isinstance(r, dict):
            for k in ("summary", "text"):
                v = r.get(k)
                if isinstance(v, str) and v.strip():
                    parts.append(v.strip())
        for k in ("summary", "text", "content", "reasoning_content"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                parts.append(v.strip())
    return "\n".join(parts).strip()

def parse_sse(raw: str) -> list[dict]:
    events: list[dict] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s.startswith("data:"):
            continue
        chunk = s[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            obj = json.loads(chunk)
            if isinstance(obj, dict):
                events.append(obj)
        except json.JSONDecodeError:
            pass
    return events

# ── Parse helpers per provider ─────────────────────────────────────────────────

def openai_parse(raw: str) -> tuple[str, str]:
    answer = thinking = ""
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            msg = ((data.get("choices") or [{}])[0]).get("message", {}) or {}
            answer  = msg.get("content", "") or ""
            thinking = (
                msg.get("thinking")
                or msg.get("reasoning_content")
                or extract_reasoning_details(msg.get("reasoning_details"))
                or ""
            )
            # responses-style output[]
            if not answer and isinstance(data.get("output"), list):
                texts, thinks = [], []
                for item in data["output"]:
                    if not isinstance(item, dict):
                        continue
                    for k in ("reasoning", "thinking", "summary"):
                        v = item.get(k)
                        if isinstance(v, str) and v.strip():
                            thinks.append(v.strip())
                    for c in item.get("content") or []:
                        if isinstance(c, dict):
                            t = c.get("text")
                            if isinstance(t, str) and t.strip():
                                texts.append(t)
                answer  = "".join(texts).strip()
                thinking = thinking or "\n".join(thinks).strip()
    except json.JSONDecodeError:
        pass

    # SSE fallback (responses API streaming)
    if not answer and not thinking:
        text_chunks, think_chunks = [], []
        for ev in parse_sse(raw):
            et = str(ev.get("type", ""))
            if any(t in et for t in ("response.reasoning.delta", "response.thinking.delta", "response.thought.delta")):
                for k in ("delta", "text", "reasoning", "summary", "content"):
                    v = ev.get(k)
                    if isinstance(v, str) and v.strip():
                        think_chunks.append(v)
                        break
                    if isinstance(v, dict):
                        for sk in ("text", "summary", "content"):
                            sv = v.get(sk)
                            if isinstance(sv, str) and sv.strip():
                                think_chunks.append(sv)
                                break
            if et in {"response.output_text.delta", "response.message.delta"}:
                d = ev.get("delta")
                if isinstance(d, str) and d:
                    text_chunks.append(d)
        answer  = "".join(text_chunks).strip()
        thinking = "".join(think_chunks).strip()

    # XML <think> fallback
    xml_thinking, cleaned = extract_xml_think(answer)
    if xml_thinking and not thinking:
        thinking = xml_thinking
        answer   = cleaned

    return answer, thinking


def ollama_parse(raw: str) -> tuple[str, str]:
    data    = json.loads(raw)
    msg     = data.get("message", {}) or {}
    answer  = msg.get("content", "") or ""
    thinking = msg.get("thinking", "") or ""
    if not thinking and answer:
        xml_thinking, cleaned = extract_xml_think(answer)
        if xml_thinking:
            thinking = xml_thinking
            answer   = cleaned
    return answer, thinking


def gemini_parse(raw: str) -> tuple[str, str]:
    text_parts, thinking_parts, sigs = [], [], []
    for ev in parse_sse(raw):
        for c in ev.get("candidates") or []:
            content = c.get("content") or {}
            for p in content.get("parts") or []:
                if not isinstance(p, dict):
                    continue
                text = p.get("text")
                if isinstance(text, str):
                    if p.get("thought"):
                        thinking_parts.append(text)
                    else:
                        text_parts.append(text)
                sig = p.get("thoughtSignature")
                if isinstance(sig, str) and sig.strip():
                    sigs.append(sig[:16])
    answer  = "".join(text_parts).strip()
    thinking = "\n".join(t for t in thinking_parts if t.strip()).strip()
    if sigs and not thinking:
        thinking = f"[thoughtSignature:{sigs[0]}...]"
    return answer, thinking


def parse_response(provider_type: str, raw: str) -> tuple[str, str]:
    """Dispatch to correct parser. Returns (answer, thinking)."""
    if provider_type == "openai":
        return openai_parse(raw)
    if provider_type == "ollama":
        return ollama_parse(raw)
    return gemini_parse(raw)

# ── HTTP send ──────────────────────────────────────────────────────────────────

class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status

def classify_error(exc: Exception) -> str:
    if isinstance(exc, (TimeoutError, TimeoutError)):
        return "timeout"
    if isinstance(exc, ApiError):
        s = exc.status
        if s == 401: return "unauthorized"
        if s == 403: return "forbidden"
        if s == 404: return "not_found"
        if s == 429: return "rate_limited"
        if s >= 500: return "server_error"
        return "request_error"
    return "unexpected_error"

def should_retry(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    if isinstance(exc, ApiError):
        return exc.status == 429 or exc.status >= 500
    return False

def http_post(url: str, headers: dict, payload: dict, timeout: float) -> str:
    data = json.dumps(payload).encode()
    req  = urllib_request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        raise ApiError(exc.code, exc.read().decode("utf-8", errors="replace"))

# ── Build request per provider ─────────────────────────────────────────────────

def build_request(provider: dict, model: str, prompt: str) -> tuple[str, dict, dict]:
    """Returns (url, headers, payload)."""
    ptype    = provider["provider_type"]
    api_base = provider["api_base"]
    api_key  = provider["api_key"]
    mode     = provider["mode"]
    endpoint = pick_endpoint(provider.get("endpoint_path"), DEFAULT_ENDPOINT_PATHS[ptype])

    ua = "api-tester/2.0 runner"

    if ptype == "openai":
        url = normalize_url(api_base, endpoint)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": ua,
        }
        if mode == "vision":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{VISION_IMAGE_MIME};base64,{VISION_IMAGE_B64}"}},
            ]
        else:
            content = prompt
        payload = {"model": model, "messages": [{"role": "user", "content": content}], "temperature": 0.2}

    elif ptype == "ollama":
        url = normalize_url(api_base, endpoint)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": ua,
        }
        msg: dict = {"role": "user", "content": prompt}
        if mode == "vision":
            msg["images"] = [VISION_IMAGE_B64]
        payload = {"model": model, "messages": [msg], "stream": False}

    else:  # gemini
        path = endpoint.replace("{model}", model)
        url  = normalize_url(api_base, path)
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
            "User-Agent": ua,
            "Accept": "text/event-stream",
        }
        if mode == "vision":
            parts = [
                {"text": prompt},
                {"inline_data": {"mime_type": VISION_IMAGE_MIME, "data": VISION_IMAGE_B64}},
            ]
        else:
            parts = [{"text": prompt}]
        payload = {"contents": [{"role": "user", "parts": parts}]}

    return url, headers, payload

# ── Model list fetching ────────────────────────────────────────────────────────

def fetch_models(provider: dict) -> list[str]:
    ptype    = provider["provider_type"]
    api_base = provider["api_base"]
    api_key  = provider.get("api_key", "")
    endpoint = pick_endpoint(provider.get("models_endpoint"), DEFAULT_MODELS_ENDPOINTS[ptype])
    url      = normalize_url(api_base, endpoint)

    headers: dict = {"User-Agent": "api-tester/2.0 runner"}
    if ptype == "gemini":
        headers["x-goog-api-key"] = api_key
    else:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        req = urllib_request.Request(url, headers=headers, method="GET")
        with urllib_request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
    except Exception as exc:
        print(f"  [models fetch failed: {exc}] → skip provider")
        return []

    models: list[str] = []
    if ptype == "openai":
        for item in data.get("data") or []:
            if isinstance(item.get("id"), str):
                models.append(item["id"])
    elif ptype == "ollama":
        for item in data.get("models") or []:
            name = item.get("model") or item.get("name")
            if isinstance(name, str):
                models.append(name)
    elif ptype == "gemini":
        for item in data.get("models") or []:
            name = item.get("name", "")
            if "/" in name:
                models.append(name.split("/")[-1])

    if not models:
        print("  [models endpoint returned empty] → skip provider")
        return []

    return models


# ── Test one model (with retry) ────────────────────────────────────────────────

def test_model(provider: dict, model: str) -> dict:
    """Run tester request with retry. Returns scorecard item dict."""
    mode   = provider["mode"]
    prompt = TESTER_PROMPT_THINKING if mode == "thinking" else TESTER_PROMPT_VISION
    ptype  = provider["provider_type"]
    url, headers, payload = build_request(provider, model, prompt)

    last_exc: Exception | None = None
    retry_count = 0
    t0 = time.perf_counter()

    for attempt in range(MAX_RETRIES + 1):
        if attempt > 0:
            backoff = RETRY_BACKOFF_SECONDS[min(attempt - 1, len(RETRY_BACKOFF_SECONDS) - 1)]
            time.sleep(backoff)
            retry_count += 1

        try:
            raw     = http_post(url, headers, payload, TIMEOUT_SECONDS)
            answer, thinking = parse_response(ptype, raw)
            total_ms = round((time.perf_counter() - t0) * 1000, 2)

            if mode == "vision":
                has_answer = "meow" in answer.lower()
            else:
                has_answer = bool(answer.strip())

            has_thinking = bool(thinking.strip())

            return {
                "provider_id":   provider["provider_id"],
                "provider_type": ptype,
                "model":         model,
                "mode":          mode,
                "success":       has_answer,
                "has_answer":    has_answer,
                "has_thinking":  has_thinking,
                "total_time_ms": total_ms,
                "error_type":    "",
                "retry_count":   retry_count,
            }
        except Exception as exc:
            last_exc = exc
            if not should_retry(exc):
                break

    total_ms   = round((time.perf_counter() - t0) * 1000, 2)
    error_type = classify_error(last_exc)
    return {
        "provider_id":   provider["provider_id"],
        "provider_type": ptype,
        "model":         model,
        "mode":          provider["mode"],
        "success":       False,
        "has_answer":    False,
        "has_thinking":  False,
        "total_time_ms": total_ms,
        "error_type":    error_type,
        "retry_count":   retry_count,
    }


# ── Tester loop ────────────────────────────────────────────────────────────────

def run_tester(
    worker: WorkerClient,
    providers: list[dict],
    run_id: str,
    checkpoint: dict,
) -> list[dict]:
    """
    Iterate all providers × models, resume from checkpoint if matching run_id.
    Returns list of scorecard items.
    """
    completed_set: set[str] = set(checkpoint.get("completed", []))
    items: list[dict] = []
    since_last_ck = 0

    for p_idx, provider in enumerate(providers):
        pid    = provider["provider_id"]
        models = fetch_models(provider)
        total  = len(models)
        print(f"\n[provider {p_idx+1}] {pid}  ({total} models)")

        for m_idx, model in enumerate(models):
            key = f"{pid}:{model}"
            if key in completed_set:
                print(f"  [{m_idx+1}/{total}] {model} — skipped (checkpoint)")
                continue

            print(f"  [{m_idx+1}/{total}] {model}", end="", flush=True)
            item = test_model(provider, model)
            items.append(item)
            completed_set.add(key)

            status = "ok" if item["success"] else f"fail({item['error_type'] or 'no_answer'})"
            think  = " +think" if item["has_thinking"] else ""
            print(f" → {status}{think}  {item['total_time_ms']}ms  retry={item['retry_count']}")

            since_last_ck += 1
            if since_last_ck >= CHECKPOINT_EVERY_N:
                ck = {
                    "run_id":    run_id,
                    "completed": list(completed_set),
                    "updated_at": now_iso(),
                }
                try:
                    worker.post_checkpoint(ck)
                except Exception as exc:
                    print(f"  [checkpoint write failed: {exc}]")
                since_last_ck = 0

    return items


# ── Benchmark ──────────────────────────────────────────────────────────────────

def run_benchmark(providers_by_id: dict[str, dict], scorecard_items: list[dict]) -> list[dict]:
    """Run 3 benchmark calls for each success model. Returns benchmark item list."""
    success_items = [i for i in scorecard_items if i["success"]]
    print(f"\n[benchmark] {len(success_items)} success models × {BENCHMARK_RUNS_PER_MODEL} runs")

    results: list[dict] = []

    for sc in success_items:
        pid    = sc["provider_id"]
        model  = sc["model"]
        provider = providers_by_id.get(pid)
        if not provider:
            continue
        if not is_benchmark_enabled(provider):
            continue

        mode   = provider["mode"]
        ptype  = provider["provider_type"]
        prompt = BENCHMARK_PROMPT_THINKING if mode == "thinking" else BENCHMARK_PROMPT_VISION
        url, headers, payload = build_request(provider, model, prompt)

        print(f"  {pid}:{model}", end="", flush=True)
        runs: list[dict] = []

        for ri in range(BENCHMARK_RUNS_PER_MODEL):
            t0 = time.perf_counter()
            try:
                raw = http_post(url, headers, payload, TIMEOUT_SECONDS)
                answer, _ = parse_response(ptype, raw)
                total_ms  = round((time.perf_counter() - t0) * 1000, 2)
                output_chars = len(answer.strip())
                runs.append({"run_index": ri, "total_time_ms": total_ms, "ttft_ms": None, "output_chars": output_chars})
                print(f" {total_ms}ms", end="", flush=True)
            except Exception as exc:
                total_ms = round((time.perf_counter() - t0) * 1000, 2)
                runs.append({"run_index": ri, "total_time_ms": total_ms, "ttft_ms": None, "output_chars": 0,
                              "error": classify_error(exc)})
                print(f" err({classify_error(exc)})", end="", flush=True)

        valid_times = [r["total_time_ms"] for r in runs if "error" not in r]
        avg = round(sum(valid_times) / len(valid_times), 2) if valid_times else None
        print(f"  avg={avg}ms")

        results.append({
            "provider_id":     pid,
            "model":           model,
            "runs":            runs,
            "avg_total_time_ms": avg,
        })

    return results


# ── Build final payload ────────────────────────────────────────────────────────

def build_results(run_id: str, started_at: str, items: list[dict], benchmark: list[dict]) -> dict:
    # Sort: success first, then by total_time_ms asc, then provider_id+model lex
    def sort_key(i: dict):
        return (0 if i["success"] else 1, i["total_time_ms"] if i["success"] else 0, i["provider_id"] + i["model"])

    sorted_items = sorted(items, key=sort_key)
    total   = len(sorted_items)
    success = sum(1 for i in sorted_items if i["success"])
    finished_at = now_iso()

    scorecard = {
        "run_id":      run_id,
        "started_at":  started_at,
        "finished_at": finished_at,
        "items":       sorted_items,
        "summary":     {"total": total, "success": success, "failed": total - success},
    }

    bm_payload = {
        "run_id": run_id,
        "items":  benchmark,
    }

    return {
        "run_id":      run_id,
        "started_at":  started_at,
        "finished_at": finished_at,
        "scorecard":   scorecard,
        "benchmark":   bm_payload,
    }


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> int:
    worker_url = os.environ.get("WORKER_API_URL", "").strip()
    token      = os.environ.get("MASTER_API_TOKEN", "").strip()

    if not worker_url or not token:
        print("[error] WORKER_API_URL and MASTER_API_TOKEN env vars are required")
        return 1

    worker     = WorkerClient(worker_url, token)
    run_id     = generate_run_id()
    started_at = now_iso()
    print(f"run_id={run_id}  started_at={started_at}")

    # 1. Fetch config
    try:
        config = worker.get_config()
    except Exception as exc:
        print(f"[error] GET /api/config failed: {exc}")
        return 1

    providers: list[dict] = config.get("providers") or []
    if not providers:
        print("[error] No providers in config")
        return 1

    print(f"Providers: {[p['provider_id'] for p in providers]}")
    for p in providers:
        print(f"  {p['provider_id']}  key={mask_key(p.get('api_key',''))}")

    # 2. Fetch checkpoint
    checkpoint: dict = {}
    try:
        ck = worker.get_checkpoint()
        if ck.get("exists") is not False and ck.get("run_id") == run_id:
            checkpoint = ck
            print(f"Resuming checkpoint: {len(checkpoint.get('completed', []))} models already done")
        elif ck.get("run_id") and ck.get("run_id") != run_id:
            print(f"Checkpoint run_id mismatch ({ck.get('run_id')}) — starting fresh")
    except Exception as exc:
        print(f"[warn] GET /api/checkpoint failed: {exc} — starting fresh")

    # 3. Run tester
    items = run_tester(worker, providers, run_id, checkpoint)

    # 4. Run benchmark
    providers_by_id = {p["provider_id"]: p for p in providers}
    benchmark = run_benchmark(providers_by_id, items)

    # 5. Build and upload results
    payload = build_results(run_id, started_at, items, benchmark)
    print(f"\nUploading results: scorecard={len(items)} items, benchmark={len(benchmark)} items")
    try:
        worker.post_results(payload)
    except Exception as exc:
        print(f"[error] POST /api/results failed: {exc}")
        return 1

    # 6. Clear checkpoint
    try:
        worker.delete_checkpoint()
    except Exception as exc:
        print(f"[warn] DELETE /api/checkpoint failed: {exc}")

    sc = payload["scorecard"]["summary"]
    print(f"\nDone. total={sc['total']} success={sc['success']} failed={sc['failed']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
