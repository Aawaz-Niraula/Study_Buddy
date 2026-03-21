export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ detail: "Method not allowed" }), { status: 405 });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return new Response(JSON.stringify({ detail: "GROQ_API_KEY not configured" }), { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ detail: "Invalid JSON body" }), { status: 400 });
  }

  const text = (body.text || "").trim();
  const mode = body.mode || "mix";
  const ALLOWED_MODES = ["multiple-choice", "flashcard", "short-answer", "true-false", "mix"];

  if (!text) return new Response(JSON.stringify({ detail: "Text cannot be empty" }), { status: 422 });
  if (text.length < 10) return new Response(JSON.stringify({ detail: "Text too short" }), { status: 422 });
  if (text.length > 12000) return new Response(JSON.stringify({ detail: "Text too long" }), { status: 422 });
  if (!ALLOWED_MODES.includes(mode)) return new Response(JSON.stringify({ detail: "Invalid mode" }), { status: 422 });

  const instructions = {
    "multiple-choice": "Generate 8–10 multiple-choice questions only. Set multiple_choice to a full array. Set short_answer, true_false, flashcards to [].",
    "flashcard": "Generate 10–15 flashcard pairs only. Set flashcards to a full array. Set multiple_choice, short_answer, true_false to [].",
    "short-answer": "Generate 10 short-answer questions only. Set short_answer to a full array. Set multiple_choice, true_false, flashcards to [].",
    "true-false": "Generate 12 true/false questions only. Set true_false to a full array. Set multiple_choice, short_answer, flashcards to [].",
    "mix": "Generate a balanced mix: 4 multiple-choice, 3 short-answer, 3 true/false, and 4 flashcards.",
  };

  const SYSTEM_PROMPT = `You are a university-level study assistant. Generate high-quality study questions targeting key concepts.

You MUST output valid JSON only — no markdown, no code fences, no explanation, nothing outside the JSON object.

Output format:
{"multiple_choice": [{"question": "", "options": ["A) …", "B) …", "C) …", "D) …"], "answer": "A"}], "short_answer": [{"question": "", "answer": ""}], "true_false": [{"statement": "", "answer": "True"}], "flashcards": [{"question": "", "answer": ""}]}

Rules:
- multiple_choice options MUST be a JSON array of strings
- multiple_choice answer is just the letter e.g. "B"
- true_false answer is exactly "True" or "False"
- Always include all four keys even if empty
- Do NOT use actual newline characters inside any string value
- Do NOT wrap output in markdown`;

  const userPrompt = `${instructions[mode]}\n\nSource text:\n${text}`;

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.6,
        top_p: 0.92,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      const status = groqRes.status === 429 ? 429 : 502;
      return new Response(JSON.stringify({ detail: err.error?.message || "Groq API error" }), { status });
    }

    const groqData = await groqRes.json();
    let raw = groqData.choices[0].message.content.trim();
    raw = raw.replace(/^```(?:json)?\s*/g, "").replace(/\s*```$/g, "").trim();

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return new Response(JSON.stringify({ detail: "No JSON found in model response" }), { status: 500 });

    const parsed = JSON.parse(match[0]);
    for (const key of ["multiple_choice", "short_answer", "true_false", "flashcards"]) {
      if (!parsed[key]) parsed[key] = [];
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ detail: `Server error: ${e.message}` }), { status: 500 });
  }
};

export const config = { path: "/api/generate" };
