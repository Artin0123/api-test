import asyncio
import hashlib
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
PROVIDER_TYPE = "openai"  # 支援: 'openai', 'ollama', 'gemini', 'anthropic'
EXTRA_BODY_JSON = ""  # 选填，JSON 字符串，会合并覆盖请求体，例：'{"temperature": 0.7}'

# ─── 2. 全局执行参数 (云端端与本地端皆会套用) ───
# 这些参数无论在本地运行还是云端运行都会生效，用来控制程式的运作效能与测试基准。
MAX_CONCURRENCY = 2
TTFT_TIMEOUT = 5.0
TOTAL_TIMEOUT = 20.0
CHECKPOINT_EVERY_N_TASKS = 200
PROMPT = "What is 17 multiplied by 19? Think step by step."
# 生成上限（token）。调大会让话多的模型一直生成到 TOTAL_TIMEOUT 为止，
# 反而把本来会被截断收尾的模型判成逾时。
MAX_OUTPUT_TOKENS = 512
# 样本字元上限（content 与 thinking 各自计算）。这是给「吃不到 token 上限」的
# 情况用的安全网：代理商忽略不认得的参数、或推理 token 不计入上限时，
# 上面那个 512 形同虚设，只剩这里挡得住。超长就掐头留尾。
SAMPLE_MAX_LEN = 2048
# 服务商只有一支 Key 时，同一个 (Key, Model) 会连跑两轮；两轮之间的间隔秒数，
# 用来避免连续打同一支 Key 被判成限流。
SINGLE_KEY_RERUN_DELAY = 2.0

# ─── 3. 云端集成 (由 GitHub Actions 通过环境变量注入，本地开发请留空) ───
PAGES_URL = os.environ.get("PAGES_URL", "").strip().rstrip("/")
ADMIN_TOKEN = os.environ.get("ADMIN_PASSWORD", "").strip()

# ==========================================


def compute_fingerprint(api_base: str, provider_type: str) -> str:
    """与 _worker.js / app.js 中的 fingerprintPayload 保持完全一致。
    键名按字母序排列：api_base 在 provider_type 之前。"""
    payload = json.dumps(
        {"api_base": api_base.rstrip("/"), "provider_type": provider_type},
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _pages_request(method: str, path: str, body=None):
    """轻量同步 HTTP 助手，仅用于脚本首尾的 Pages API 调用。"""
    url = f"{PAGES_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Bearer {ADMIN_TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.152",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Pages API {method} {path} -> HTTP {e.code}: {e.read().decode()[:300]}"
        ) from e


ERROR_BODY_MAX_LEN = 512
REASON_MAX_LEN = 200


def parse_error_body(body):
    """解析供应商回传的错误 response body，提取结构化字段。

    覆盖 OpenAI / Gemini / Anthropic / 各类代理商格式；非 JSON（如 HTML 错误页）
    时 fallback 存原始文字，确保永远能显示供应商的真实说法。
    """
    if not body:
        return {}
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError, TypeError):
        return {"raw": body[:ERROR_BODY_MAX_LEN]}

    if not isinstance(data, dict):
        return {"raw": body[:ERROR_BODY_MAX_LEN]}

    detail = {}
    # OpenAI/Anthropic 包在 error 里，其他供应商可能直接摊在顶层
    error_obj = data.get("error")
    if not isinstance(error_obj, dict):
        error_obj = data
    for key in ("message", "msg", "type", "code", "param", "status"):
        val = error_obj.get(key)
        if val is not None and not isinstance(val, (dict, list)):
            # 逐栏截断：body 本身不设限，但单一栏位不让它无限膨胀 KV
            detail[key] = str(val)[:ERROR_BODY_MAX_LEN]

    return detail if detail else {"raw": body[:ERROR_BODY_MAX_LEN]}


