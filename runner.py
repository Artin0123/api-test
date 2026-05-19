"""
runner.py

新的执行语义：
1. 从 Pages API 读取 providers_config（只接受手动 models_list）
2. 逐 provider 计算 provider_fingerprint
3. tester / benchmark 分开处理，各自使用自己的 checkpoint
4. checkpoint 不只记录进度，也记录已完成的部分结果，避免中断后只剩 completed 标记
5. 每个 provider 单独上传结果到 Pages API
"""

import hashlib
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


# 固定执行参数。这里继续保留「每 3 个模型写一次 checkpoint」的节奏。
TIMEOUT_SECONDS = 30
MAX_RETRIES = 1
RETRY_SLEEP_SECONDS = 1.0
BENCHMARK_RUNS_PER_MODEL = 3
CHECKPOINT_EVERY_N = 3
BENCHMARK_ERROR_PENALTY_MS = TIMEOUT_SECONDS * 1000
PREVIEW_CHARS = 100

TESTER_PROMPT_THINKING = "What is 17 multiplied by 19? Think step by step."
TESTER_PROMPT_VISION = "Describe this image in one word."
BENCHMARK_PROMPT_THINKING = "What is 17 multiplied by 19? Reply with the number only."
BENCHMARK_PROMPT_VISION = "Describe this image in one word."

VISION_IMAGE_MIME = "image/svg+xml"
VISION_IMAGE_B64 = (
    "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iNjAi"
    "IHZpZXdCb3g9IjAgMCAxNjAgNjAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9Indo"
    "aXRlIi8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9"
    "IjQwIiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iYmxhY2siIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWlu"
    "YW50LWJhc2VsaW5lPSJtaWRkbGUiPk1FT1c8L3RleHQ+PC9zdmc+"
)

