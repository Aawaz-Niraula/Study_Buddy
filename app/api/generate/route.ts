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

type AttachmentPayload = {
  name?: string;
  type?: "pdf" | "image";
  extractedText?: string;
  dataUrl?: string;
  mimeType?: string;
  origin?: "upload" | "camera";
};

type SourcePayload =
  | { text: string }
  | { text: string; attachments: Array<{ name?: string; type?: "pdf" | "image" }> }
  | { attachments: AttachmentPayload[] };

let schemaReadyPromise: Promise<unknown> | undefined;

function makeResponse(status: number, body: unknown) {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    },
  });
}

function buildModeInstruction(mode: string) {
  const instructions: Record<string, string> = {
    "multiple-choice": "Generate 8 to 10 multiple-choice questions only. Set all other arrays to [].",
    flashcard: "Generate 10 to 15 flashcards only. Set all other arrays to [].",
    "short-answer": "Generate 10 short-answer questions only. Set all other arrays to [].",
    "true-false": "Generate 12 true/false questions only. Set all other arrays to [].",
    mix: "Generate a balanced mix: 4 multiple-choice, 3 short-answer, 3 true/false, and 4 flashcards.",
  };
  return instructions[mode] ?? instructions.mix;
}

function buildDifficultyInstruction(difficulty: string) {
  const instructions: Record<string, string> = {
    easy: "Keep questions straightforward and easier to answer.",
    medium: "Keep questions balanced with moderate reasoning and concept application.",
    difficult: "Make questions more challenging with deeper reasoning and nuance.",
  };
  return instructions[difficulty] ?? instructions.medium;
}

