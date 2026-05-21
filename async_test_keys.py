import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict

import aiohttp

# ================= 配置区 =================

# ─── 1. 本地测试 Fallback 设定 (仅在未设置 PAGES_URL 环境变量时生效) ───
# 当你在自己电脑上直接执行此脚本时，会读取以下档案与固定一个 API 端点进行测试。
# 如果是透过 GitHub Actions 触发 (设定了 PAGES_URL)，以下 6 行设定将「被完全忽略」，
# 程式会自动去远端抓取你在 UI 上设定的所有服务商 (Providers) 并逐一进行测试。
INPUT_FILE_PATH = r"valid_keys\keys.txt"
MODELS_FILE_PATH = r"models_list\models.txt"
OUTPUT_JSON_PATH = "async_test_results.json"
CHECKPOINT_PATH = "checkpoint.json"
API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
PROVIDER_TYPE = "openai"  # 支援: 'openai', 'ollama', 'gemini'

# ─── 2. 全局执行参数 (云端端与本地端皆会套用) ───
# 这些参数无论在本地运行还是云端运行都会生效，用来控制程式的运作效能与测试基准。
MAX_CONCURRENCY = 40
STREAM_TIMEOUT = 10.0
NON_STREAM_TIMEOUT = 15.0
CHECKPOINT_EVERY_N_TASKS = 20
PROMPT = "What is 17 multiplied by 19? Think step by step."

# ─── 3. 云端集成 (由 GitHub Actions 通过环境变量注入，本地开发请留空) ───
PAGES_URL = os.environ.get("PAGES_URL", "").strip().rstrip("/")
ADMIN_TOKEN = os.environ.get("ADMIN_PASSWORD", "").strip()

# ==========================================


def _pages_request(method: str, path: str, body=None):
    """轻量同步 HTTP 助手，仅用于脚本首尾的 Pages API 调用。"""
    url = f"{PAGES_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Bearer {ADMIN_TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "async-test-keys/2.0",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Pages API {method} {path} -> HTTP {e.code}: {e.read().decode()[:300]}"
        ) from e


def extract_think_xml(text):
    think = ""
    m = re.search(r"<think>(.*?)</think>", text, flags=re.DOTALL)
    if m:
        think = m.group(1).strip()
        text = re.sub(r"<think>.*?</think>\n?", "", text, flags=re.DOTALL).strip()
    return text, think


def get_full_endpoint(api_base, provider_type, model):
    base = api_base.rstrip("/")
    if provider_type == "openai":
        return f"{base}/chat/completions"
    elif provider_type == "ollama":
        return f"{base}/api/chat"
    elif provider_type == "gemini":
        return f"{base}/models/{model}:streamGenerateContent?alt=sse"
    return base


def build_payload(provider_type, model, stream):
    if provider_type == "openai":
        return {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 512,
            "stream": stream,
        }
    elif provider_type == "ollama":
        return {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "options": {"num_predict": 512},
            "stream": stream,
        }
    elif provider_type == "gemini":
        return {
            "contents": [{"role": "user", "parts": [{"text": PROMPT}]}],
            "generationConfig": {"maxOutputTokens": 512},
        }
    return {}