DEFAULT_ENDPOINT_PATHS = {
    "openai": "/chat/completions",
    "ollama": "/api/chat",
    "gemini": "/models/{model}:streamGenerateContent?alt=sse",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def mask_key(v: str) -> str:
    if not v or len(v) <= 6:
        return "***"
    return f"{v[:4]}***{v[-2:]}"


def preview_text(v: Any, limit: int = PREVIEW_CHARS) -> str:
    if not isinstance(v, str):
        return ""
    normalized = " ".join(v.strip().split())
    if not normalized:
        return ""
    return normalized[:limit]


def generate_run_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    sfx = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{ts}_{sfx}"


def normalize_url(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


def normalize_api_base(value: str) -> str:
    return value.strip().rstrip("/")


def provider_key(provider: dict) -> str:
    return (
        f"{provider['provider_type']}::"
        f"{provider['mode']}::"
        f"{normalize_api_base(provider['api_base'])}"
    )


def build_provider_fingerprint(provider: dict) -> str:
    # fingerprint 只绑定 provider 身份，不绑定 api_key / models_list / 开关。
    payload = {
        "provider_type": provider["provider_type"],
        "mode": provider["mode"],
        "api_base": normalize_api_base(provider["api_base"]),
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def is_benchmark_enabled(provider: dict) -> bool:
    return bool(provider.get("benchmark_enabled", True))


def is_tester_enabled(provider: dict) -> bool:
    return bool(provider.get("tester_enabled", True))


class PagesClient:
    """和 Pages API 沟通的薄客户端。"""

    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.token = token

    def _req(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "api-tester/3.0 runner",
            "Cache-Control": "no-cache",
        }
        req = urllib_request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode())
        except error.HTTPError as exc:
            raise RuntimeError(
                f"Pages API {method} {path} -> HTTP {exc.code}: {exc.read().decode()[:400]}"
            ) from exc

    def get_config(self) -> dict:
        return self._req("GET", "/api/config?full=1")

    def get_checkpoint(self, stage: str, fingerprint: str) -> dict:
        return self._req(
            "GET", f"/api/checkpoint?stage={stage}&fingerprint={fingerprint}"
        )

    def post_checkpoint(self, stage: str, fingerprint: str, payload: dict) -> None:
        self._req(
            "POST",
            f"/api/checkpoint?stage={stage}&fingerprint={fingerprint}",
            payload,
        )

    def delete_checkpoint(self, stage: str, fingerprint: str) -> None:
        self._req(
            "DELETE", f"/api/checkpoint?stage={stage}&fingerprint={fingerprint}"
        )

    def get_results(self, provider_fingerprint: str) -> dict:
        return self._req("GET", f"/api/results?fingerprint={provider_fingerprint}")

    def post_results(self, payload: dict) -> None:
        self._req("POST", "/api/results", payload)


def extract_xml_think(content: str) -> tuple[str, str]:
    """支援某些模型把 reasoning 包在 <think>...</think> 里。"""
    thinks = re.findall(r"<think>(.*?)</think>", content, flags=re.DOTALL)
    thinking = "\n".join(t.strip() for t in thinks if t.strip())
    cleaned = re.sub(r"<think>.*?</think>\n?", "", content, flags=re.DOTALL).strip()
    return thinking, cleaned


def extract_reasoning_details(details: Any) -> str:
    if not isinstance(details, list):
        return ""
    parts: list[str] = []
    for detail in details:
        if not isinstance(detail, dict):
            continue
        reasoning = detail.get("reasoning")
        if isinstance(reasoning, dict):
            for key in ("summary", "text"):
                value = reasoning.get(key)
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
        for key in ("summary", "text", "content", "reasoning_content"):
            value = detail.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
    return "\n".join(parts).strip()


def parse_sse(raw: str) -> list[dict]:
    events: list[dict] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped.startswith("data:"):
            continue
        chunk = stripped[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            obj = json.loads(chunk)
            if isinstance(obj, dict):
                events.append(obj)
        except json.JSONDecodeError:
            continue
    return events


def openai_parse(raw: str) -> tuple[str, str]:
    answer = ""
    thinking = ""
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            message = ((data.get("choices") or [{}])[0]).get("message", {}) or {}
            answer = message.get("content", "") or ""
            thinking = (
                message.get("thinking")
                or message.get("reasoning_content")
                or extract_reasoning_details(message.get("reasoning_details"))
                or ""
            )

            if not answer and isinstance(data.get("output"), list):
                texts = []
                thinks = []
                for item in data["output"]:
                    if not isinstance(item, dict):
                        continue
                    for key in ("reasoning", "thinking", "summary"):
                        value = item.get(key)
                        if isinstance(value, str) and value.strip():
                            thinks.append(value.strip())
                    for content in item.get("content") or []:
                        if isinstance(content, dict):
                            text = content.get("text")
                            if isinstance(text, str) and text.strip():
                                texts.append(text)
                answer = "".join(texts).strip()
                thinking = thinking or "\n".join(thinks).strip()
    except json.JSONDecodeError:
        pass

    if not answer and not thinking:
        text_chunks = []
        think_chunks = []
        for event in parse_sse(raw):
            event_type = str(event.get("type", ""))
            if any(
                token in event_type
                for token in (
                    "response.reasoning.delta",
                    "response.thinking.delta",
                    "response.thought.delta",
                )
            ):
                for key in ("delta", "text", "reasoning", "summary", "content"):
                    value = event.get(key)
                    if isinstance(value, str) and value.strip():
                        think_chunks.append(value)
                        break
                    if isinstance(value, dict):
                        for subkey in ("text", "summary", "content"):
                            subvalue = value.get(subkey)
                            if isinstance(subvalue, str) and subvalue.strip():
                                think_chunks.append(subvalue)
                                break
            if event_type in {"response.output_text.delta", "response.message.delta"}:
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    text_chunks.append(delta)
        answer = "".join(text_chunks).strip()
        thinking = "".join(think_chunks).strip()

    xml_thinking, cleaned = extract_xml_think(answer)
    if xml_thinking and not thinking:
        thinking = xml_thinking
        answer = cleaned

    return answer, thinking


def ollama_parse(raw: str) -> tuple[str, str]:
    data = json.loads(raw)
    message = data.get("message", {}) or {}
    answer = message.get("content", "") or ""
    thinking = message.get("thinking", "") or ""
    if not thinking and answer:
        xml_thinking, cleaned = extract_xml_think(answer)
        if xml_thinking:
            thinking = xml_thinking
            answer = cleaned
    return answer, thinking


def gemini_parse(raw: str) -> tuple[str, str]:
    text_parts = []
    thinking_parts = []
    signatures = []
    for event in parse_sse(raw):
        for candidate in event.get("candidates") or []:
            content = candidate.get("content") or {}
            for part in content.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if isinstance(text, str):
                    if part.get("thought"):
                        thinking_parts.append(text)
                    else:
                        text_parts.append(text)
                signature = part.get("thoughtSignature")
                if isinstance(signature, str) and signature.strip():
                    signatures.append(signature[:16])
    answer = "".join(text_parts).strip()
    thinking = "\n".join(item for item in thinking_parts if item.strip()).strip()
    if signatures and not thinking:
        thinking = f"[thoughtSignature:{signatures[0]}...]"
    return answer, thinking


def parse_response(provider_type: str, raw: str) -> tuple[str, str]:
    if provider_type == "openai":
        return openai_parse(raw)
    if provider_type == "ollama":
        return ollama_parse(raw)
    return gemini_parse(raw)


class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status


def classify_error(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ApiError):
        status = exc.status
        if status == 401:
            return "unauthorized"
        if status == 403:
            return "forbidden"
        if status == 404:
            return "not_found"
        if status == 429:
            return "rate_limited"
        if status >= 500:
            return "server_error"
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
    req = urllib_request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        raise ApiError(exc.code, exc.read().decode("utf-8", errors="replace")) from exc


def build_request(provider: dict, model: str, prompt: str) -> tuple[str, dict, dict]:
    """依 provider_type 自动补固定 endpoint path。"""
    provider_type = provider["provider_type"]
    api_base = normalize_api_base(provider["api_base"])
    api_key = provider["api_key"]
    mode = provider["mode"]
    endpoint = DEFAULT_ENDPOINT_PATHS[provider_type]
    ua = "api-tester/3.0 runner"

    if provider_type == "openai":
        url = normalize_url(api_base, endpoint)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": ua,
        }
        if mode == "vision":
            content = [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{VISION_IMAGE_MIME};base64,{VISION_IMAGE_B64}"
                    },
                },
            ]
        else:
            content = prompt
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.2,
        }
        return url, headers, payload

    if provider_type == "ollama":
        url = normalize_url(api_base, endpoint)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": ua,
        }
        message: dict[str, Any] = {"role": "user", "content": prompt}
        if mode == "vision":
            message["images"] = [VISION_IMAGE_B64]
        payload = {"model": model, "messages": [message], "stream": False}
        return url, headers, payload

    path = endpoint.replace("{model}", model)
    url = normalize_url(api_base, path)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
        "User-Agent": ua,
        "Accept": "text/event-stream",
    }
    if mode == "vision":
        parts = [
            {"text": prompt},
            {
                "inline_data": {
                    "mime_type": VISION_IMAGE_MIME,
                    "data": VISION_IMAGE_B64,
                }
            },
        ]
    else:
        parts = [{"text": prompt}]
    payload = {"contents": [{"role": "user", "parts": parts}]}
    return url, headers, payload


