import json

questions = []
for i in range(1, 26):
    q = {
        "id": f"q_{i:02d}",
        "difficulty": "NB",
        "topic": "topic",
        "prompt": f"Nội dung câu hỏi {i}...",
        "options": [
            "Đáp án a",
            "Đáp án b",
            "Đáp án c",
            "Đáp án d"
        ],
        "answerIndex": 0,
        "explanation": f"Giải thích cho câu {i}...",
        "tags": ["Tag"]
    }
    questions.append(q)

js_content = "window.QUESTION_BANK = [\n"
for i, q in enumerate(questions):
    js_content += json.dumps(q, indent=2, ensure_ascii=False)
    if i < len(questions) - 1:
        js_content += ",\n"
    else:
        js_content += "\n];\n"

with open("/home/tsosad255/Downloads/New Folder/udthvp-5c27f26cc86f672d20a66c24ad41b8b356be9028/tdcdstv/questions.js", "w", encoding="utf-8") as f:
    f.write(js_content)