async def parse_stream(response, provider_type):
    first_chunk_time = None
    has_content = False
    has_thinking = False
    content_buf = []  # 拼接正文 token
    thinking_buf = []  # 拼接思考 token

    async for line in response.content:
        line = line.decode("utf-8").strip()
        if not line:
            continue

        if provider_type in ("openai", "gemini"):
            if not line.startswith("data:"):
                continue
            line = line[5:].strip()
            if line == "[DONE]":
                continue

        try:
            data = json.loads(line)
        except:
            continue

        if provider_type == "openai":
            choices = data.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                # 任务 6：用 or "" 防御 content: null
                content = delta.get("content") or ""
                reasoning = (delta.get("reasoning_content") or "") or (
                    delta.get("thinking") or ""
                )
                if content or reasoning:
                    if first_chunk_time is None:
                        first_chunk_time = time.perf_counter()
                    if content:
                        has_content = True
                        content_buf.append(content)
                    if reasoning:
                        has_thinking = True
                        thinking_buf.append(reasoning)

        elif provider_type == "ollama":
            msg = data.get("message", {})
            content = msg.get("content") or ""
            thinking = msg.get("thinking") or ""
            if content or thinking:
                if first_chunk_time is None:
                    first_chunk_time = time.perf_counter()
                if content:
                    has_content = True
                    content_buf.append(content)
                if thinking:
                    has_thinking = True
                    thinking_buf.append(thinking)

        elif provider_type == "gemini":
            candidates = data.get("candidates", [])
            for c in candidates:
                parts = c.get("content", {}).get("parts", [])
                for p in parts:
                    text = p.get("text") or ""
                    # 任务 5：思考 chunk 也更新 first_chunk_time
                    is_thought = bool(p.get("thought") or p.get("thoughtSignature"))
                    if text or is_thought:
                        if first_chunk_time is None:
                            first_chunk_time = time.perf_counter()
                    if is_thought:
                        has_thinking = True
                        if text:
                            thinking_buf.append(text)
                    elif text:
                        has_content = True
                        content_buf.append(text)

    sample_content = "".join(content_buf).strip()
    sample_thinking = "".join(thinking_buf).strip()
    return first_chunk_time, has_content, has_thinking, sample_content, sample_thinking


async def test_single_request(session, key, model, stream, provider_type, api_base):
    headers = {"Content-Type": "application/json", "User-Agent": "async-tester/1.0"}
    if provider_type == "gemini":
        headers["x-goog-api-key"] = key
    else:
        headers["Authorization"] = f"Bearer {key}"

    payload = build_payload(provider_type, model, stream)
    timeout = aiohttp.ClientTimeout(
        total=STREAM_TIMEOUT if stream else NON_STREAM_TIMEOUT
    )

    start_t = time.perf_counter()
    ttft = None
    has_content = False
    has_thinking = False
    sample_content = ""
    sample_thinking = ""

    endpoint = get_full_endpoint(api_base, provider_type, model)

    try:
        async with session.post(
            endpoint, json=payload, headers=headers, timeout=timeout
        ) as resp:
            status = resp.status
            if status != 200:
                body = await resp.text()
                return False, status, body, None, None, False, False, "", ""

            if stream and "text/event-stream" in resp.headers.get("Content-Type", ""):
                (
                    first_t,
                    has_content,
                    has_thinking,
                    sample_content,
                    sample_thinking,
                ) = await parse_stream(resp, provider_type)
                if first_t:
                    ttft = first_t - start_t
            else:
                body = await resp.text()
                try:
                    data = json.loads(body)
                    if provider_type == "openai":
                        msg = data.get("choices", [{}])[0].get("message", {})
                        sample_content = (msg.get("content") or "").strip()
                        reasoning = (msg.get("reasoning_content") or "") or (
                            msg.get("thinking") or ""
                        )
                        _, xml_think = extract_think_xml(sample_content)
                        sample_thinking = (reasoning or xml_think).strip()
                        has_thinking = bool(sample_thinking)
                        has_content = bool(sample_content)
                    elif provider_type == "ollama":
                        msg = data.get("message", {})
                        sample_content = (msg.get("content") or "").strip()
                        sample_thinking = (msg.get("thinking") or "").strip()
                        has_content = bool(sample_content)
                        has_thinking = bool(sample_thinking)
                    elif provider_type == "gemini":
                        candidates = data.get("candidates", [])
                        for c in candidates:
                            parts = c.get("content", {}).get("parts", [])
                            for p in parts:
                                text = p.get("text") or ""
                                is_thought = bool(
                                    p.get("thought") or p.get("thoughtSignature")
                                )
                                if is_thought:
                                    sample_thinking += text
                                    has_thinking = True
                                elif text:
                                    sample_content += text
                                    has_content = True
                        sample_content = sample_content.strip()
                        sample_thinking = sample_thinking.strip()
                except:
                    pass
                ttft = None  # Non-stream doesn't count TTFT

            total_t = time.perf_counter() - start_t
            # 任务 7：成功判定改为「正文不为空」
            success = has_content
            return (
                success,
                status,
                "",
                ttft,
                total_t,
                has_thinking,
                has_content,
                sample_content,
                sample_thinking,
            )

    except asyncio.TimeoutError:
        return False, 408, "Timeout", None, None, False, False, "", ""
    except Exception as e:
        return False, 500, str(e), None, None, False, False, "", ""