def test_model(provider: dict, model: str) -> dict:
    """执行 tester 单次模型测试，保留 preview 资料供前端显示。"""
    mode = provider["mode"]
    prompt = TESTER_PROMPT_THINKING if mode == "thinking" else TESTER_PROMPT_VISION
    provider_type = provider["provider_type"]
    url, headers, payload = build_request(provider, model, prompt)

    last_exc: Exception | None = None
    retry_count = 0
    started = time.perf_counter()

    for attempt in range(MAX_RETRIES + 1):
        if attempt > 0:
            time.sleep(RETRY_SLEEP_SECONDS)
            retry_count += 1
        try:
            raw = http_post(url, headers, payload, TIMEOUT_SECONDS)
            answer, thinking = parse_response(provider_type, raw)
            total_ms = round((time.perf_counter() - started) * 1000, 2)

            if mode == "vision":
                has_answer = "meow" in answer.lower()
            else:
                has_answer = bool(answer.strip())

            return {
                "api_base": normalize_api_base(provider["api_base"]),
                "provider_type": provider_type,
                "model": model,
                "mode": mode,
                "success": has_answer,
                "has_answer": has_answer,
                "has_thinking": bool(thinking.strip()),
                "total_time_ms": total_ms,
                "error_type": "",
                "retry_count": retry_count,
                "answer_preview": preview_text(answer),
                "thinking_preview": preview_text(thinking),
                "error_message_preview": "",
            }
        except Exception as exc:
            last_exc = exc
            if not should_retry(exc):
                break

    total_ms = round((time.perf_counter() - started) * 1000, 2)
    return {
        "api_base": normalize_api_base(provider["api_base"]),
        "provider_type": provider_type,
        "model": model,
        "mode": mode,
        "success": False,
        "has_answer": False,
        "has_thinking": False,
        "total_time_ms": total_ms,
        "error_type": classify_error(last_exc) if last_exc else "unexpected_error",
        "retry_count": retry_count,
        "answer_preview": "",
        "thinking_preview": "",
        "error_message_preview": preview_text(str(last_exc) if last_exc else ""),
    }