# 讯息里会逐支 Key / 逐次请求变动的片段：Key 本体、遮罩尾码、hex id、任何数字。
# 必须与 app.js 的 normalizeMessage() 输出完全一致，因此有两个限制：
#   - 不用 \b 和 \d：Python 的 \w/\d 认得 CJK 与全形数字，JS 的只认 ASCII。
#   - 不用 lookbehind：Safari 16.4 以下会直接语法错误，改用捕获前导字元。
_VARIABLE_FRAGMENTS = (
    (re.compile(r"(^|[^a-z0-9])(?:sk|gsk|api|key)[-_][a-z0-9_\-*]{3,}"), r"\1<key>"),
    (re.compile(r"\*{2,}[a-z0-9]+"), "<key>"),
    (re.compile(r"(^|[^a-z0-9])[0-9a-f]{8,}(?![a-z0-9])"), r"\1<id>"),
    (re.compile(r"[0-9０-９]+"), "<n>"),
)


def normalize_message(msg):
    """把逐支 Key 变动的片段遮掉，用来判断两笔错误是不是「同一种原因」。

    供应商常把 Key 尾码写进 message（例："Your api key: ****2fb7 is invalid"），
    逐字比对会让每支 Key 各成一组；只比 error_code 又会把同一个码底下两种真正
    不同的原因（invalid key vs. 帐号停用）合并掉。遮掉变动片段后两者都成立。
    """
    s = str(msg or "").lower()
    for pattern, placeholder in _VARIABLE_FRAGMENTS:
        s = pattern.sub(placeholder, s)
    return " ".join(s.split())[:REASON_MAX_LEN]


CLIP_MARK = "…（已省略"


def clip_sample(text):
    """样本超长时掐头留尾，各留一半。

    推理模型常常想很久、结论落在最后一句，只取前段会把「= 323」切掉，
    看起来像没答完。注意：answer_verified 必须在截断前用完整文字判定。

    可重复套用：截过的字串带标记，会原样返回，不会叠上第二层省略。
    """
    s = text or ""
    if len(s) <= SAMPLE_MAX_LEN or CLIP_MARK in s:
        return s
    head = SAMPLE_MAX_LEN // 2
    tail = SAMPLE_MAX_LEN - head
    return f"{s[:head]}\n{CLIP_MARK} {len(s) - SAMPLE_MAX_LEN} 字）…\n{s[-tail:]}"


def pick_error_message(detail):
    """从 parse_error_body 的结果取一句可读讯息；取不到回 None。"""
    if not detail:
        return None
    for key in ("message", "msg", "raw"):
        val = detail.get(key)
        if val and str(val).strip():
            # 压平换行/多空白，避免分组标题破版
            return " ".join(str(val).split())[:REASON_MAX_LEN]
    return None


def extract_think_xml(text):
    think = ""
    # Complete tag: <think>...</think>
    m = re.search(r"<think>(.*?)</think>", text, flags=re.DOTALL)
    if m:
        think = m.group(1).strip()
        text = re.sub(r"<think>.*?</think>\n?", "", text, flags=re.DOTALL).strip()
    else:
        # Truncated: <think> opened but token limit hit before </think>
        m = re.search(r"<think>(.*)", text, flags=re.DOTALL)
        if m:
            think = m.group(1).strip()
            text = re.sub(r"<think>.*", "", text, flags=re.DOTALL).strip()
    return text, think


def get_full_endpoint(api_base, provider_type, model):
    base = api_base.rstrip("/")
    if provider_type == "openai":
        return f"{base}/chat/completions"
    elif provider_type == "ollama":
        return f"{base}/api/chat"
    elif provider_type == "gemini":
        return f"{base}/models/{model}:streamGenerateContent?alt=sse"
    elif provider_type == "anthropic":
        return f"{base}/messages"
    return base


def build_payload(provider_type, model, stream, extra_body=None):
    if provider_type == "openai":
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": MAX_OUTPUT_TOKENS,
            "stream": stream,
        }
    elif provider_type == "ollama":
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "options": {"num_predict": MAX_OUTPUT_TOKENS},
            "stream": stream,
        }
    elif provider_type == "gemini":
        payload = {
            "contents": [{"role": "user", "parts": [{"text": PROMPT}]}],
            "generationConfig": {"maxOutputTokens": MAX_OUTPUT_TOKENS},
        }
    elif provider_type == "anthropic":
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": MAX_OUTPUT_TOKENS,
            "stream": stream,
        }
    else:
        payload = {}
    if extra_body:
        payload.update(extra_body)
    return payload