async def benchmark_model(session, key, model, provider_type, api_base, dead_keys=None):
    # 在发起请求前，再次检查当前 Key 是否已断状态
    # 应对并发情况：可能有 worker 已处理断点，此协程才刚被调度执行
    if dead_keys is not None and key in dead_keys:
        return False, -1, "Key already dead (skipped)", None, None, False, False, "", ""

    # 追踪最佳数据（取最后一次成功的）
    final_sample_content = ""
    final_sample_thinking = ""
    final_has_content = False
    final_has_thinking = False
    # 惩罚时间追踪
    penalty_time = 0.0
    first_status = None

    # 闭包：内部绑定参数传给 test_single_request 拿 9 个返回值 元组
    async def _run(stream):
        return await test_single_request(session, key, model, stream=stream, provider_type=provider_type, api_base=api_base)

    # 1. 优先尝试流式 (第一次测试)
    (
        success,
        status,
        err,
        ttft,
        total_t,
        has_thinking,
        has_content,
        s_content,
        s_thinking,
    ) = await _run(True)
    first_status = status
    is_stream = True

    # 2. 如果流式报错（非权限/限流/超时问题），降级非流式
    #    408/429 不在此处降级，留给触发式重试分支处理
    if not success and status not in (401, 403, 404, 400, 429, 408):
        penalty_time += total_t if total_t else STREAM_TIMEOUT
        (
            success,
            status,
            err,
            ttft,
            total_t,
            has_thinking,
            has_content,
            s_content,
            s_thinking,
        ) = await _run(False)
        is_stream = False

    if success:
        final_has_content = has_content
        final_has_thinking = has_thinking
        final_sample_content = s_content
        final_sample_thinking = s_thinking

    # 3. 仅当第一次测试遇到 429 或 408 时，才触发第二次跑测机制
    if first_status in (429, 408):
        penalty_time += total_t if total_t else STREAM_TIMEOUT
        await asyncio.sleep(2)
        (
            success,
            status,
            err,
            ttft,
            total_t,
            has_thinking,
            has_content,
            s_content,
            s_thinking,
        ) = await _run(True)
        is_stream = True

        if not success and status not in (401, 403, 404, 400, 429, 408):
            penalty_time += total_t if total_t else STREAM_TIMEOUT
            (
                success,
                status,
                err,
                ttft,
                total_t,
                has_thinking,
                has_content,
                s_content,
                s_thinking,
            ) = await _run(False)
            is_stream = False

        if success and not final_has_content:
            final_has_content = has_content
            final_has_thinking = has_thinking
            final_sample_content = s_content
            final_sample_thinking = s_thinking

    # 汇总结果
    if success:
        avg_ttft = round(ttft, 3) if (ttft is not None and is_stream) else None
        avg_total = round((total_t or 0) + penalty_time, 3)
        return (
            True,
            200,
            "",
            avg_ttft,
            avg_total,
            final_has_thinking,
            final_has_content,
            final_sample_content,
            final_sample_thinking,
        )
    else:
        return False, status, err, None, None, False, False, "", ""