def benchmark_model(provider: dict, model: str) -> list[dict]:
    """执行 benchmark 多轮。注意：这里回传 runs，方便 checkpoint 持续累积。"""
    mode = provider["mode"]
    provider_type = provider["provider_type"]
    prompt = (
        BENCHMARK_PROMPT_THINKING if mode == "thinking" else BENCHMARK_PROMPT_VISION
    )
    url, headers, payload = build_request(provider, model, prompt)
    runs: list[dict] = []

    for run_index in range(BENCHMARK_RUNS_PER_MODEL):
        started = time.perf_counter()
        try:
            raw = http_post(url, headers, payload, TIMEOUT_SECONDS)
            answer, _ = parse_response(provider_type, raw)
            total_ms = round((time.perf_counter() - started) * 1000, 2)
            runs.append(
                {
                    "run_index": run_index,
                    "total_time_ms": total_ms,
                    "ttft_ms": None,
                    "output_chars": len(answer.strip()),
                }
            )
        except Exception as exc:
            total_ms = round((time.perf_counter() - started) * 1000, 2)
            runs.append(
                {
                    "run_index": run_index,
                    "total_time_ms": total_ms,
                    "ttft_ms": None,
                    "output_chars": 0,
                    "error": classify_error(exc),
                }
            )
    return runs


def compute_benchmark_average(runs: list[dict]) -> float | None:
    penalized_times = [
        (
            BENCHMARK_ERROR_PENALTY_MS
            if "error" in run
            else min(float(run["total_time_ms"]), BENCHMARK_ERROR_PENALTY_MS)
        )
        for run in runs
    ]
    if not penalized_times:
        return None
    return round(sum(penalized_times) / len(penalized_times), 2)


def build_tester_payload(
    run_id: str, started_at: str, finished_at: str, items: list[dict]
) -> dict:
    def sort_key(item: dict):
        return (
            0 if item["success"] else 1,
            item["total_time_ms"] if item["success"] else 0,
            item["api_base"] + item["model"],
        )

    sorted_items = sorted(items, key=sort_key)
    total = len(sorted_items)
    success = sum(1 for item in sorted_items if item["success"])
    return {
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": finished_at,
        "items": sorted_items,
        "summary": {"total": total, "success": success, "failed": total - success},
    }


def build_benchmark_payload(run_id: str, items: list[dict]) -> dict:
    sorted_items = sorted(
        items,
        key=lambda item: (
            item["avg_total_time_ms"] if item["avg_total_time_ms"] is not None else float("inf"),
            item["api_base"] + item["model"],
        ),
    )
    return {
        "run_id": run_id,
        "items": sorted_items,
    }


def checkpoint_model_key(model: str) -> str:
    return model


def build_tester_checkpoint(run_id: str, started_at: str, items: list[dict]) -> dict:
    # 这里明确把 partial items 一起存进去，续跑时不用重跑已完成模型。
    completed_models = sorted(item["model"] for item in items)
    return {
        "run_id": run_id,
        "started_at": started_at,
        "completed_models": completed_models,
        "items": items,
    }


def build_benchmark_checkpoint(
    run_id: str,
    source_tester_run_id: str | None,
    items: list[dict],
) -> dict:
    completed_models = sorted(item["model"] for item in items)
    return {
        "run_id": run_id,
        "source_tester_run_id": source_tester_run_id,
        "completed_models": completed_models,
        "items": items,
    }


def write_checkpoint_every_n(
    pages: PagesClient,
    stage: str,
    fingerprint: str,
    payload_builder,
    flush_counter: int,
) -> int:
    if flush_counter < CHECKPOINT_EVERY_N:
        return flush_counter
    pages.post_checkpoint(stage, fingerprint, payload_builder())
    return 0