def extract_stream_chunk(line, provider_type):
    has_content = False
    has_thinking = False
    content_parts = []
    thinking_parts = []

    if provider_type in ("openai", "gemini", "anthropic"):
        if not line.startswith("data:"):
            return False, False, [], []
        line = line[5:].strip()
        if line == "[DONE]":
            return False, False, [], []

    try:
        data = json.loads(line)
    except:
        return False, False, [], []

    if provider_type == "openai":
        choices = data.get("choices", [])
        if choices:
            delta = choices[0].get("delta", {})
            content = delta.get("content") or ""
            reasoning = (
                (delta.get("reasoning_content") or "")
                or (delta.get("reasoning") or "")
                or (delta.get("thinking") or "")
            )
            if content:
                has_content = True
                content_parts.append(content)
            if reasoning:
                has_thinking = True
                thinking_parts.append(reasoning)

    elif provider_type == "ollama":
        msg = data.get("message", {})
        content = msg.get("content") or ""
        thinking = msg.get("thinking") or ""
        if content:
            has_content = True
            content_parts.append(content)
        if thinking:
            has_thinking = True
            thinking_parts.append(thinking)

    elif provider_type == "gemini":
        candidates = data.get("candidates", [])
        for c in candidates:
            parts = c.get("content", {}).get("parts", [])
            for p in parts:
                text = p.get("text") or ""
                # `thought: true` 才代表此 part 是思考文字；
                # `thoughtSignature` 只是「有思考過」的憑證，text 仍是正文
                is_thought = bool(p.get("thought"))
                if p.get("thoughtSignature"):
                    has_thinking = True
                if is_thought:
                    has_thinking = True
                    if text:
                        thinking_parts.append(text)
                elif text:
                    has_content = True
                    content_parts.append(text)

    elif provider_type == "anthropic":
        # Anthropic SSE: data lines carry {"type": "content_block_delta", "delta": {...}}
        if data.get("type") == "content_block_delta":
            delta = data.get("delta", {})
            dt = delta.get("type", "")
            if dt == "text_delta":
                text = delta.get("text") or ""
                if text:
                    has_content = True
                    content_parts.append(text)
            elif dt == "thinking_delta":
                thinking = delta.get("thinking") or ""
                if thinking:
                    has_thinking = True
                    thinking_parts.append(thinking)

    return has_content, has_thinking, content_parts, thinking_parts


async def parse_stream(response, provider_type, ttft_timeout=None):
    first_chunk_time = None
    has_content = False
    has_thinking = False
    content_buf = []
    thinking_buf = []

    async def _consume_line(raw_line):
        nonlocal first_chunk_time, has_content, has_thinking
        line = raw_line.decode("utf-8").strip()
        if not line:
            return False

        line_has_content, line_has_thinking, content_parts, thinking_parts = (
            extract_stream_chunk(line, provider_type)
        )
        if not (line_has_content or line_has_thinking):
            return False

        if first_chunk_time is None:
            first_chunk_time = time.perf_counter()
        if line_has_content:
            has_content = True
            content_buf.extend(content_parts)
        if line_has_thinking:
            has_thinking = True
            thinking_buf.extend(thinking_parts)
        return True

    if ttft_timeout is not None:
        deadline = time.perf_counter() + ttft_timeout
        while first_chunk_time is None:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            raw_line = await asyncio.wait_for(
                response.content.readline(), timeout=remaining
            )
            if not raw_line:
                break
            await _consume_line(raw_line)

    async for raw_line in response.content:
        await _consume_line(raw_line)
    sample_content = "".join(content_buf).strip()
    sample_thinking = "".join(thinking_buf).strip()
    # Stream 模式：如果未偵測到獨立 thinking 欄位，嘗試從正文中提取 <think> XML
    if not has_thinking:
        sample_content, xml_think = extract_think_xml(sample_content)
        if xml_think:
            has_thinking = True
            sample_thinking = xml_think
    return first_chunk_time, has_content, has_thinking, sample_content, sample_thinking


