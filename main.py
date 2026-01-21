import os
import json
import re
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import google.generativeai as genai
from google.api_core import exceptions as google_exceptions

# ────────────────────────────────────────────────
#                   CONFIG & SETUP
# ────────────────────────────────────────────────

load_dotenv()

app = FastAPI(
    title="AI Study Buddy - Question Generator (Gemini)",
    description="Generates quiz/flashcard/short-answer/true-false questions using Google Gemini",
    version="0.3.1",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # <-- set your frontend URL in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found in .env file")

genai.configure(api_key=GEMINI_API_KEY)

DEFAULT_MODEL = "gemini-2.5-flash"
ALLOWED_MODES = Literal["multiple-choice", "flashcard", "short-answer", "true-false", "mix"]


# ────────────────────────────────────────────────
#                   DATA MODEL
# ────────────────────────────────────────────────

class Notes(BaseModel):
    text: str = Field(..., min_length=10, max_length=12000)
    mode: ALLOWED_MODES = Field(default="mix")


# ────────────────────────────────────────────────
#                   SYSTEM PROMPT
# ────────────────────────────────────────────────

def build_system_instruction(mode: str) -> str:
    base = (
        "You are a university-level study assistant. "
        "Generate high-quality study questions targeting key concepts. "
        "Output JSON **exactly** in this format:\n"
        "{\n"
        '  "multiple_choice": [{"question": "", "options": "", "answer": ""}],\n'
        '  "short_answer": [{"question": "", "answer": ""}],\n'
        '  "true_false": [{"statement": "", "answer": ""}],\n'
        '  "flashcards": [{"question": "", "answer": ""}]\n'
        "}\n"
        "For multiple-choice questions, list options each on a separate line like:\n"
        '"options": "A) First option\\nB) Second option\\nC) Third option\\nD) Fourth option"\n'
        "Do not include any text outside this JSON."
    )

    specifics = {
        "multiple-choice": (
            "Create 8–10 multiple-choice questions. Each question must have 4 options labeled A–D, each on its own line. "
            "Indicate the correct answer clearly like: **Correct: B**"
        ),
        "flashcard": "Create 10–15 flashcard Q&A pairs.",
        "short-answer": "Create 10 short-answer questions with concise answers.",
        "true-false": "Create 12 true/false questions with correct answers.",
        "mix": "Create a balanced mix of 10–14 questions covering all formats above."
    }

    return base + "\n" + specifics.get(mode, specifics["mix"])


# ────────────────────────────────────────────────
#                   ENDPOINTS
# ────────────────────────────────────────────────

@app.post("/generate")
async def generate_questions(notes: Notes):
    if not notes.text.strip():
        raise HTTPException(status_code=422, detail="Text cannot be empty")

    system_instruction = build_system_instruction(notes.mode)
    user_content = f"Create questions based on the following text:\n\n{notes.text.strip()}"

    model = genai.GenerativeModel(
        model_name=DEFAULT_MODEL,
        system_instruction=system_instruction,
        generation_config=genai.types.GenerationConfig(
            max_output_tokens=2048,
            temperature=0.68,
            top_p=0.92,
        ),
        safety_settings={
            "HARM_CATEGORY_HARASSMENT": "BLOCK_NONE",
            "HARM_CATEGORY_HATE_SPEECH": "BLOCK_NONE",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT": "BLOCK_NONE",
            "HARM_CATEGORY_DANGEROUS_CONTENT": "BLOCK_NONE",
        }
    )

    try:
        response = model.generate_content(user_content)

        if not response.text:
            if hasattr(response, "prompt_feedback") and response.prompt_feedback:
                raise HTTPException(400, "Prompt blocked by content safety filters")
            raise HTTPException(500, "Empty response received from Gemini")

        text = response.text.strip()
        
        # Try to extract JSON from the response
        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            try:
                questions_data = json.loads(json_match.group())
                return questions_data
            except json.JSONDecodeError:
                pass
        
        # If JSON parsing fails, return raw text in the expected format
        return {
            "multiple_choice": [],
            "short_answer": [],
            "true_false": [],
            "flashcards": []
        }

    except google_exceptions.ResourceExhausted:
        raise HTTPException(429, "Gemini rate limit reached — try again after 60–120 seconds")
    except google_exceptions.InvalidArgument as e:
        raise HTTPException(400, f"Invalid request: {str(e)}")
    except google_exceptions.PermissionDenied:
        raise HTTPException(403, "Invalid or unauthorized Gemini API key")
    except google_exceptions.GoogleAPIError as e:
        raise HTTPException(502, f"Gemini API error: {str(e)}")
    except Exception as e:
        raise HTTPException(500, f"Server error: {str(e)}")


@app.get("/health")
async def health_check():
    try:
        list(genai.list_models())
        return {
            "status": "healthy",
            "provider": "Google Gemini",
            "model": DEFAULT_MODEL,
            "api_key_configured": bool(GEMINI_API_KEY)
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)[:120]}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)