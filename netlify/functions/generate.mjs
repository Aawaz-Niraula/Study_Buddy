import { createClient } from "@libsql/client";

const TEXT_MODEL = "llama-3.1-8b-instant";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const ALLOWED_MODES = new Set(["multiple-choice", "flashcard", "short-answer", "true-false", "mix"]);
const ALLOWED_DIFFICULTIES = new Set(["easy", "medium", "difficult"]);

const SYSTEM_PROMPT = `You are a university-level study assistant. Generate high-quality study questions targeting key concepts.

You MUST output valid JSON only with no markdown, code fences, or explanation.

Output format:
{
  "multiple_choice": [{"question": "", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A"}],
  "short_answer": [{"question": "", "answer": ""}],
  "true_false": [{"statement": "", "answer": "True"}],
  "flashcards": [{"question": "", "answer": ""}]
}`;

let schemaReadyPromise;

function makeResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    },
  });
}

function buildModeInstruction(mode) {
  const instructions = {
    "multiple-choice": "Generate 8 to 10 multiple-choice questions only. Set all other arrays to [].",
    flashcard: "Generate 10 to 15 flashcards only. Set all other arrays to [].",
    "short-answer": "Generate 10 short-answer questions only. Set all other arrays to [].",
    "true-false": "Generate 12 true/false questions only. Set all other arrays to [].",
    mix: "Generate a balanced mix: 4 multiple-choice, 3 short-answer, 3 true/false, and 4 flashcards.",
  };
  return instructions[mode] ?? instructions.mix;
}

function buildDifficultyInstruction(difficulty) {
  const instructions = {
    easy: "Keep questions straightforward and easier to answer.",
    medium: "Keep questions balanced with moderate reasoning and concept application.",
    difficult: "Make questions more challenging with deeper reasoning and nuance.",
  };
  return instructions[difficulty] ?? instructions.medium;
}

function buildTextPrompt(mode, difficulty, sourceLabel, text) {
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: ${sourceLabel}

Source text:
${text.trim()}`;
}

function buildVisionPrompt(mode, difficulty, attachments) {
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: image/photo
Image files: ${attachments.map((item) => item.name).join(", ")}

Look carefully at the images and generate study questions from the visible material.`;
}

function normalizeQuestionSet(data) {
  const normalized = typeof data === "object" && data !== null ? data : {};
  for (const key of ["multiple_choice", "short_answer", "true_false", "flashcards"]) {
    if (!Array.isArray(normalized[key])) normalized[key] = [];
  }
  return normalized;
}

function parseModelJson(rawContent) {
  const stripped = String(rawContent).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model response");
  return JSON.parse(stripped.slice(start, end + 1));
}

function getDbClient() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return null;
  return createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function ensureSchema(db) {
  if (!db) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = db.batch([
      `CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_payload_json TEXT NOT NULL,
        generations_json TEXT NOT NULL,
        latest_mode TEXT NOT NULL,
        latest_difficulty TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_app_sessions_updated_at ON app_sessions(updated_at DESC)`,
    ], "write");
  }
  await schemaReadyPromise;
}

function summarizeTitle(sourceKind, sourcePayload) {
  if (sourceKind === "text") {
    const text = String(sourcePayload.text ?? "").trim().replace(/\s+/g, " ");
    return text.slice(0, 42) || "Notes session";
  }
  const names = Array.isArray(sourcePayload.attachments) ? sourcePayload.attachments.map((item) => item.name).filter(Boolean) : [];
  return names[0] || `${sourceKind === "pdf" ? "PDF" : "Photo"} session`;
}

function detectSourceKind(text, attachments) {
  if (text) return "text";
  if (!attachments.length) return null;
  const hasPdf = attachments.some((item) => item?.type === "pdf");
  const hasImage = attachments.some((item) => item?.type === "image");
  if (hasPdf && hasImage) throw new Error("Use only one source type per session.");
  if (hasPdf) return "pdf";
  if (hasImage) return "image";
  throw new Error("Unsupported attachment type.");
}

async function listSessions() {
  const db = getDbClient();
  if (!db) return [];
  await ensureSchema(db);
  const result = await db.execute(`SELECT id, created_at, updated_at, title, source_kind, latest_mode, latest_difficulty FROM app_sessions ORDER BY updated_at DESC LIMIT 50`);
  return result.rows.map((row) => ({
    id: String(row.id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    title: String(row.title),
    source_kind: String(row.source_kind),
    latest_mode: String(row.latest_mode),
    latest_difficulty: String(row.latest_difficulty),
  }));
}

async function getSessionById(id) {
  const db = getDbClient();
  if (!db) return null;
  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT * FROM app_sessions WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  const generations = JSON.parse(String(row.generations_json ?? "[]"));
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    title: String(row.title),
    source_kind: String(row.source_kind),
    source_payload: JSON.parse(String(row.source_payload_json ?? "{}")),
    latest_mode: String(row.latest_mode),
    latest_difficulty: String(row.latest_difficulty),
    generations,
    latest_generation: generations[generations.length - 1] ?? null,
  };
}

async function deleteSession(id) {
  const db = getDbClient();
  if (!db) return;
  await ensureSchema(db);
  await db.execute({ sql: `DELETE FROM app_sessions WHERE id = ?`, args: [id] });
}