async def test_single_request(
    session, key, model, stream, provider_type, api_base, extra_body=None
):
    headers = {"Content-Type": "application/json", "User-Agent": "claude-code/2.1.152"}
    if provider_type == "gemini":
        headers["x-goog-api-key"] = key
    elif provider_type == "anthropic":
        headers["x-api-key"] = key
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {key}"

    payload = build_payload(provider_type, model, stream, extra_body)
    timeout = aiohttp.ClientTimeout(total=TOTAL_TIMEOUT)

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
                ) = await parse_stream(resp, provider_type, ttft_timeout=TTFT_TIMEOUT)
                if first_t:
                    ttft = first_t - start_t
            else:
                body = await resp.text()
                try:
                    data = json.loads(body)
                    if provider_type == "openai":
                        msg = data.get("choices", [{}])[0].get("message", {})
                        sample_content = (msg.get("content") or "").strip()
                        reasoning = (
                            (msg.get("reasoning_content") or "")
                            or (msg.get("reasoning") or "")
                            or (msg.get("thinking") or "")
                        )
                        sample_content, xml_think = extract_think_xml(sample_content)
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
                                # `thought: true` 才代表此 part 是思考文字；
                                # `thoughtSignature` 只是「有思考過」的憑證，text 仍是正文
                                is_thought = bool(p.get("thought"))
                                if p.get("thoughtSignature"):
                                    has_thinking = True
                                if is_thought:
                                    sample_thinking += text
                                    has_thinking = True
                                elif text:
                                    sample_content += text
                                    has_content = True
                        sample_content = sample_content.strip()
                        sample_thinking = sample_thinking.strip()
                    elif provider_type == "anthropic":
                        # Non-stream: {"content": [{"type": "text", "text": "..."}, ...]}
                        for block in data.get("content", []):
                            if block.get("type") == "text":
                                sample_content += block.get("text") or ""
                                has_content = True
                            elif block.get("type") == "thinking":
                                sample_thinking += block.get("thinking") or ""
                                has_thinking = True
                        sample_content = sample_content.strip()
                        sample_thinking = sample_thinking.strip()
                except:
                    pass
                ttft = None  # Non-stream doesn't count TTFT

            total_t = time.perf_counter() - start_t
            # 有正文 或 有思考（含截斷）皆視為成功；純截斷思考的模型仍算 API 可用
            success = has_content or has_thinking
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


async def benchmark_model(
    session, key, model, provider_type, api_base, dead_keys=None, extra_body=None
):
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
        return await test_single_request(
            session,
            key,
            model,
            stream=stream,
            provider_type=provider_type,
            api_base=api_base,
            extra_body=extra_body,
        )

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
        penalty_time += total_t if total_t else TOTAL_TIMEOUT
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
        penalty_time += total_t if total_t else TOTAL_TIMEOUT
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
            penalty_time += total_t if total_t else TOTAL_TIMEOUT
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


