import json
import sys

# 默认读取 model_outputs.json，也可通过命令行参数指定
input_file = sys.argv[1] if len(sys.argv) > 1 else "model_outputs.json"
output_file = sys.argv[2] if len(sys.argv) > 2 else "available_models.txt"

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
models = list(data.keys())

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
