import { createClient } from "@libsql/client";

const TEXT_MODEL = "llama-3.1-8b-instant";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const ALLOWED_MODES = new Set([
  "multiple-choice",
  "flashcard",
  "short-answer",
  "true-false",
  "mix",
]);
const ALLOWED_DIFFICULTIES = new Set(["easy", "medium", "difficult"]);

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

let schemaReadyPromise;

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

function buildModeInstruction(mode) {
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

  return instructions[mode] ?? instructions.mix;
}

function buildDifficultyInstruction(difficulty) {
  const instructions = {
    easy: "Keep questions straightforward, definition-based, and easier to answer.",
    medium: "Keep questions balanced with moderate reasoning and concept application.",
    difficult: "Make questions more challenging with deeper reasoning, inference, and conceptual nuance.",
  };

  return instructions[difficulty] ?? instructions.medium;
}

function buildTextPrompt(mode, difficulty, text, sourceLabel) {
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: ${sourceLabel}

Source text:
${text.trim()}`;
}

function buildVisionPrompt(mode, difficulty, attachments) {
  const names = attachments.map((item) => item.name).join(", ");
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: image/photo
Image files: ${names}

Look carefully at the image content and generate study questions from the visible material. If there is text in the image, use it. If there are diagrams, charts, pages, notes, whiteboards, or textbook photos, incorporate the visual content into the questions.`;
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

function getDbClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    return null;
  }

  return createClient({ url, authToken });
}

async function ensureSchema(db) {
  if (!db) {
    return;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = db.execute(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        difficulty TEXT NOT NULL DEFAULT 'medium',
        source_kind TEXT NOT NULL,
        source_names TEXT,
        input_text TEXT,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        model_used TEXT NOT NULL,
        questions_json TEXT NOT NULL
      )
    `);
  }

  await schemaReadyPromise;
}

function buildSourceKind(text, attachments) {
  if (text) {
    return "text";
  }

  const kinds = new Set(attachments.map((item) => item.type));
  if (kinds.size === 1) {
    return attachments[0]?.type ?? "unknown";
  }

  return "mixed";
}

async function storeSession({ mode, difficulty, sourceKind, sourceNames, inputText, attachmentCount, modelUsed, questions }) {
  const db = getDbClient();
  if (!db) {
    return { stored: false, reason: "Turso environment variables not configured." };
  }

  await ensureSchema(db);

  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  await db.execute({
    sql: `INSERT INTO study_sessions (
      id, created_at, mode, difficulty, source_kind, source_names, input_text, attachment_count, model_used, questions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      new Date().toISOString(),
      mode,
      difficulty,
      sourceKind,
      sourceNames.join(", "),
      inputText,
      attachmentCount,
      modelUsed,
      JSON.stringify(questions),
    ],
  });

  return { stored: true, sessionId: id };
}

async function listSessions() {
  const db = getDbClient();
  if (!db) {
    return [];
  }

  await ensureSchema(db);
  const result = await db.execute(`
    SELECT id, created_at, mode, difficulty, source_kind, source_names, attachment_count, model_used
    FROM study_sessions
    ORDER BY created_at DESC
    LIMIT 30
  `);

  return result.rows.map((row) => ({
    id: String(row.id),
    created_at: String(row.created_at),
    mode: String(row.mode),
    difficulty: String(row.difficulty ?? "medium"),
    source_kind: String(row.source_kind),
    source_names: String(row.source_names ?? ""),
    attachment_count: Number(row.attachment_count ?? 0),
    model_used: String(row.model_used),
  }));
}

