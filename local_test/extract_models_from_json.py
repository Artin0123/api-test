import json
import sys

# ========== 設定路徑 ==========
INPUT_FILE = "local_test\\response.json"
OUTPUT_FILE = "local_test\\available_models.txt"
# =============================

input_file = INPUT_FILE
output_file = OUTPUT_FILE

try:
    with open(input_file, "r", encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    print(f"❌ 找不到文件: {input_file}")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"❌ JSON 解析失败: {e}")
    sys.exit(1)

# 提取所有模型名稱（保持原始順序）
if "data" not in data:
    print("❌ JSON 中缺少 'data' 鍵")
    sys.exit(1)

models = [
    item.get("id") for item in data["data"] if isinstance(item, dict) and "id" in item
]
# 過濾掉 None 值（如果有的話）
models = [m for m in models if m is not None]

if not models:
    print("⚠️ 文件中沒有模型")
    sys.exit(0)

# 輸出逗號分隔的模型名稱
output = ",".join(models)

with open(output_file, "w", encoding="utf-8") as f:
    f.write(output)

print(f"✅ 已提取 {len(models)} 個模型")
print(f"📄 輸出: {output_file}")
print(f"\n{output}")
