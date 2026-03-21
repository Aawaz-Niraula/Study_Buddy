import os
import json
import re

from groq import Groq
from groq import RateLimitError, BadRequestError, AuthenticationError, APIError

# ────────────────────────────────────────────────
# CONFIG
# ────────────────────────────────────────────────

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
DEFAULT_MODEL = "llama-3.1-8b-instant"
ALLOWED_MODES = {"multiple-choice", "flashcard", "short-answer", "true-false", "mix"}

SYSTEM_PROMPT = """You are a university-level study assistant. Generate high-quality study questions targeting key concepts.

You MUST output valid JSON only — no markdown, no code fences, no explanation, nothing outside the JSON object.

Output format:
{
"multiple_choice": [{"question": "", "options": ["A) …", "B) …", "C) …", "D) …"], "answer": "A"}],
"short_answer": [{"question": "", "answer": ""}],
"true_false": [{"statement": "", "answer": "True"}],
"flashcards": [{"question": "", "answer": ""}]
}

Rules:
- multiple_choice: options MUST be a JSON array of strings, e.g. ["A) Paris", "B) London", "C) Rome", "D) Berlin"]
- multiple_choice: answer is just the letter e.g. "B"
- true_false: answer is exactly "True" or "False"
- Always include all four keys in the JSON even if the array is empty
- Do NOT use actual newline characters inside any string value
- Do NOT wrap output in ```json or any markdown
"""

def build_user_prompt(mode: str, text: str) -> str:
    instructions = {
        "multiple-choice": (
            "Generate 8–10 multiple-choice questions only. "
            "Set multiple_choice to a full array. Set short_answer, true_false, flashcards to []."
        ),
        "flashcard": (
            "Generate 10–15 flashcard pairs only. "
            "Set flashcards to a full array. Set multiple_choice, short_answer, true_false to []."
        ),
        "short-answer": (
            "Generate 10 short-answer questions only. "
            "Set short_answer to a full array. Set multiple_choice, true_false, flashcards to []."
        ),
        "true-false": (
            "Generate 12 true/false questions only. "
            "Set true_false to a full array. Set multiple_choice, short_answer, flashcards to []."
        ),
        "mix": (
            "Generate a balanced mix: 4 multiple-choice, 3 short-answer, 3 true/false, and 4 flashcards."
        ),
    }
    return (
        f"{instructions.get(mode, instructions['mix'])}\n\n"
        f"Source text:\n{text.strip()}"
    )

def escape_control_chars_in_strings(s: str) -> str:
    result = []
    in_string = False
    escape_next = False
    for ch in s:
        if escape_next:
            result.append(ch)
            escape_next = False
        elif ch == '\\' and in_string:
            result.append(ch)
            escape_next = True
        elif ch == '"':
            in_string = not in_string
            result.append(ch)
        elif in_string and ch == '\n':
            result.append('\\n')
        elif in_string and ch == '\r':
            result.append('\\r')
        elif in_string and ch == '\t':
            result.append('\\t')
        elif in_string and ord(ch) < 0x20:
            result.append(f'\\u{ord(ch):04x}')
        else:
            result.append(ch)
    return ''.join(result)

def make_response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        "body": json.dumps(body),
    }

# ────────────────────────────────────────────────
# HANDLER
# ────────────────────────────────────────────────

def handler(event, context):
    # Handle CORS preflight
    if event.get("httpMethod") == "OPTIONS":
        return make_response(200, {})

    if event.get("httpMethod") != "POST":
        return make_response(405, {"detail": "Method not allowed"})

    if not GROQ_API_KEY:
        return make_response(500, {"detail": "GROQ_API_KEY not configured"})

    # Parse body
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return make_response(400, {"detail": "Invalid JSON body"})

    text = body.get("text", "").strip()
    mode = body.get("mode", "mix")

    if not text:
        return make_response(422, {"detail": "Text cannot be empty"})
    if len(text) < 10:
        return make_response(422, {"detail": "Text too short (min 10 characters)"})
    if len(text) > 12000:
        return make_response(422, {"detail": "Text too long (max 12000 characters)"})
    if mode not in ALLOWED_MODES:
        return make_response(422, {"detail": f"Invalid mode. Must be one of: {', '.join(ALLOWED_MODES)}"})

    try:
        client = Groq(api_key=GROQ_API_KEY)
        response = client.chat.completions.create(
            model=DEFAULT_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(mode, text)},
            ],
            max_tokens=2048,
            temperature=0.6,
            top_p=0.92,
        )

        raw = response.choices[0].message.content.strip()

        # Strip markdown fences if model wraps anyway
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        raw = raw.strip()

        json_match = re.search(r'\{[\s\S]*\}', raw)
        if not json_match:
            return make_response(500, {"detail": "No JSON object found in model response"})

        json_str = json_match.group()
        json_str = escape_control_chars_in_strings(json_str)
        questions_data = json.loads(json_str)

        # Ensure all keys exist
        for key in ("multiple_choice", "short_answer", "true_false", "flashcards"):
            if key not in questions_data:
                questions_data[key] = []

        return make_response(200, questions_data)

    except json.JSONDecodeError as e:
        return make_response(500, {"detail": f"Failed to parse model response as JSON: {str(e)}"})
    except RateLimitError:
        return make_response(429, {"detail": "Groq rate limit reached — try again in a moment"})
    except AuthenticationError:
        return make_response(403, {"detail": "Invalid or unauthorized Groq API key"})
    except BadRequestError as e:
        return make_response(400, {"detail": f"Invalid request: {str(e)}"})
    except APIError as e:
        return make_response(502, {"detail": f"Groq API error: {str(e)}"})
    except Exception as e:
        return make_response(500, {"detail": f"Server error: {str(e)}"})