async function saveGeneration({ sessionId, sourceKind, sourcePayload, mode, difficulty, modelUsed, questions }) {
  const db = getDbClient();
  if (!db) return { sessionId: sessionId ?? null, stored: false };
  await ensureSchema(db);

  const now = new Date().toISOString();
  const generation = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    created_at: now,
    mode,
    difficulty,
    model_used: modelUsed,
    questions,
  };

  if (sessionId) {
    const existing = await getSessionById(sessionId);
    if (!existing) throw new Error("Session not found.");
    const generations = [...existing.generations, generation];
    await db.execute({
      sql: `UPDATE app_sessions SET updated_at = ?, title = ?, source_payload_json = ?, generations_json = ?, latest_mode = ?, latest_difficulty = ? WHERE id = ?`,
      args: [now, summarizeTitle(sourceKind, sourcePayload), JSON.stringify(sourcePayload), JSON.stringify(generations), mode, difficulty, sessionId],
    });
    return { sessionId, stored: true };
  }

  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await db.execute({
    sql: `INSERT INTO app_sessions (id, created_at, updated_at, title, source_kind, source_payload_json, generations_json, latest_mode, latest_difficulty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, now, now, summarizeTitle(sourceKind, sourcePayload), sourceKind, JSON.stringify(sourcePayload), JSON.stringify([generation]), mode, difficulty],
  });
  return { sessionId: id, stored: true };
}

async function callGroq({ apiKey, model, messages, maxTokens = 2048 }) {
  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.6, top_p: 0.92 }),
  });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(payload?.error?.message || payload?.detail || `API error (${upstream.status})`);
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Model returned an empty response");
  return normalizeQuestionSet(parseModelJson(raw));
}

async function generateQuestions({ apiKey, sourceKind, sourcePayload, mode, difficulty }) {
  if (sourceKind === "text" || sourceKind === "pdf") {
    const text = String(sourcePayload.text ?? "").trim();
    if (text.length < 10) throw new Error("Text too short (min 10 characters)");
    if (text.length > 12000) throw new Error("Text too long (max 12000 characters)");
    const questions = await callGroq({
      apiKey,
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildTextPrompt(mode, difficulty, sourceKind === "text" ? "notes" : "pdf", text) },
      ],
    });
    return { questions, modelUsed: TEXT_MODEL };
  }

  const attachments = Array.isArray(sourcePayload.attachments) ? sourcePayload.attachments : [];
  const imageParts = attachments.slice(0, 5).map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } }));
  if (!imageParts.length) throw new Error("No usable images were found.");
  const questions = await callGroq({
    apiKey,
    model: VISION_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: buildVisionPrompt(mode, difficulty, attachments) }, ...imageParts] },
    ],
    maxTokens: 2500,
  });
  return { questions, modelUsed: VISION_MODEL };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") return makeResponse(200, {});

  try {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = await getSessionById(sessionId);
        if (!session) return makeResponse(404, { detail: "Session not found" });
        return makeResponse(200, { session });
      }
      return makeResponse(200, { sessions: await listSessions() });
    }

    if (request.method === "DELETE") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return makeResponse(400, { detail: "sessionId is required" });
      await deleteSession(sessionId);
      return makeResponse(200, { ok: true });
    }

    if (request.method !== "POST") return makeResponse(405, { detail: "Method not allowed" });

    if (!process.env.GROQ_API_KEY) return makeResponse(500, { detail: "GROQ_API_KEY not configured" });

    const body = await request.json().catch(() => null);
    if (!body) return makeResponse(400, { detail: "Invalid JSON body" });

    const mode = String(body.mode ?? "mix");
    const difficulty = String(body.difficulty ?? "medium");
    const text = String(body.text ?? "").trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const sessionId = body.sessionId ? String(body.sessionId) : null;

    if (!ALLOWED_MODES.has(mode)) return makeResponse(422, { detail: "Invalid question format." });
    if (!ALLOWED_DIFFICULTIES.has(difficulty)) return makeResponse(422, { detail: "Invalid difficulty." });

    let sourceKind;
    let sourcePayload;

    if (sessionId) {
      const existing = await getSessionById(sessionId);
      if (!existing) return makeResponse(404, { detail: "Session not found" });
      sourceKind = existing.source_kind;
      sourcePayload = existing.source_payload;
    } else {
      sourceKind = detectSourceKind(text, attachments);
      if (!sourceKind) return makeResponse(422, { detail: "Please add notes, one PDF, or one or more photos." });
      if (sourceKind === "pdf" && attachments.length !== 1) return makeResponse(422, { detail: "Only one PDF can be used in a session." });
      sourcePayload = sourceKind === "text"
        ? { text }
        : sourceKind === "pdf"
          ? { text: String(attachments[0]?.extractedText ?? ""), attachments: attachments.map((item) => ({ name: item.name, type: item.type })) }
          : { attachments: attachments.map((item) => ({ name: item.name, type: item.type, dataUrl: item.dataUrl, mimeType: item.mimeType, origin: item.origin })) };
    }

    const { questions, modelUsed } = await generateQuestions({
      apiKey: process.env.GROQ_API_KEY,
      sourceKind,
      sourcePayload,
      mode,
      difficulty,
    });

    const saved = await saveGeneration({ sessionId, sourceKind, sourcePayload, mode, difficulty, modelUsed, questions });
    return makeResponse(200, { questions, sessionId: saved.sessionId, sourceKind, latestMode: mode, latestDifficulty: difficulty });
  } catch (error) {
    return makeResponse(500, { detail: error instanceof Error ? error.message : "Server error" });
  }
}