async def main():
    global_start_time = time.perf_counter()
    provider_type = PROVIDER_TYPE
    api_base = API_BASE

    # ── 读取 keys 和 models ──────────────────────────────────────────────
    if PAGES_URL and ADMIN_TOKEN:
        # 从 Pages KV 读取（GHA 模式）
        print(f"[Pages] 从 {PAGES_URL}/api/settings 读取设定...")
        try:
            resp = _pages_request("GET", "/api/settings")
            settings = resp.get("settings") or {}
            
            # 读取第一个 provider 进行测试 (日后可扩展成回圈跑所有 provider)
            providers = settings.get("providers", [])
            if not providers:
                return print("[错误] 远端设定中没有任何服务商 (Providers)。")
            
            first_p = providers[0]
            api_base = first_p.get("api_base", "").strip().rstrip("/")
            provider_type = first_p.get("provider_type", "openai")
            raw_keys = first_p.get("keys", "")
            raw_models = first_p.get("models", "")
            
        except Exception as e:
            return print(f"[错误] 无法从 Pages 读取设定: {e}")

        keys = [line.strip() for line in raw_keys.splitlines() if line.strip()]
        models = [m.strip() for m in raw_models.split(",") if m.strip()]
    else:
        # 本地文件 fallback
        if not os.path.exists(INPUT_FILE_PATH):
            return print(f"找不到 {INPUT_FILE_PATH}")
        if not os.path.exists(MODELS_FILE_PATH):
            return print(f"找不到 {MODELS_FILE_PATH}")
        with open(INPUT_FILE_PATH, "r", encoding="utf-8") as f:
            keys = [line.strip() for line in f if line.strip()]
        with open(MODELS_FILE_PATH, "r", encoding="utf-8") as f:
            models = [m.strip() for m in f.read().split(",") if m.strip()]

    if not keys:
        return print("[错误] 没有可用的 API Key，请先在设定页面填入。")
    if not models:
        return print("[错误] 没有可用的模型，请先在设定页面填入。")

    print(f"载入 {len(keys)} 个 Key，{len(models)} 个模型。准备测试...")

    # State tracking（须在 Load Checkpoint 之前声明，checkpoint 恢复时会写入 dead_keys）
    dead_keys = set()
    model_timeout_stats = defaultdict(int)  # 各模型超时/限流次数
    model_test_counts = defaultdict(int)  # 各模型实际发出请求次数（用于计算超时率）
    tasks_done_since_ckpt = 0

    # Load Checkpoint
    results = {}
    completed_pairs = set()
    if os.path.exists(CHECKPOINT_PATH):
        try:
            with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
                ckpt = json.load(f)
                results = ckpt.get("results", {})
                for k, v in results.items():
                    for item in v:
                        # 只跳过成功的 pair；失败的（429/超时/供应商错误）重新跑
                        # 例外：403/401 是 Key 级硬伤，直接把该 Key 加入 dead_keys，全部跳过
                        if item.get("success"):
                            completed_pairs.add(f"{k}::{item['model']}")
                        elif item.get("status") in (401, 403):
                            dead_keys.add(k)
                # 清理 results 中的失败记录，避免重跑后出现重复条目
                for k in results:
                    results[k] = [item for item in results[k] if item.get("success")]
            print(
                f"已恢复进度: {len(completed_pairs)} 个成功测试项，{len(dead_keys)} 个死 Key"
            )
        except:
            pass

    task_queue = asyncio.Queue()
    for key in keys:
        for model in models:
            if f"{key}::{model}" not in completed_pairs:
                task_queue.put_nowait((key, model))

    total_in_queue = task_queue.qsize()
    processed_count = 0

    async def worker(session):
        nonlocal tasks_done_since_ckpt, processed_count
        while True:
            try:
                key, model = task_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

            processed_count += 1
            masked = f"{key[:6]}...{key[-4:]}" if len(key) > 10 else "***"

            if key in dead_keys:
                task_queue.task_done()
                continue

            print(f"[{processed_count}/{total_in_queue}] 测试 {masked} -> {model}")

            (
                success,
                status,
                err,
                ttft,
                total,
                has_thinking,
                has_content,
                sample_content,
                sample_thinking,
            ) = await benchmark_model(session, key, model, provider_type=provider_type, api_base=api_base, dead_keys=dead_keys)

            # 熔断二次拦截：benchmark_model 入口检测到已死 Key，直接跳过，不写 results
            if status == -1:
                task_queue.task_done()
                continue

            if key not in results:
                results[key] = []

            record = {
                "model": model,
                "success": success,
                "status": status,
                "error": err[:100],
                "avg_ttft": ttft,
                "avg_total": total,
                "has_thinking": has_thinking,
                "has_content": has_content,
                "sample_content": sample_content,
                "sample_thinking": sample_thinking,
            }
            results[key].append(record)

            # Circuit Breaker：只有明确的 Key 权限错误 (401/403) 或余额/配额提示才判死
            if (
                status in (401, 403)
                or "balance" in err.lower()
                or "quota" in err.lower()
            ):
                reason = f"HTTP {status}" if status not in (401, 403) else str(status)
                print(f"[熔断] {masked} 触发 {reason}，判定为死 Key。")
                dead_keys.add(key)

            # 记录模型测试次数与超时统计（供报表参考，不触发熔断）
            model_test_counts[model] += 1
            if status in (429, 408):
                model_timeout_stats[model] += 1

            tasks_done_since_ckpt += 1
            if tasks_done_since_ckpt >= CHECKPOINT_EVERY_N_TASKS:
                ckpt_data = {
                    "provider_type": provider_type,
                    "api_base": api_base,
                    "total_tasks": total_in_queue,
                    "completed_tasks": processed_count,
                    "dead_keys": list(dead_keys),
                    "results": results
                }
                with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
                    json.dump(ckpt_data, f, ensure_ascii=False)
                if PAGES_URL and ADMIN_TOKEN:
                    try: _pages_request("POST", "/api/checkpoint", ckpt_data)
                    except: pass
                tasks_done_since_ckpt = 0

            task_queue.task_done()

    # Run Event Loop
    async with aiohttp.ClientSession() as session:
        workers = [asyncio.create_task(worker(session)) for _ in range(MAX_CONCURRENCY)]
        await asyncio.gather(*workers)

    # Final Checkpoint Save
    ckpt_data = {
        "provider_type": provider_type,
        "api_base": api_base,
        "total_tasks": total_in_queue,
        "completed_tasks": processed_count,
        "dead_keys": list(dead_keys),
        "results": results
    }
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump(ckpt_data, f, ensure_ascii=False)
    if PAGES_URL and ADMIN_TOKEN:
        try: _pages_request("POST", "/api/checkpoint", ckpt_data)
        except: pass

    print("\n--- 并发测试结束，开始交叉验证(Cross-Key Validation) ---")

    # Post Processing
    proven_working_models = set()
    # 模型维度统计结构
    model_perf = defaultdict(
        lambda: {
            "ttft": [],
            "total": [],
            "thinking_count": 0,  # 有思考的成功请求数
            "thinking_only": 0,  # 有思考但无正文的请求数
            "sample": None,  # 第一次成功时的样本（只存一次）
        }
    )
    valid_keys = []

    for k, records in results.items():
        for r in records:
            m = r["model"]
            if r["success"]:
                proven_working_models.add(m)
                if r["avg_ttft"] is not None:
                    model_perf[m]["ttft"].append(r["avg_ttft"])
                if r["avg_total"] is not None:
                    model_perf[m]["total"].append(r["avg_total"])
                if r.get(
                    "has_thinking"
                ):  # 旧 checkpoint 无此字段时安全返回 None（等价 False）
                    model_perf[m]["thinking_count"] += 1
                # 每个模型只存第一次成功的 sample
                if model_perf[m]["sample"] is None:
                    model_perf[m]["sample"] = {
                        "thinking": r.get("sample_thinking", ""),
                        "content": r.get("sample_content", ""),
                    }
            else:
                # 有思考但无正文（HTTP 200 但 has_content=False）
                # 注：旧 checkpoint 无 has_thinking/has_content 字段时，get() 返回 None，不会崩但会漏计
                if r.get("has_thinking") and not r.get("has_content"):
                    model_perf[m]["thinking_only"] += 1

    invalid_output = []

    for k, records in results.items():
        key_all_failed = True
        hard_failure_reason = None
        key_errors = []

        for r in records:
            model = r["model"]
            if r["success"]:
                key_all_failed = False
            else:
                status = r["status"]
                reason = "Unknown Error"
                if status in (401, 403):
                    hard_failure_reason = f"Key 专属硬伤 (Hard Failure - {status})"
                    reason = hard_failure_reason
                elif status in (400, 404):
                    reason = f"模型不支持或不存在 ({status})"
                elif status in (429, 408):
                    reason = f"频控限流或响应超时 (Rate Limit / Timeout - {status})"
                elif model in proven_working_models:
                    reason = f"该 Key 调不通，但其他 Key 证明模型健康 (Key Specific Error - {status})"
                key_errors.append(f"{model}: {reason}")

        # 结算这把 Key
        if key_all_failed:
            tested_models = [r["model"] for r in records]
            if hard_failure_reason:
                final_reason = hard_failure_reason
            elif any(m in proven_working_models for m in tested_models):
                final_reason = (
                    "全盘软失效 (测试的所有模型均失败，但部分模型被其他Key证实健康)"
                )
            else:
                final_reason = "全部模型皆无响应 (无法断定是Key的问题，因全网皆败)"

            entry = {"api_key": k, "error_reason": final_reason}
            # 401/403 硬伤死因已自明，不需要重复列模型详情
            if not hard_failure_reason:
                entry["failed_models_details"] = key_errors
            invalid_output.append(entry)
        else:
            valid_keys.append(k)

    # 模型维度汇总：proven 模型 + 有超时记录的模型都纳入
    all_perf_models = proven_working_models | set(model_timeout_stats.keys())
    model_stats = {}
    for m in sorted(all_perf_models):
        perf = model_perf[m]
        ttft_list = perf["ttft"]
        total_list = perf["total"]
        sample_count = len(total_list)
        thinking_count = perf["thinking_count"]
        thinking_only = perf["thinking_only"]
        timeouts = model_timeout_stats[m]
        total_tested = model_test_counts[m]
        model_stats[m] = {
            "sample_count": sample_count,
            "thinking_only_count": thinking_only,
            "content_ever_seen": sample_count > 0,
            "has_thinking_ratio": round(thinking_count / sample_count, 3)
            if sample_count
            else None,
            "avg_ttft": round(sum(ttft_list) / len(ttft_list), 3)
            if ttft_list
            else None,
            "avg_total": round(sum(total_list) / len(total_list), 3)
            if total_list
            else None,
            "timeout_count": timeouts,
            "total_tested": total_tested,
            "timeout_rate": round(timeouts / total_tested, 3) if total_tested else None,
            "sample": perf["sample"],
        }

    # 无效模型 = 全部模型 - proven
    failed_models = sorted(set(models) - proven_working_models)

    final_report = {
        "provider_type": provider_type,
        "api_base": api_base,
        "valid_keys": sorted(valid_keys),
        "invalid_records": invalid_output,
        "proven_working_models": sorted(proven_working_models),
        "failed_models": failed_models,
        "model_performance": model_stats,
    }

    with open(OUTPUT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(final_report, f, indent=4, ensure_ascii=False)

    global_end_time = time.perf_counter()
    total_elapsed_seconds = round(global_end_time - global_start_time, 2)
    print(
        f"\n处理完成！耗时 {total_elapsed_seconds} 秒。最终报表已保存至: {OUTPUT_JSON_PATH}"
    )

    # 上传到 Pages（GHA 模式）
    if PAGES_URL and ADMIN_TOKEN:
        print(f"[Pages] 上传结果到 {PAGES_URL}/api/results ...")
        try:
            _pages_request("POST", "/api/results", final_report)
            print("[Pages] 上传成功。")
        except Exception as e:
            print(f"[Pages] 上传失败（本地文件仍保留）: {e}")

    # 清理: 成功产出最终报表后，自动删除本地存档，避免下次执行时被当成恢复进度而全部跳过
    if os.path.exists(CHECKPOINT_PATH):
        try:
            os.remove(CHECKPOINT_PATH)
            print(f"已自动清理临时存档档: {CHECKPOINT_PATH}")
        except Exception as e:
            print(f"[警告] 无法删除临时存档档: {e}")


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n手动中断，当前进度已保存在 checkpoint.json 中。")
