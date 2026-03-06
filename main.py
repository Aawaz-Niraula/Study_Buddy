import os
import json
import re
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from groq import Groq
from groq import RateLimitError, BadRequestError, AuthenticationError, APIError

# ────────────────────────────────────────────────
#                   CONFIG & SETUP
# ────────────────────────────────────────────────

load_dotenv()

app = FastAPI(
    title="AI Study Buddy - Question Generator (Groq)",
    description="Generates quiz/flashcard/short-answer/true-false questions using Groq Llama",
    version="0.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY not found in .env file")

client = Groq(api_key=GROQ_API_KEY)

DEFAULT_MODEL = "llama-3.1-8b-instant"
ALLOWED_MODES = Literal["multiple-choice", "flashcard", "short-answer", "true-false", "mix"]


# ────────────────────────────────────────────────
#                   DATA MODEL
# ────────────────────────────────────────────────

class Notes(BaseModel):
    text: str = Field(..., min_length=10, max_length=12000)
    mode: ALLOWED_MODES = Field(default="mix")


# ────────────────────────────────────────────────
#                   PROMPTS
# ────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a university-level study assistant. Generate high-quality study questions targeting key concepts.

You MUST output valid JSON only — no markdown, no code fences, no explanation, nothing outside the JSON object.

Output format:
{
  "multiple_choice": [{"question": "", "options": "A) ...\nB) ...\nC) ...\nD) ...", "answer": "A"}],
  "short_answer": [{"question": "", "answer": ""}],
  "true_false": [{"statement": "", "answer": "True"}],
  "flashcards": [{"question": "", "answer": ""}]
}

Rules:
- multiple_choice: each option on its own line, answer is just the letter e.g. "B"
- true_false: answer is exactly "True" or "False"
- Always include all four keys in the JSON even if the array is empty
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


# ────────────────────────────────────────────────
#                   ENDPOINTS
# ────────────────────────────────────────────────

@app.post("/generate")
async def generate_questions(notes: Notes):
    if not notes.text.strip():
        raise HTTPException(status_code=422, detail="Text cannot be empty")

    try:
        response = client.chat.completions.create(
            model=DEFAULT_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(notes.mode, notes.text)},
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

        # Extract JSON object
        json_match = re.search(r'\{[\s\S]*\}', raw)
        if json_match:
            try:
                json_str = json_match.group()
                # Fix unescaped newlines/tabs inside JSON string values
                json_str = re.sub(r'(?<=[^\\])
', '\\n', json_str)
                json_str = re.sub(r'(?<=[^\\])	', '\\t', json_str)
                # Remove other illegal control characters
                json_str = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', json_str)
                questions_data = json.loads(json_str)
                # Ensure all keys exist
                for key in ("multiple_choice", "short_answer", "true_false", "flashcards"):
                    if key not in questions_data:
                        questions_data[key] = []
                return questions_data
            except json.JSONDecodeError as e:
                raise HTTPException(500, f"Failed to parse model response as JSON: {str(e)}")

        raise HTTPException(500, "No JSON object found in model response")

    except RateLimitError:
        raise HTTPException(429, "Groq rate limit reached — try again in a moment")
    except AuthenticationError:
        raise HTTPException(403, "Invalid or unauthorized Groq API key")
    except BadRequestError as e:
        raise HTTPException(400, f"Invalid request: {str(e)}")
    except APIError as e:
        raise HTTPException(502, f"Groq API error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Server error: {str(e)}")


@app.get("/health")
async def health_check():
    try:
        models = client.models.list()
        return {
            "status": "healthy",
            "provider": "Groq",
            "model": DEFAULT_MODEL,
            "api_key_configured": bool(GROQ_API_KEY),
            "available_models": [m.id for m in models.data][:5],
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)[:120]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