function buildTextPrompt(mode: string, difficulty: string, sourceLabel: string, text: string) {
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: ${sourceLabel}

Source text:
${text.trim()}`;
}

function buildVisionPrompt(mode: string, difficulty: string, attachments: AttachmentPayload[]) {
  return `${buildModeInstruction(mode)}
${buildDifficultyInstruction(difficulty)}

Source type: image/photo
Image files: ${attachments.map((item) => item.name).join(", ")}

Look carefully at the images and generate study questions from the visible material.`;
}

function normalizeQuestionSet(data: unknown) {
  const normalized = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  for (const key of ["multiple_choice", "short_answer", "true_false", "flashcards"]) {
    if (!Array.isArray(normalized[key])) normalized[key] = [];
  }
  return normalized;
}

function parseModelJson(rawContent: string) {
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

async function ensureSchema(db: ReturnType<typeof createClient> | null) {
  if (!db) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_payload_json TEXT NOT NULL,
        generations_json TEXT NOT NULL,
        test_submissions_json TEXT NOT NULL DEFAULT '[]',
        latest_mode TEXT NOT NULL,
        latest_difficulty TEXT NOT NULL
      )`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_app_sessions_updated_at ON app_sessions(updated_at DESC)`);
      try {
        await db.execute(`ALTER TABLE app_sessions ADD COLUMN test_submissions_json TEXT NOT NULL DEFAULT '[]'`);
      } catch {}
    })();
  }
  await schemaReadyPromise;
}

function summarizeTitle(sourceKind: string, sourcePayload: SourcePayload) {
  if (sourceKind === "text") {
    const text = String((sourcePayload as { text?: string }).text ?? "").trim().replace(/\s+/g, " ");
    return text.slice(0, 42) || "Notes session";
  }
  const names = Array.isArray((sourcePayload as { attachments?: AttachmentPayload[] }).attachments)
    ? (sourcePayload as { attachments: AttachmentPayload[] }).attachments.map((item) => item.name).filter(Boolean)
    : [];
  return names[0] || `${sourceKind === "pdf" ? "PDF" : "Photo"} session`;
}

function detectSourceKind(text: string, attachments: AttachmentPayload[]) {
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

async function getSessionById(id: string) {
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
  const testSubmissions = JSON.parse(String(row.test_submissions_json ?? "[]"));
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
    test_submissions: testSubmissions,
    latest_generation: generations[generations.length - 1] ?? null,
  };
}

async function deleteSession(id: string) {
  const db = getDbClient();
  if (!db) return;
  await ensureSchema(db);
  await db.execute({ sql: `DELETE FROM app_sessions WHERE id = ?`, args: [id] });
}

async function saveGeneration({
  sessionId,
  sourceKind,
  sourcePayload,
  mode,
  difficulty,
  modelUsed,
  questions,
}: {
  sessionId: string | null;
  sourceKind: string;
  sourcePayload: SourcePayload;
  mode: string;
  difficulty: string;
  modelUsed: string;
  questions: unknown;
}) {
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

async function saveTestSubmission({
  sessionId,
  submission,
}: {
  sessionId: string;
  submission: Record<string, unknown>;
}) {
  const db = getDbClient();
  if (!db) return;
  await ensureSchema(db);
  const existing = await getSessionById(sessionId);
  if (!existing) throw new Error("Session not found.");
  const submissions = [...(existing.test_submissions ?? []), submission];
  await db.execute({
    sql: `UPDATE app_sessions SET updated_at = ?, test_submissions_json = ? WHERE id = ?`,
    args: [new Date().toISOString(), JSON.stringify(submissions), sessionId],
  });
}

async function callGroq({ apiKey, model, messages, maxTokens = 2048 }: { apiKey: string; model: string; messages: unknown[]; maxTokens?: number }) {
  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.6, top_p: 0.92 }),
  });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error((payload as { error?: { message?: string }; detail?: string })?.error?.message || (payload as { detail?: string })?.detail || `API error (${upstream.status})`);
  const raw = (payload as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Model returned an empty response");
  return raw;
}

async function callGroqJson({ apiKey, model, messages, maxTokens = 2048 }: { apiKey: string; model: string; messages: unknown[]; maxTokens?: number }) {
  return parseModelJson(await callGroq({ apiKey, model, messages, maxTokens }));
}

async function generateQuestions({
  apiKey,
  sourceKind,
  sourcePayload,
  mode,
  difficulty,
}: {
  apiKey: string;
  sourceKind: string;
  sourcePayload: SourcePayload;
  mode: string;
  difficulty: string;
}) {
  if (sourceKind === "text" || sourceKind === "pdf") {
    const text = String((sourcePayload as { text?: string }).text ?? "").trim();
    if (text.length < 10) throw new Error("Text too short (min 10 characters)");
    if (text.length > 12000) throw new Error("Text too long (max 12000 characters)");
    const questions = normalizeQuestionSet(await callGroqJson({
      apiKey,
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildTextPrompt(mode, difficulty, sourceKind === "text" ? "notes" : "pdf", text) },
      ],
    }));
    return { questions, modelUsed: TEXT_MODEL };
  }

  const attachments = Array.isArray((sourcePayload as { attachments?: AttachmentPayload[] }).attachments)
    ? (sourcePayload as { attachments: AttachmentPayload[] }).attachments
    : [];
  const imageParts = attachments.slice(0, 5).map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } }));
  if (!imageParts.length) throw new Error("No usable images were found.");
  const questions = normalizeQuestionSet(await callGroqJson({
    apiKey,
    model: VISION_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: buildVisionPrompt(mode, difficulty, attachments) }, ...imageParts] },
    ],
    maxTokens: 2500,
  }));
  return { questions, modelUsed: VISION_MODEL };
}

function flattenQuestions(questionSet: Record<string, unknown>) {
  const result: Array<Record<string, unknown>> = [];
  for (const item of (Array.isArray(questionSet.multiple_choice) ? questionSet.multiple_choice : [])) {
    result.push({ kind: "multiple-choice", ...item as object });
  }
  for (const item of (Array.isArray(questionSet.true_false) ? questionSet.true_false : [])) {
    result.push({ kind: "true-false", ...item as object });
  }
  for (const item of (Array.isArray(questionSet.short_answer) ? questionSet.short_answer : [])) {
    result.push({ kind: "short-answer", ...item as object });
  }
  return result;
}

function samplePreviousQuestions(sessions: Array<Record<string, unknown>>, limit = 6) {
  const bag: Array<Record<string, unknown>> = [];
  for (const session of sessions) {
    const generations = Array.isArray(session.generations) ? session.generations : [];
    for (const generation of generations.slice(-2)) {
      bag.push(...flattenQuestions((generation as { questions?: Record<string, unknown> }).questions ?? {}));
    }
  }
  return bag.slice(0, limit);
}

async function generateTest({
  apiKey,
  session,
  includePrevious,
}: {
  apiKey: string;
  session: Awaited<ReturnType<typeof getSessionById>>;
  includePrevious: boolean;
}) {
  if (!session) throw new Error("Session not found.");
  const sourceKind = session.source_kind;
  const sourcePayload = session.source_payload as SourcePayload;
  let contextText = "";

  if (sourceKind === "text" || sourceKind === "pdf") {
    contextText = String((sourcePayload as { text?: string }).text ?? "").trim();
  } else {
    contextText = "Generate a test from the uploaded images in this current session.";
  }

  let previousContext = "";
  if (includePrevious) {
    const sessions = await listSessions();
    const others = [];
    for (const item of sessions) {
      if (item.id === session.id) continue;
      const full = await getSessionById(item.id);
      if (full) others.push(full);
      if (others.length >= 4) break;
    }
    const sampled = samplePreviousQuestions(others);
    if (sampled.length) {
      previousContext = `\nAlso include a mix of concepts inspired by these previous study questions:\n${JSON.stringify(sampled)}`;
    }
  }

  const prompt = `Create a closed-book test for this student.
Generate:
- 6 multiple-choice
- 4 true/false
- 3 short-answer

Use the current session as the main source.${includePrevious ? " Blend in a few ideas from previous sessions too." : ""}

Current session context:
${contextText}${previousContext}`;

  const questions = sourceKind === "image"
    ? normalizeQuestionSet(await callGroqJson({
        apiKey,
        model: VISION_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [{ type: "text", text: prompt }, ...((sourcePayload as { attachments?: AttachmentPayload[] }).attachments ?? []).slice(0, 5).map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } }))] },
        ],
        maxTokens: 2500,
      }))
    : normalizeQuestionSet(await callGroqJson({
        apiKey,
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        maxTokens: 2200,
      }));

  return questions;
}

async function evaluateShortAnswers({
  apiKey,
  questions,
  answers,
}: {
  apiKey: string;
  questions: Array<{ question?: string; answer?: string }>;
  answers: Record<string, string>;
}) {
  if (!questions.length) return { score: 0, total: 0, evaluations: [] as Array<Record<string, unknown>> };
  const prompt = `Evaluate each student answer against the expected answer.
Return JSON only in this format:
{"evaluations":[{"index":0,"correct":true,"feedback":"..."}]}

Questions:
${JSON.stringify(questions.map((q, i) => ({ index: i, question: q.question, expected_answer: q.answer, student_answer: answers[`sa-${i}`] ?? "" })))}`;

  const result = await callGroqJson({
    apiKey,
    model: TEXT_MODEL,
    messages: [
      { role: "system", content: "You are a strict but fair grading assistant. Return JSON only." },
      { role: "user", content: prompt },
    ],
    maxTokens: 1200,
  }) as { evaluations?: Array<{ index?: number; correct?: boolean; feedback?: string }> };

  const evaluations = Array.isArray(result.evaluations) ? result.evaluations : [];
  return {
    score: evaluations.filter((item) => item.correct).length,
    total: questions.length,
    evaluations,
  };
}

export async function OPTIONS() {
  return makeResponse(200, {});
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const session = await getSessionById(sessionId);
      if (!session) return makeResponse(404, { detail: "Session not found" });
      return makeResponse(200, { session });
    }
    return makeResponse(200, { sessions: await listSessions() });
  } catch (error) {
    return makeResponse(500, { detail: error instanceof Error ? error.message : "Server error" });
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return makeResponse(400, { detail: "sessionId is required" });
    await deleteSession(sessionId);
    return makeResponse(200, { ok: true });
  } catch (error) {
    return makeResponse(500, { detail: error instanceof Error ? error.message : "Server error" });
  }
}

export async function POST(request: Request) {
  try {
    if (!process.env.GROQ_API_KEY) return makeResponse(500, { detail: "GROQ_API_KEY not configured" });

    const body = await request.json().catch(() => null);
    if (!body) return makeResponse(400, { detail: "Invalid JSON body" });

    const action = String((body as { action?: string }).action ?? "generate");
    const mode = String((body as { mode?: string }).mode ?? "mix");
    const difficulty = String((body as { difficulty?: string }).difficulty ?? "medium");
    const text = String((body as { text?: string }).text ?? "").trim();
    const attachments = Array.isArray((body as { attachments?: AttachmentPayload[] }).attachments) ? (body as { attachments: AttachmentPayload[] }).attachments : [];
    const sessionId = (body as { sessionId?: string }).sessionId ? String((body as { sessionId?: string }).sessionId) : null;

    if (action === "generate_test") {
      if (!sessionId) return makeResponse(422, { detail: "sessionId is required for tests." });
      const session = await getSessionById(sessionId);
      if (!session) return makeResponse(404, { detail: "Session not found" });
      const testQuestions = await generateTest({
        apiKey: process.env.GROQ_API_KEY,
        session,
        includePrevious: Boolean((body as { includePrevious?: boolean }).includePrevious),
      });
      return makeResponse(200, { questions: testQuestions });
    }

    if (action === "submit_test") {
      if (!sessionId) return makeResponse(422, { detail: "sessionId is required for test submission." });
      const submission = (body as { submission?: Record<string, unknown> }).submission;
      if (!submission) return makeResponse(422, { detail: "submission is required." });
      await saveTestSubmission({ sessionId, submission });
      return makeResponse(200, { ok: true });
    }

    if (action === "grade_short_answers") {
      const questions = Array.isArray((body as { questions?: Array<{ question?: string; answer?: string }> }).questions) ? (body as { questions: Array<{ question?: string; answer?: string }> }).questions : [];
      const answers = typeof (body as { answers?: Record<string, string> }).answers === "object" && (body as { answers?: Record<string, string> }).answers !== null ? (body as { answers: Record<string, string> }).answers : {};
      return makeResponse(200, await evaluateShortAnswers({
        apiKey: process.env.GROQ_API_KEY,
        questions,
        answers,
      }));
    }

    if (!ALLOWED_MODES.has(mode)) return makeResponse(422, { detail: "Invalid question format." });
    if (!ALLOWED_DIFFICULTIES.has(difficulty)) return makeResponse(422, { detail: "Invalid difficulty." });

    let sourceKind: string | null;
    let sourcePayload: SourcePayload;

    if (sessionId) {
      const existing = await getSessionById(sessionId);
      if (!existing) return makeResponse(404, { detail: "Session not found" });
      sourceKind = existing.source_kind;
      sourcePayload = existing.source_payload as SourcePayload;
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