def run_tester_for_provider(
    pages: PagesClient,
    provider: dict,
    run_id: str,
    provider_fingerprint: str,
) -> dict | None:
    """逐 provider 执行 tester，并把部分结果持续写进 checkpoint。"""
    models = provider.get("models_list") or []
    if not models:
        print("  [skip] models_list 为空")
        return None

    checkpoint_items: list[dict] = []
    completed_models: set[str] = set()
    started_at = now_iso()

    checkpoint = {}
    try:
        checkpoint = pages.get_checkpoint("tester", provider_fingerprint)
    except Exception as exc:
        print(f"  [warn] GET tester checkpoint failed: {exc}")

    if checkpoint.get("exists") is True:
        checkpoint_items = list(checkpoint.get("items") or [])
        completed_models = {item.get("model", "") for item in checkpoint_items if item.get("model")}
        started_at = checkpoint.get("started_at") or started_at
        print(f"  [resume] tester checkpoint models={len(completed_models)}")

    items = checkpoint_items[:]
    since_last_checkpoint = 0

    def checkpoint_payload() -> dict:
        return build_tester_checkpoint(run_id, started_at, items)

    for index, model in enumerate(models, start=1):
        model_key = checkpoint_model_key(model)
        if model_key in completed_models:
            print(f"  [{index}/{len(models)}] {model} -> skipped (checkpoint)")
            continue

        print(f"  [{index}/{len(models)}] {model}", end="", flush=True)
        item = test_model(provider, model)
        items.append(item)
        completed_models.add(model_key)
        status = "ok" if item["success"] else f"fail ({item['error_type'] or 'no_answer'})"
        think = " (think)" if item["has_thinking"] else ""
        print(f" -> {status}{think} {item['total_time_ms']}ms retry={item['retry_count']}")

        since_last_checkpoint += 1
        if since_last_checkpoint >= CHECKPOINT_EVERY_N:
            try:
                pages.post_checkpoint(
                    "tester",
                    provider_fingerprint,
                    checkpoint_payload(),
                )
            except Exception as exc:
                print(f"  [warn] write tester checkpoint failed: {exc}")
            since_last_checkpoint = 0

    # 最后再落一次，避免少于 3 个模型的尾段没有存进去。
    try:
        pages.post_checkpoint("tester", provider_fingerprint, checkpoint_payload())
    except Exception as exc:
        print(f"  [warn] final tester checkpoint failed: {exc}")

    return build_tester_payload(run_id, started_at, now_iso(), items)


def load_tester_source_for_benchmark(
    pages: PagesClient,
    provider: dict,
    provider_fingerprint: str,
) -> dict:
    """
    benchmark 的模型来源：
    1. 若本次 tester 没跑，就从 latest_tester:{provider_fp} 读取
    2. 若本次 tester 已跑，就直接用本次 tester 结果
    """
    result = pages.get_results(provider_fingerprint)
    tester = result.get("tester")
    if not result.get("exists") or not tester or not (tester.get("items") or []):
        raise RuntimeError("该 provider_fingerprint 没有历史 tester 结果")
    return tester


def run_benchmark_for_provider(
    pages: PagesClient,
    provider: dict,
    provider_fingerprint: str,
    source_tester: dict,
    run_id: str,
) -> dict | None:
    """
    benchmark 也支援 checkpoint。
    checkpoint 直接保存已完成的 benchmark items，续跑时可无损恢复。
    """
    success_models = [
        item["model"]
        for item in (source_tester.get("items") or [])
        if item.get("success")
    ]
    if not success_models:
        print("  [skip] 没有 success tester models 可供 benchmark")
        return None

    checkpoint = {}
    try:
        checkpoint = pages.get_checkpoint("benchmark", provider_fingerprint)
    except Exception as exc:
        print(f"  [warn] GET benchmark checkpoint failed: {exc}")

    items = list(checkpoint.get("items") or []) if checkpoint.get("exists") is True else []
    completed_models = {item.get("model", "") for item in items if item.get("model")}
    if completed_models:
        print(f"  [resume] benchmark checkpoint models={len(completed_models)}")

    since_last_checkpoint = 0

    def checkpoint_payload() -> dict:
        return build_benchmark_checkpoint(
            run_id,
            source_tester.get("run_id"),
            items,
        )

    for index, model in enumerate(success_models, start=1):
        if model in completed_models:
            print(f"  [{index}/{len(success_models)}] {model} -> skipped (checkpoint)")
            continue

        print(f"  [{index}/{len(success_models)}] {model}", end="", flush=True)
        runs = benchmark_model(provider, model)
        avg = compute_benchmark_average(runs)
        items.append(
            {
                "api_base": normalize_api_base(provider["api_base"]),
                "provider_type": provider["provider_type"],
                "mode": provider["mode"],
                "model": model,
                "runs": runs,
                "avg_total_time_ms": avg,
            }
        )
        completed_models.add(model)
        print(f" -> avg={avg}ms")

        since_last_checkpoint += 1
        if since_last_checkpoint >= CHECKPOINT_EVERY_N:
            try:
                pages.post_checkpoint(
                    "benchmark",
                    provider_fingerprint,
                    checkpoint_payload(),
                )
            except Exception as exc:
                print(f"  [warn] write benchmark checkpoint failed: {exc}")
            since_last_checkpoint = 0

    try:
        pages.post_checkpoint("benchmark", provider_fingerprint, checkpoint_payload())
    except Exception as exc:
        print(f"  [warn] final benchmark checkpoint failed: {exc}")

    return build_benchmark_payload(run_id, items)


