const DEFAULT_MODEL = "llama-3.1-8b-instant";
const ALLOWED_MODES = new Set([
  "multiple-choice",
  "flashcard",
  "short-answer",
  "true-false",
  "mix",
]);

const SYSTEM_PROMPT = `You are a university-level study assistant. Generate high-quality study questions targeting key concepts.

You MUST output valid JSON only with no markdown, code fences, or explanation.

Output format:
{
  "multiple_choice": [{"question": "", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A"}],
  "short_answer": [{"question": "", "answer": ""}],
  "true_false": [{"statement": "", "answer": "True"}],
  "flashcards": [{"question": "", "answer": ""}]
}

Rules:
- multiple_choice options must be a JSON array of strings
- multiple_choice answer is just the letter, for example "B"
- true_false answer is exactly "True" or "False"
- Always include all four keys even if some arrays are empty
- Do not put actual newline characters inside string values`;

function makeResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function buildUserPrompt(mode, text) {
  const instructions = {
    "multiple-choice":
      "Generate 8 to 10 multiple-choice questions only. Set multiple_choice to a full array. Set short_answer, true_false, and flashcards to [].",
    flashcard:
      "Generate 10 to 15 flashcard pairs only. Set flashcards to a full array. Set multiple_choice, short_answer, and true_false to [].",
    "short-answer":
      "Generate 10 short-answer questions only. Set short_answer to a full array. Set multiple_choice, true_false, and flashcards to [].",
    "true-false":
      "Generate 12 true/false questions only. Set true_false to a full array. Set multiple_choice, short_answer, and flashcards to [].",
    mix:
      "Generate a balanced mix: 4 multiple-choice, 3 short-answer, 3 true/false, and 4 flashcards.",
  };

  return `${instructions[mode] ?? instructions.mix}\n\nSource text:\n${text.trim()}`;
}

function normalizeQuestionSet(data) {
  const normalized = typeof data === "object" && data !== null ? data : {};
  for (const key of ["multiple_choice", "short_answer", "true_false", "flashcards"]) {
    if (!Array.isArray(normalized[key])) {
      normalized[key] = [];
    }
  }
  return normalized;
}

function parseModelJson(rawContent) {
  const stripped = rawContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }

  return JSON.parse(stripped.slice(start, end + 1));
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return makeResponse(200, {});
  }

  if (request.method !== "POST") {
    return makeResponse(405, { detail: "Method not allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return makeResponse(500, { detail: "GROQ_API_KEY not configured" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return makeResponse(400, { detail: "Invalid JSON body" });
  }

  const text = String(body?.text ?? "").trim();
  const mode = String(body?.mode ?? "mix");

  if (!text) {
    return makeResponse(422, { detail: "Text cannot be empty" });
  }
  if (text.length < 10) {
    return makeResponse(422, { detail: "Text too short (min 10 characters)" });
  }
  if (text.length > 12000) {
    return makeResponse(422, { detail: "Text too long (max 12000 characters)" });
  }
  if (!ALLOWED_MODES.has(mode)) {
    return makeResponse(422, { detail: `Invalid mode. Must be one of: ${Array.from(ALLOWED_MODES).join(", ")}` });
  }

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(mode, text) },
        ],
        max_tokens: 2048,
        temperature: 0.6,
        top_p: 0.92,
      }),
    });

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail =
        payload?.error?.message ||
        payload?.detail ||
        `Groq API error (${upstream.status})`;
      return makeResponse(upstream.status, { detail });
    }

    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) {
      return makeResponse(502, { detail: "Groq returned an empty response" });
    }

    const parsed = normalizeQuestionSet(parseModelJson(raw));
    return makeResponse(200, parsed);
  } catch (error) {
    return makeResponse(500, {
      detail: error instanceof Error ? error.message : "Server error",
    });
  }
}