async def run_provider(
    api_base, provider_type, keys, models, extra_body=None, max_concurrency=None
):
    concurrency = max_concurrency if max_concurrency is not None else MAX_CONCURRENCY
    global_start_time = time.perf_counter()
    print(f"\n{'=' * 50}")
    print(f"▶ 开始测试服务商: {provider_type} | {api_base}")
    print(f"▶ 载入 {len(keys)} 个 Key，{len(models)} 个模型，并发: {concurrency}")
    print(f"{'=' * 50}\n")

    # 只有一支 Key 时没有交叉验证的余地（没有别的 Key 能证明模型健康），
    # 所以同一个 (Key, Model) 连跑两轮，用第二轮的样本区分「模型真的不通」与「单次抖动」。
    runs_per_pair = 2 if len(keys) == 1 else 1
    if runs_per_pair > 1:
        print(
            f"▶ 仅有 1 支 Key，每个模型将连跑 {runs_per_pair} 轮"
            f"（每轮之间间隔 {SINGLE_KEY_RERUN_DELAY} 秒）\n"
        )

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
                success_counts = defaultdict(int)
                for k, v in results.items():
                    for item in v:
                        # 只跳过成功的 pair；失败的（429/超时/供应商错误）重新跑
                        # 例外：403/401 是 Key 级硬伤，直接把该 Key 加入 dead_keys，全部跳过
                        if item.get("success"):
                            success_counts[f"{k}::{item['model']}"] += 1
                        elif item.get("status") in (401, 403):
                            dead_keys.add(k)
                # 单 Key 模式要满额（两轮都成功）才算做完，否则中断续跑会悄悄退化成只跑一轮
                completed_pairs = {
                    pair for pair, n in success_counts.items() if n >= runs_per_pair
                }
                # 清理 results：只留下「已满额」pair 的成功记录。要重跑的 pair 连旧的
                # 成功记录一起丢掉，否则旧样本会和新的两轮叠成 3 笔
                for k in results:
                    results[k] = [
                        item
                        for item in results[k]
                        if item.get("success")
                        and f"{k}::{item['model']}" in completed_pairs
                    ]
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

            for run_idx in range(1, runs_per_pair + 1):
                if run_idx > 1:
                    # 第一轮可能已经把这支 Key 判死，别再浪费一轮与等待时间
                    if key in dead_keys:
                        break
                    await asyncio.sleep(SINGLE_KEY_RERUN_DELAY)

                round_note = f" (第 {run_idx}/{runs_per_pair} 轮)" if runs_per_pair > 1 else ""
                print(
                    f"[{processed_count}/{total_in_queue}] 测试 {masked} -> {model}{round_note}",
                    flush=True,
                )

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
                ) = await benchmark_model(
                    session,
                    key,
                    model,
                    provider_type=provider_type,
                    api_base=api_base,
                    dead_keys=dead_keys,
                    extra_body=extra_body,
                )

                # 熔断二次拦截：benchmark_model 入口检测到已死 Key，直接跳过，不写 results
                if status == -1:
                    break

                if key not in results:
                    results[key] = []

                record = {
                    "model": model,
                    "success": success,
                    "status": status,
                    "error": err[:100],
                    # 在这里解析而非事后解析截断字串：大于 512 字元的 JSON body 一旦被切断
                    # 就不再是合法 JSON，只能退回 raw，反而拿不到供应商的 message
                    "error_detail": parse_error_body(err) if err else None,
                    "avg_ttft": ttft,
                    "avg_total": total,
                    "has_thinking": has_thinking,
                    "has_content": has_content,
                    # 先用完整文字判定答案，再截断样本：顺序反过来会把长回应误判成没答对
                    "answer_verified": "323" in (sample_content + sample_thinking),
                    "sample_content": clip_sample(sample_content),
                    "sample_thinking": clip_sample(sample_thinking),
                }
                results[key].append(record)

                # Circuit Breaker：只有明确的 Key 权限错误 (401/403) 或余额/配额提示才判死
                if (
                    status in (401, 403)
                    or "balance" in err.lower()
                    or "quota" in err.lower()
                ):
                    reason = (
                        f"HTTP {status}" if status not in (401, 403) else str(status)
                    )
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
                        "results": results,
                    }
                    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
                        json.dump(ckpt_data, f, ensure_ascii=False)
                    if PAGES_URL and ADMIN_TOKEN:
                        try:
                            _pages_request("POST", "/api/checkpoint", ckpt_data)
                        except:
                            pass
                    tasks_done_since_ckpt = 0

            task_queue.task_done()

    # Run Event Loop
    async with aiohttp.ClientSession() as session:
        workers = [asyncio.create_task(worker(session)) for _ in range(concurrency)]
        await asyncio.gather(*workers)

    # Final Checkpoint Save
    ckpt_data = {
        "provider_type": provider_type,
        "api_base": api_base,
        "total_tasks": total_in_queue,
        "completed_tasks": processed_count,
        "dead_keys": list(dead_keys),
        "results": results,
    }
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump(ckpt_data, f, ensure_ascii=False)
    if PAGES_URL and ADMIN_TOKEN:
        try:
            _pages_request("POST", "/api/checkpoint", ckpt_data)
        except:
            pass

    print("\n--- 并发测试结束，开始交叉验证(Cross-Key Validation) ---")

    # Post Processing
    proven_working_models = set()
    # 模型维度统计结构
    model_perf = defaultdict(
        lambda: {
            "ttft": [],
            "total": [],
            "thinking_count": 0,  # 有思考的成功请求数
            "answer_verified": False,  # 任意一次成功回应中含有 323
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
                if r.get("answer_verified"):  # 任意一次成功含 323 即标记 True
                    model_perf[m]["answer_verified"] = True
                # 每个模型只存第一次成功的 sample
                if model_perf[m]["sample"] is None:
                    # 再截一次：从旧 checkpoint 恢复的纪录是在加上限之前写的，
                    # 这里是样本进 KV 的最后一道关卡（clip_sample 可重复套用）
                    model_perf[m]["sample"] = {
                        "has_thinking": bool(r.get("has_thinking")),
                        "thinking": clip_sample(r.get("sample_thinking", "")),
                        "content": clip_sample(r.get("sample_content", "")),
                    }

    invalid_output = []
    # (error_code, 正规化后的讯息) -> 只有这组第一笔保留 error_detail。
    # 每支 Key 自己的 error_reason 都留着：一支约 100 bytes，比起遗失「同一个 code
    # 底下第二种原因」的代价便宜得多；真正占空间的是 error_detail 这个物件。
    stored_detail_keys = set()

    for k, records in results.items():
        key_all_failed = True
        hard_failure_reason = None
        hard_failure_status = None
        first_error_status = None
        first_error_detail = None

        for r in records:
            if r["success"]:
                key_all_failed = False
            else:
                status = r["status"]
                if first_error_status is None:
                    first_error_status = status
                    # 旧 checkpoint 没有 error_detail，退回解析当时留下的字串
                    first_error_detail = r.get("error_detail")
                    if first_error_detail is None:
                        first_error_detail = parse_error_body(
                            r.get("error_body") or r.get("error") or ""
                        )
                if status in (401, 403):
                    hard_failure_reason = f"Key 专属硬伤 (Hard Failure - {status})"
                    hard_failure_status = status

        # 结算这把 Key
        if key_all_failed:
            detail = first_error_detail or {}
            message = pick_error_message(detail)
            error_code = first_error_status

            # 优先显示供应商的原话；只有连 body 都拿不到时才退回人工归类的说明
            if message:
                own_reason = message
            elif hard_failure_reason:
                own_reason = hard_failure_reason
                # 说明文字讲的是 401/403，error_code 就得跟着它，不能停在首个失败的状态码
                error_code = hard_failure_status
            elif any(r["model"] in proven_working_models for r in records):
                own_reason = (
                    "全盘软失效 (测试的所有模型均失败，但部分模型被其他Key证实健康)"
                )
            else:
                own_reason = "全部模型皆无响应 (无法断定是Key的问题，因全网皆败)"

            # 同一种原因（同 code + 正规化后同讯息）只存一份 error_detail
            dedup_key = (error_code, normalize_message(own_reason))
            if detail and dedup_key not in stored_detail_keys:
                stored_detail_keys.add(dedup_key)
            else:
                detail = None

            invalid_output.append(
                {
                    "api_key": k,
                    "error_reason": own_reason,
                    "error_code": error_code,
                    "error_detail": detail,
                }
            )
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
        timeouts = model_timeout_stats[m]
        total_tested = model_test_counts[m]
        model_stats[m] = {
            "sample_count": sample_count,
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
            "answer_verified": perf["answer_verified"],
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
            resp = _pages_request("POST", "/api/results", final_report)
            # 这两个字段由 handlePostResults 回传；旧版 worker 没有，取不到就只印上传成功
            added = (resp or {}).get("dead_keys_added") or 0
            removed = (resp or {}).get("dead_keys_removed") or 0
            if added or removed:
                print(
                    f"[Pages] 上传成功。失效 Key 清单：新增 {added} 支、"
                    f"移除 {removed} 支（本轮已恢复）。"
                )
            else:
                print("[Pages] 上传成功。")
        except Exception as e:
            print(f"[Pages] 上传失败（本地文件仍保留）: {e}")

        # checkpoint 已由 handlePostResults 在接收结果时自动删除，无需再次显式 DELETE

    # 清理: 成功产出最终报表后，自动删除本地存档，避免下次执行时被当成恢复进度而全部跳过
    if os.path.exists(CHECKPOINT_PATH):
        try:
            os.remove(CHECKPOINT_PATH)
            print(f"已自动清理临时存档档: {CHECKPOINT_PATH}")
        except Exception as e:
            print(f"[警告] 无法删除临时存档档: {e}")


async def main():
    providers_to_run = []

    if PAGES_URL and ADMIN_TOKEN:
        print(f"[Pages] 从 {PAGES_URL}/api/settings 读取设定...")
        try:
            resp = _pages_request("GET", "/api/settings")
            settings = resp.get("settings") or {}
            providers = settings.get("providers", [])
            if not providers:
                return print("[错误] 远端设定中没有任何服务商 (Providers)。")

            for p in providers:
                # 严格检查 enabled 字段
                if not p.get("enabled", True):
                    print(
                        f"\n[跳过] 服务商 {p['provider_type']} | {p['api_base']} (已设定为停用)"
                    )
                    continue

                ab = p["api_base"].strip().rstrip("/")
                pt = p["provider_type"]
                rk = p["keys"]
                rm = p["models"]
                k_list = [line.strip() for line in rk.splitlines() if line.strip()]
                m_list = [m.strip() for m in rm.split(",") if m.strip()]

                if not k_list or not m_list:
                    print(f"\n[跳过] 服务商 {pt} | {ab} (缺少 Key 或 Model)")
                    continue

                eb_raw = p.get("extra_body", "").strip()
                extra_body = {}
                if eb_raw:
                    try:
                        extra_body = json.loads(eb_raw)
                    except json.JSONDecodeError:
                        print(
                            f"[警告] 服务商 {pt} | {ab} 的 extra_body 不是有效 JSON，已忽略"
                        )
                mc = p.get("max_concurrency")
                if mc is not None:
                    try:
                        mc = int(mc)
                        if mc < 1:
                            mc = None
                    except (TypeError, ValueError):
                        mc = None
                providers_to_run.append((ab, pt, k_list, m_list, extra_body, mc))

        except Exception as e:
            return print(f"[错误] 无法从 Pages 读取设定: {e}")
    else:
        # 本地文件 fallback
        if not os.path.exists(INPUT_FILE_PATH) or not os.path.exists(MODELS_FILE_PATH):
            return print(f"[错误] 本地 fallback 找不到 keys.txt 或 models.txt")
        with open(INPUT_FILE_PATH, "r", encoding="utf-8") as f:
            keys = [line.strip() for line in f if line.strip()]
        with open(MODELS_FILE_PATH, "r", encoding="utf-8") as f:
            models = [m.strip() for m in f.read().split(",") if m.strip()]

        if not keys or not models:
            return print("[错误] 本地 fallback 缺少 Key 或 Model。")

        local_extra = {}
        if EXTRA_BODY_JSON.strip():
            try:
                local_extra = json.loads(EXTRA_BODY_JSON)
            except json.JSONDecodeError:
                return print("[错误] EXTRA_BODY_JSON 不是有效的 JSON，请检查配置")
        providers_to_run.append(
            (API_BASE, PROVIDER_TYPE, keys, models, local_extra, None)
        )

    if not providers_to_run:
        return print("\n[结束] 没有需要执行的服务商。")

    print(f"\n总共将执行 {len(providers_to_run)} 个服务商测试。")

    for ab, pt, k_list, m_list, extra_body, mc in providers_to_run:
        await run_provider(ab, pt, k_list, m_list, extra_body, max_concurrency=mc)

    print(f"\n{'=' * 50}\n全部服务商测试执行完毕！\n{'=' * 50}")


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n手动中断，当前进度已保存在 checkpoint.json 中。")