def upload_provider_results(
    pages: PagesClient,
    provider_fingerprint: str,
    tester_payload: dict | None,
    benchmark_payload: dict | None,
) -> None:
    payload = {"provider_fingerprint": provider_fingerprint}
    if tester_payload is not None:
        payload["tester"] = tester_payload
    if benchmark_payload is not None:
        payload["benchmark"] = benchmark_payload
    pages.post_results(payload)


def main() -> int:
    pages_url = os.environ.get("PAGES_URL", "").strip()
    token = os.environ.get("ADMIN_PASSWORD", "").strip()
    if not pages_url or not token:
        print("[error] PAGES_URL and ADMIN_PASSWORD env vars are required")
        return 1

    pages = PagesClient(pages_url, token)
    run_id = generate_run_id()
    print(f"run_id={run_id}")

    try:
        config = pages.get_config()
    except Exception as exc:
        print(f"[error] GET /api/config failed: {exc}")
        return 1

    providers = config.get("providers") or []
    if not providers:
        print("[error] No providers in config")
        return 1

    # 统一先做本地正规化，确保日志和 fingerprint 输入一致。
    for provider in providers:
        provider["api_base"] = normalize_api_base(provider["api_base"])

    print(f"Providers={len(providers)}")
    for provider in providers:
        print(
            f"  {provider_key(provider)} "
            f"tester={is_tester_enabled(provider)} "
            f"benchmark={is_benchmark_enabled(provider)} "
            f"models={len(provider.get('models_list') or [])} "
            f"key={mask_key(provider.get('api_key', ''))}"
        )

    if not any(is_tester_enabled(provider) or is_benchmark_enabled(provider) for provider in providers):
        print("[skip] Nothing to run")
        return 0

    any_failure = False

    for provider in providers:
        provider_id = provider_key(provider)
        provider_fingerprint = build_provider_fingerprint(provider)
        print(f"\n=== provider {provider_id} ===")
        print(f"fingerprint={provider_fingerprint[:16]}...")

        tester_payload: dict | None = None
        benchmark_payload: dict | None = None

        try:
            if is_tester_enabled(provider):
                tester_payload = run_tester_for_provider(
                    pages,
                    provider,
                    run_id,
                    provider_fingerprint,
                )
            else:
                print("  [info] tester disabled")

            if is_benchmark_enabled(provider):
                if tester_payload is not None:
                    source_tester = tester_payload
                else:
                    source_tester = load_tester_source_for_benchmark(
                        pages,
                        provider,
                        provider_fingerprint,
                    )

                benchmark_payload = run_benchmark_for_provider(
                    pages,
                    provider,
                    provider_fingerprint,
                    source_tester,
                    run_id,
                )
            else:
                print("  [info] benchmark disabled")

            if tester_payload is None and benchmark_payload is None:
                print("  [skip] 该 provider 没有可上传结果")
                continue

            upload_provider_results(
                pages,
                provider_fingerprint,
                tester_payload,
                benchmark_payload,
            )
            print("  [ok] uploaded results")

            # 上传成功后才清对应 stage 的 checkpoint。
            if tester_payload is not None:
                try:
                    pages.delete_checkpoint("tester", provider_fingerprint)
                except Exception as exc:
                    print(f"  [warn] DELETE tester checkpoint failed: {exc}")

            if benchmark_payload is not None:
                try:
                    pages.delete_checkpoint("benchmark", provider_fingerprint)
                except Exception as exc:
                    print(f"  [warn] DELETE benchmark checkpoint failed: {exc}")

        except Exception as exc:
            any_failure = True
            print(f"  [error] provider failed: {exc}")

    return 1 if any_failure else 0


if __name__ == "__main__":
    sys.exit(main())
