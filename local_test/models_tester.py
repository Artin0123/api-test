# /// script
# dependencies = [
#   "aiohttp",
# ]
# ///

import asyncio
import json
import os
import time

import aiohttp

# ==================== 【请在这里设置】 ====================
MY_BASE_URL = "https://integrate.api.nvidia.com/v1"

# Key 文件路径：每行可以是 "url,key" 或 "key"（使用默认 URL）
KEYS_FILE = "valid_keys\\Nvidia NIM.txt"

# 模型文件路径：包含逗号分隔的模型名，如 "qwen-plus,qwen-turbo"
MODELS_FILE = "local_test\\available_models.txt"

# 额外参数（可选）：JSON 字符串，会合并到请求 body 顶层
EXTRA_BODY_JSON = ""

# 输出：可用模型列表（逗号分隔）
OUTPUT_MODELS_FILE = "available_models.txt"

TIMEOUT_SECONDS = 30
CONCURRENCY = 40  # 同时并发请求数
# ========================================================


async def test_key(
    session: aiohttp.ClientSession,
    base_url,
    api_key,
    model,
    extra_body=None,
    collect_content=True,
):
    extra_body = extra_body or {}

    # 首次采集内容时给稍多 token，否则只做连通性检查
    max_tokens = 256 if collect_content else 1

    body = {
        "model": model,
        "messages": [{"role": "user", "content": "1"}],
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    body.update(extra_body)

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.152",
    }
    if "generativelanguage.googleapis.com" in base_url:
        headers["x-goog-api-key"] = api_key
    else:
        headers["Authorization"] = f"Bearer {api_key}"

    timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)

    start_time = time.perf_counter()
    ttft = None
    reasoning_content = ""
    answer_content = ""

    try:
        async with session.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=body,
            timeout=timeout,
        ) as response:
            if response.status != 200:
                text = await response.read()
                return False, f"HTTP {response.status}", "", ""

            async for line_bytes in response.content:
                line = line_bytes.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue

                data = line[6:]
                if data == "[DONE]":
                    break

                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue

                if not chunk.get("choices"):
                    continue

                delta = chunk["choices"][0].get("delta", {})

                if ttft is None:
                    ttft = time.perf_counter() - start_time

                if collect_content:
                    r = delta.get("reasoning_content")
                    if r:
                        reasoning_content += r
                    c = delta.get("content")
                    if c:
                        answer_content += c

            total_time = time.perf_counter() - start_time
            if ttft is None:
                ttft = total_time

            msg = f"成功 | 总耗时: {total_time:.2f}s | TTFT: {ttft:.2f}s"
            return True, msg, answer_content, reasoning_content

    except asyncio.TimeoutError:
        return False, "超时", "", ""
    except Exception as e:
        return False, str(e).split("\n")[0], "", ""


async def main():
    extra_body = {}
    if EXTRA_BODY_JSON.strip():
        try:
            extra_body = json.loads(EXTRA_BODY_JSON)
        except json.JSONDecodeError as e:
            print(f"❌ 错误: EXTRA_BODY_JSON 解析失败: {e}")
            return

    if not os.path.exists(KEYS_FILE):
        print(f"❌ 错误: 找不到 Key 文件 '{KEYS_FILE}'")
        return

    # 读取 keys
    test_items = []
    with open(KEYS_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if "," in line:
                parts = line.split(",", 1)
                test_items.append({"url": parts[0].strip(), "key": parts[1].strip()})
            elif "|" in line:
                parts = line.split("|", 1)
                test_items.append({"url": parts[0].strip(), "key": parts[1].strip()})
            else:
                test_items.append({"url": MY_BASE_URL, "key": line})

    # 读取模型列表
    if not os.path.exists(MODELS_FILE):
        print(f"❌ 错误: 找不到模型文件 '{MODELS_FILE}'")
        return

    with open(MODELS_FILE, "r", encoding="utf-8") as f:
        content = f.read().strip()
        models = [m.strip() for m in content.split(",") if m.strip()]

    if not models:
        print(f"❌ 错误: 模型文件 '{MODELS_FILE}' 中没有模型")
        return

    print(f"📦 模型数: {len(models)} | Key 数: {len(test_items)} | 并发: {CONCURRENCY}")
    if extra_body:
        print(f"📋 额外参数: {json.dumps(extra_body, ensure_ascii=False)}")
    print()

    model_outputs = {}
    valid_count = 0
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def run_one(item, model, key_index):
        nonlocal valid_count
        already_have = model in model_outputs

        async with semaphore:
            success, msg, answer, reasoning = await test_key(
                session,
                item["url"],
                item["key"],
                model,
                extra_body,
                collect_content=not already_have,
            )

        status = "✅ 成功" if success else "❌ 失败"
        note = " (内容已采集)" if already_have else ""
        print(f"[{key_index}] {model}: {status}{note}")

        if success and not already_have and answer.strip():
            model_outputs[model] = {
                "model": model,
                "key": item["key"],
                "answer": answer,
                "reasoning": reasoning,
                "collected_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }

        if success:
            valid_count += 1

    # 构建所有任务并并发执行
    tasks = []
    for i, item in enumerate(test_items, 1):
        for model in models:
            tasks.append(run_one(item, model, i))

    async with aiohttp.ClientSession() as session:
        await asyncio.gather(*tasks)

    total_tests = len(tasks)

    # 保存详细内容 JSON
    with open("model_outputs.json", "w", encoding="utf-8") as f:
        json.dump(model_outputs, f, ensure_ascii=False, indent=2)

    # 保存可用模型列表（逗号分隔）
    available_models = ",".join(model_outputs.keys())
    with open(OUTPUT_MODELS_FILE, "w", encoding="utf-8") as f:
        f.write(available_models)

    print(f"\n--- 完成 | 成功: {valid_count}/{total_tests} ---")
    print(f"📄 已保存: model_outputs.json (共 {len(model_outputs)} 个模型)")
    print(f"📄 已保存: {OUTPUT_MODELS_FILE}")


if __name__ == "__main__":
    asyncio.run(main())