async function getSessionById(id) {
  const db = getDbClient();
  if (!db) {
    return null;
  }

  await ensureSchema(db);
  const result = await db.execute({
    sql: `
      SELECT id, created_at, mode, difficulty, source_kind, source_names, attachment_count, model_used, questions_json
      FROM study_sessions
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    created_at: String(row.created_at),
    mode: String(row.mode),
    difficulty: String(row.difficulty ?? "medium"),
    source_kind: String(row.source_kind),
    source_names: String(row.source_names ?? ""),
    attachment_count: Number(row.attachment_count ?? 0),
    model_used: String(row.model_used),
    questions: JSON.parse(String(row.questions_json ?? "{}")),
  };
}

async function callGroq({ apiKey, model, messages, maxTokens = 2048 }) {
  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
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
    throw new Error(detail);
  }

  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Groq returned an empty response");
  }

  return normalizeQuestionSet(parseModelJson(raw));
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return makeResponse(200, {});
  }

  if (request.method === "GET") {
    try {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = await getSessionById(sessionId);
        if (!session) {
          return makeResponse(404, { detail: "Session not found" });
        }
        return makeResponse(200, { session });
      }
      const sessions = await listSessions();
      return makeResponse(200, { sessions });
    } catch (error) {
      return makeResponse(500, {
        detail: error instanceof Error ? error.message : "Failed to load history",
      });
    }
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
  const difficulty = String(body?.difficulty ?? "medium");
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

  if (!ALLOWED_MODES.has(mode)) {
    return makeResponse(422, { detail: `Invalid mode. Must be one of: ${Array.from(ALLOWED_MODES).join(", ")}` });
  }
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) {
    return makeResponse(422, { detail: `Invalid difficulty. Must be one of: ${Array.from(ALLOWED_DIFFICULTIES).join(", ")}` });
  }

  if (!text && attachments.length === 0) {
    return makeResponse(422, { detail: "Please provide notes, a PDF, or an image." });
  }

  if (text && attachments.length > 0) {
    return makeResponse(422, { detail: "Use either pasted text or file attachments, not both." });
  }

  try {
    let questions;
    let modelUsed;

    if (text) {
      if (text.length < 10) {
        return makeResponse(422, { detail: "Text too short (min 10 characters)" });
      }
      if (text.length > 12000) {
        return makeResponse(422, { detail: "Text too long (max 12000 characters)" });
      }

      modelUsed = TEXT_MODEL;
        questions = await callGroq({
          apiKey,
          model: modelUsed,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildTextPrompt(mode, difficulty, text, "pasted notes") },
          ],
        });
    } else {
      const hasImage = attachments.some((item) => item?.type === "image" && typeof item?.dataUrl === "string");
      const pdfText = attachments
        .filter((item) => item?.type === "pdf")
        .map((item) => String(item?.extractedText ?? "").trim())
        .filter(Boolean)
        .join("\n\n");

      if (hasImage) {
        modelUsed = VISION_MODEL;
        const imageParts = attachments
          .filter((item) => item?.type === "image" && typeof item?.dataUrl === "string")
          .slice(0, 5)
          .map((item) => ({
            type: "image_url",
            image_url: {
              url: item.dataUrl,
            },
          }));

        questions = await callGroq({
          apiKey,
          model: modelUsed,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildVisionPrompt(mode, difficulty, attachments),
                },
                ...imageParts,
              ],
            },
          ],
          maxTokens: 2500,
        });
      } else {
        if (!pdfText) {
          return makeResponse(422, { detail: "No usable PDF text was found." });
        }
        if (pdfText.length > 12000) {
          return makeResponse(422, { detail: "PDF text is too long (max 12000 characters)." });
        }

        modelUsed = TEXT_MODEL;
        questions = await callGroq({
          apiKey,
          model: modelUsed,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildTextPrompt(mode, difficulty, pdfText, "pdf") },
          ],
        });
      }

      await storeSession({
        mode,
        difficulty,
        sourceKind: buildSourceKind("", attachments),
        sourceNames: attachments.map((item) => String(item?.name ?? "attachment")),
        inputText: pdfText || null,
        attachmentCount: attachments.length,
        modelUsed,
        questions,
      }).catch((error) => {
        console.error("Failed to store session in Turso:", error);
      });

      return makeResponse(200, questions);
    }

    await storeSession({
      mode,
      difficulty,
      sourceKind: "text",
      sourceNames: [],
      inputText: text,
      attachmentCount: 0,
      modelUsed,
      questions,
    }).catch((error) => {
      console.error("Failed to store session in Turso:", error);
    });

    return makeResponse(200, questions);
  } catch (error) {
    return makeResponse(500, {
      detail: error instanceof Error ? error.message : "Server error",
    });
  }
}
