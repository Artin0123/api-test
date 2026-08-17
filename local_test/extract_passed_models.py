import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ========== 設定路徑 ==========
HERE = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(HERE, "test_chat_models_passed.json")
OUTPUT_FILE = os.path.join(HERE, "passed_models.txt")
# =============================

try:
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    print(f"❌ 找不到文件: {INPUT_FILE}")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"❌ JSON 解析失败: {e}")
    sys.exit(1)

if "passed" not in data:
    print("❌ JSON 中缺少 'passed' 鍵")
    sys.exit(1)

models = [
    item.get("model")
    for item in data["passed"]
    if isinstance(item, dict) and "model" in item
]
models = [m for m in models if m is not None]

if not models:
    print("⚠️ 文件中沒有模型")
    sys.exit(0)

output = ",".join(models)

with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    f.write(output)

print(f"✅ 已提取 {len(models)} 個模型")
print(f"📄 輸出: {OUTPUT_FILE}")
print(f"\n{output}")
