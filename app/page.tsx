"use client";
import { useState } from "react";
import { Sparkles, BookOpen, ToggleLeft, AlignLeft, Layers, ChevronDown, ChevronUp, Ellipsis, X, Plus, Trash2, CircleHelp, ClipboardCheck } from "lucide-react";

declare global {
  interface Window {
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (source: { data: Uint8Array }) => {
        promise: Promise<{
          numPages: number;
          getPage: (pageNumber: number) => Promise<{
            getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
          }>;
        }>;
      };
    };
  }
}

const modeOptions = [
  { value: "mix", label: "Mixed", icon: Layers },
  { value: "multiple-choice", label: "Multiple Choice", icon: BookOpen },
  { value: "short-answer", label: "Short Answer", icon: AlignLeft },
  { value: "true-false", label: "True / False", icon: ToggleLeft },
  { value: "flashcard", label: "Flashcards", icon: Sparkles },
];

const difficultyOptions = ["easy", "medium", "difficult"] as const;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;

type SourceKind = "text" | "pdf" | "image" | null;
type Attachment = { id: string; name: string; type: "pdf" | "image"; extractedText?: string; mimeType: string; dataUrl?: string; origin: "upload" | "camera"; };
type QuestionSet = { multiple_choice?: any[]; short_answer?: any[]; true_false?: any[]; flashcards?: any[]; };
type Generation = { id: string; created_at: string; mode: string; difficulty: string; questions: QuestionSet; };
type SessionListItem = { id: string; title: string; updated_at: string; latest_mode: string; latest_difficulty: string; source_kind: string; };
type TestAnswers = Record<string, string>;
type ShortAnswerEvaluation = { index?: number; correct?: boolean; feedback?: string; };
type TestSubmission = { id: string; created_at: string; score: number; total: number; answers: TestAnswers; questions: QuestionSet; shortAnswerEvaluations?: ShortAnswerEvaluation[]; };

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0} html,body{min-height:100%;background:linear-gradient(180deg,#06060b 0%,#0b0b12 45%,#11111a 100%);overflow-x:hidden;overscroll-behavior-y:none;-webkit-overflow-scrolling:touch} body{overflow-x:hidden}
  textarea:focus{outline:none} textarea::placeholder{color:#857ca2}
  ::selection{background:#a78bfa44;color:#f2efff} ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-thumb{background:#857ca2;border-radius:99px}
  @keyframes fade-up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}} @keyframes dot-bounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-5px);opacity:1}}
  @keyframes slide-in-left{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:translateX(0)}}
  @keyframes slide-in-right{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:translateX(0)}}
  .top-actions{position:fixed;top:18px;left:18px;right:18px;z-index:30;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
  .top-actions .push-right{margin-left:auto}
  .mobile-sheet{width:min(360px,calc(100vw - 32px))}
  .content-shell{max-width:820px;margin:0 auto;padding:120px 24px 96px;position:relative;z-index:1}
  .result-grid{margin-top:28px;display:grid;gap:28px;animation:fade-up .5s both}
  .side-panel{position:fixed;top:76px;z-index:25;border-radius:22px;padding:16px;background:rgba(11,11,18,.96);border:1px solid rgba(167,139,250,.18);max-height:calc(100vh - 92px);overflow-y:auto}
  .side-panel.left{left:16px;width:min(360px,calc(100vw - 32px));animation:slide-in-left .22s ease-out both}
  .side-panel.right{right:16px;width:min(360px,calc(100vw - 32px));animation:slide-in-right .22s ease-out both}
  @media (max-width: 768px){
    .content-shell{padding:150px 16px 72px}
    .top-actions{top:14px;left:14px;right:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .top-actions .push-right{margin-left:0}
    .top-actions button{width:100%;justify-content:center}
    .mobile-sheet{width:calc(100vw - 28px)}
    .side-panel{top:130px;max-height:calc(100vh - 146px)}
    .side-panel.left,.side-panel.right{left:14px;right:14px;width:auto}
    .result-grid{gap:18px}
  }
`;

let pdfJsLoader: Promise<void> | null = null;

function SectionLabel({ text, color }: { text: string; color: string }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><div style={{ width: 5, height: 5, borderRadius: "50%", background: color }} /><span style={{ fontSize: 11, letterSpacing: 3, color, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{text}</span><div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${color}44, transparent)` }} /></div>;
}

function Glass({ children }: { children: React.ReactNode }) {
  return <div style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.035), rgba(255,255,255,0.012))", backdropFilter: "blur(20px)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 24, padding: 24, boxShadow: "0 24px 70px rgba(0,0,0,0.32)" }}>{children}</div>;
}

function Flashcard({ q, idx }: { q: any; idx: number }) {
  const [flipped, setFlipped] = useState(false);
  return <button onClick={() => setFlipped((v) => !v)} style={{ width: "100%", textAlign: "left", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 16, padding: 18, color: "#f2efff", cursor: "pointer" }}><div style={{ fontSize: 10, color: "#f9a8d4", fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")} • {flipped ? "ANSWER" : "TAP TO REVEAL"}</div><div style={{ fontSize: 14, fontFamily: "'DM Mono', monospace", lineHeight: 1.7 }}>{flipped ? q.answer : q.question}</div></button>;
}

function ShortAnswerCard({ q, idx }: { q: any; idx: number; delay?: number }) {
  const [revealed, setRevealed] = useState(false);
  return <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(249,168,212,0.18)", borderRadius: 16, padding: 18 }}><div style={{ fontSize: 10, color: "#f9a8d4", fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, marginBottom: 12 }}>{q.question}</div>{revealed && <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(249,168,212,0.08)", color: "#fbcfe8", fontFamily: "'DM Mono', monospace", fontSize: 13, marginBottom: 12 }}>{q.answer}</div>}<button type="button" onClick={() => setRevealed((v) => !v)} style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid rgba(249,168,212,0.22)", background: "transparent", color: "#fbcfe8", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{revealed ? "HIDE ANSWER" : "REVEAL ANSWER"}</button></div>;
}

function TrueFalseCard({ q, idx }: { q: any; idx: number; delay?: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const correctAnswer = typeof q.answer === "boolean" ? (q.answer ? "True" : "False") : String(q.answer);
  return <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(248,113,113,0.18)", borderRadius: 16, padding: 18 }}><div style={{ fontSize: 10, color: "#f87171", fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, marginBottom: 14 }}>{q.statement}</div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{["True", "False"].map((option) => { const isChosen = selected === option; const isCorrect = option === correctAnswer; return <button key={option} type="button" onClick={() => setSelected(option)} style={{ padding: "10px 16px", borderRadius: 12, border: `1px solid ${isChosen || isCorrect ? (isCorrect ? "rgba(34,197,94,0.45)" : "rgba(248,113,113,0.4)") : "rgba(255,255,255,0.1)"}`, background: isCorrect ? "rgba(34,197,94,0.18)" : isChosen ? "rgba(248,113,113,0.16)" : "rgba(255,255,255,0.03)", color: isCorrect ? "#22c55e" : isChosen ? "#f87171" : "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{option}</button>; })}</div></div>;
}

function MCQRevealCard({ q, idx }: { q: any; idx: number }) {
  const [revealed, setRevealed] = useState(false);
  const options = Array.isArray(q.options) ? q.options : [];
  const answerLetter = String(q.answer ?? "").trim().toUpperCase().match(/[A-D]/)?.[0] || "";
  return <Glass><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#a78bfa", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, marginBottom: 14 }}>{q.question}</div><div style={{ display: "grid", gap: 8, marginBottom: 12 }}>{options.map((opt: string, optIndex: number) => { const optionLetter = String(opt).trim().charAt(0).toUpperCase(); const isCorrect = revealed && optionLetter === answerLetter; return <div key={optIndex} style={{ padding: "10px 12px", borderRadius: 10, background: isCorrect ? "rgba(34,197,94,0.16)" : "rgba(255,255,255,0.03)", border: `1px solid ${isCorrect ? "rgba(34,197,94,0.35)" : "rgba(255,255,255,0.06)"}`, color: isCorrect ? "#22c55e" : "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{opt}</div>; })}</div><button type="button" onClick={() => setRevealed((v) => !v)} style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid rgba(167,139,250,0.22)", background: "transparent", color: "#ddd6fe", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{revealed ? `HIDE ANSWER` : "REVEAL ANSWER"}</button>{revealed && <div style={{ marginTop: 10, color: "#22c55e", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>Correct answer: {answerLetter}</div>}</Glass>;
}

function TestMCQCard({ q, idx, answer, onAnswer, showResults }: { q: any; idx: number; answer?: string; onAnswer: (value: string) => void; showResults: boolean; }) {
  const options = Array.isArray(q.options) ? q.options : [];
  const correct = String(q.answer ?? "").trim().toUpperCase().match(/[A-D]/)?.[0] || "";
  return <Glass><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#a78bfa", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, marginBottom: 14 }}>{q.question}</div><div style={{ display: "grid", gap: 8 }}>{options.map((opt: string, i: number) => { const letter = String(opt).trim().charAt(0).toUpperCase(); const isPicked = answer === letter; const isCorrect = showResults && letter === correct; const isWrongPick = showResults && isPicked && letter !== correct; return <button key={i} type="button" onClick={() => onAnswer(letter)} style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, background: isCorrect ? "rgba(34,197,94,0.16)" : isWrongPick ? "rgba(248,113,113,0.16)" : isPicked ? "rgba(167,139,250,0.16)" : "rgba(255,255,255,0.03)", border: `1px solid ${isCorrect ? "rgba(34,197,94,0.35)" : isWrongPick ? "rgba(248,113,113,0.35)" : isPicked ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.06)"}`, color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12, cursor: showResults ? "default" : "pointer" }} disabled={showResults}>{opt}</button>; })}</div>{showResults && <div style={{ marginTop: 10, color: "#22c55e", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>Correct answer: {correct}</div>}</Glass>;
}

function TestTFCard({ q, idx, answer, onAnswer, showResults }: { q: any; idx: number; answer?: string; onAnswer: (value: string) => void; showResults: boolean; }) {
  const correct = typeof q.answer === "boolean" ? (q.answer ? "True" : "False") : String(q.answer);
  return <Glass><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#f87171", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, marginBottom: 14 }}>{q.statement}</div><div style={{ display: "flex", gap: 8 }}>{["True", "False"].map((opt) => { const isPicked = answer === opt; const isCorrect = showResults && opt === correct; const isWrongPick = showResults && isPicked && opt !== correct; return <button key={opt} type="button" onClick={() => onAnswer(opt)} disabled={showResults} style={{ padding: "10px 16px", borderRadius: 12, background: isCorrect ? "rgba(34,197,94,0.16)" : isWrongPick ? "rgba(248,113,113,0.16)" : isPicked ? "rgba(167,139,250,0.16)" : "rgba(255,255,255,0.03)", border: `1px solid ${isCorrect ? "rgba(34,197,94,0.35)" : isWrongPick ? "rgba(248,113,113,0.35)" : isPicked ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.06)"}`, color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12, cursor: showResults ? "default" : "pointer" }}>{opt}</button>; })}</div>{showResults && <div style={{ marginTop: 10, color: "#22c55e", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>Correct answer: {correct}</div>}</Glass>;
}

function TestShortAnswerCard({
  q,
  idx,
  answer,
  onAnswer,
  showResults,
  evaluation,
}: {
  q: any;
  idx: number;
  answer?: string;
  onAnswer: (value: string) => void;
  showResults: boolean;
  evaluation?: ShortAnswerEvaluation;
}) {
  const isCorrect = showResults && evaluation?.correct === true;
  const isWrong = showResults && evaluation?.correct === false;
  return <Glass><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#f9a8d4", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, marginBottom: 14 }}>{q.question}</div><textarea value={answer ?? ""} onChange={(e) => onAnswer(e.target.value)} disabled={showResults} placeholder="Type your answer..." style={{ width: "100%", minHeight: 110, resize: "vertical", background: "rgba(255,255,255,0.03)", border: `1px solid ${isCorrect ? "rgba(34,197,94,0.35)" : isWrong ? "rgba(248,113,113,0.35)" : "rgba(255,255,255,0.08)"}`, borderRadius: 12, padding: "14px 16px", color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12, lineHeight: 1.7 }} />{showResults && <div style={{ display: "grid", gap: 10, marginTop: 12 }}><div style={{ padding: "12px 14px", borderRadius: 12, background: isCorrect ? "rgba(34,197,94,0.12)" : "rgba(248,113,113,0.12)", color: isCorrect ? "#86efac" : "#fca5a5", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{isCorrect ? "Marked correct." : "Marked incorrect."}{evaluation?.feedback ? ` ${evaluation.feedback}` : ""}</div><div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(249,168,212,0.08)", color: "#fbcfe8", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>Correct answer: {q.answer}</div></div>}</Glass>;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) return existing.dataset.loaded === "true" ? resolve() : existing.addEventListener("load", () => resolve(), { once: true });
    const script = document.createElement("script");
    script.src = src; script.async = true; script.crossOrigin = "anonymous";
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

async function extractPdfText(file: File) {
  if (!pdfJsLoader) {
    pdfJsLoader = loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js").then(() => {
      if (!window.pdfjsLib) throw new Error("PDF reader failed to load.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    });
  }
  await pdfJsLoader;
  if (!window.pdfjsLib) throw new Error("PDF reader is unavailable.");
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => item.str?.trim() ?? "").filter(Boolean).join(" "));
  }
  return pages.join("\n");
}

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image file."));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("New session");
  const [sourceKind, setSourceKind] = useState<SourceKind>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mode, setMode] = useState("mix");
  const [difficulty, setDifficulty] = useState<(typeof difficultyOptions)[number]>("medium");
  const [questions, setQuestions] = useState<QuestionSet | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<SessionListItem[]>([]);
  const [helpOpen, setHelpOpen] = useState(true);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const [testPromptOpen, setTestPromptOpen] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testQuestions, setTestQuestions] = useState<QuestionSet | null>(null);
  const [testAnswers, setTestAnswers] = useState<TestAnswers>({});
  const [testSubmitted, setTestSubmitted] = useState(false);
  const [testScore, setTestScore] = useState<{ score: number; total: number } | null>(null);
  const [showTestResults, setShowTestResults] = useState(false);
  const [testSubmissions, setTestSubmissions] = useState<TestSubmission[]>([]);
  const [testHistoryOpen, setTestHistoryOpen] = useState(false);
  const [activeTestSubmissionId, setActiveTestSubmissionId] = useState<string | null>(null);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/generate");
      const data = await res.json().catch(() => ({}));
      setHistory(Array.isArray(data.sessions) ? data.sessions : []);
    } finally {
      setHistoryLoading(false);
    }
  };

  const resetSession = () => {
    setSessionId(null); setSessionTitle("New session"); setSourceKind(null); setText(""); setAttachments([]); setQuestions(null); setGenerations([]); setActiveGenerationId(null); setUploadStatus(""); setError(""); setTestPromptOpen(false); setTestMode(false); setTestQuestions(null); setTestAnswers({}); setTestSubmitted(false); setTestScore(null); setShowTestResults(false); setTestSubmissions([]); setTestHistoryOpen(false); setActiveTestSubmissionId(null);
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) await loadHistory();
  };

  const handleFilesAdded = async (event: React.ChangeEvent<HTMLInputElement>, origin: "upload" | "camera") => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    if (sourceKind === "text" || text.trim()) { setError("This session already uses pasted notes. Click New Session to switch source type."); event.target.value = ""; return; }
    setUploading(true); setError(""); setUploadStatus("Preparing files...");
    try {
      const incomingKind: SourceKind = files[0].type === "application/pdf" || files[0].name.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
      if (sourceKind && sourceKind !== incomingKind) throw new Error("Only one source type is allowed in a session.");
      if (incomingKind === "pdf" && (files.length > 1 || attachments.length > 0)) throw new Error("Only one PDF can be used in a session.");
      const parsed: Attachment[] = [];
      for (const file of files) {
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        const isImage = file.type.startsWith("image/");
        if (incomingKind === "pdf" && !isPdf) throw new Error("PDF sessions can only contain a PDF.");
        if (incomingKind === "image" && !isImage) throw new Error("Photo sessions can only contain images.");
        if (isPdf && file.size > MAX_PDF_SIZE_BYTES) throw new Error(`${file.name}: PDF is too large.`);
        if (isImage && file.size > MAX_IMAGE_SIZE_BYTES) throw new Error(`${file.name}: image is too large.`);
        parsed.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, type: isPdf ? "pdf" : "image", extractedText: isPdf ? (await extractPdfText(file)).trim() : undefined, mimeType: file.type || (isPdf ? "application/pdf" : "image/jpeg"), dataUrl: isImage ? await fileToDataUrl(file) : undefined, origin });
      }
      setAttachments((current) => [...current, ...parsed]);
      setSourceKind(incomingKind);
      setSessionTitle(parsed[0]?.name || "File session");
      setUploadStatus(`Added ${parsed.length} file${parsed.length === 1 ? "" : "s"}.`);
    } catch (err: any) {
      setError(err.message || "Could not read the selected file.");
    } finally {
      event.target.value = "";
      setUploading(false);
    }
  };

  const handleTextChange = (value: string) => {
    if (sourceKind && sourceKind !== "text") { setError("This session already uses files. Click New Session to switch source type."); return; }
    setText(value); setSourceKind(value.trim() ? "text" : null); setSessionTitle(value.trim() ? value.trim().slice(0, 42) : "New session"); setError("");
  };

  const generate = async () => {
    if (!sourceKind) { setError("Add notes, one PDF, or one or more photos first."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          text: sourceKind === "text" ? text : "",
          attachments,
          mode,
          difficulty,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Could not generate questions.");
      setSessionId(data.sessionId ?? sessionId);
      setQuestions(data.questions ?? null);
      const generationId = `${Date.now()}`;
      setGenerations((current) => [...current, { id: generationId, created_at: new Date().toISOString(), mode, difficulty, questions: data.questions ?? {} }]);
      setActiveGenerationId(generationId);
      if (historyOpen) await loadHistory();
    } catch (err: any) {
      setError(err.message || "Could not generate questions.");
    } finally {
      setLoading(false);
    }
  };

  const openSession = async (id: string) => {
    setError("");
    const res = await fetch(`/api/generate?sessionId=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.detail || "Could not open session."); return; }
    const session = data.session;
    setSessionId(session.id);
    setSessionTitle(session.title);
    setSourceKind(session.source_kind);
    setMode(session.latest_mode ?? "mix");
    setDifficulty(session.latest_difficulty ?? "medium");
    setText("");
    setAttachments(session.source_payload?.attachments ?? []);
    setGenerations(Array.isArray(session.generations) ? session.generations : []);
    setQuestions(session.latest_generation?.questions ?? null);
    setActiveGenerationId(session.latest_generation?.id ?? null);
    setTestSubmissions(Array.isArray(session.test_submissions) ? session.test_submissions : []);
    setUploadStatus("");
    setHistoryOpen(false);
    setTestMode(false);
    setTestQuestions(null);
    setTestAnswers({});
    setTestSubmitted(false);
    setTestScore(null);
    setShowTestResults(false);
    setTestHistoryOpen(false);
    setActiveTestSubmissionId(null);
  };

  const deleteSession = async (id: string) => {
    const res = await fetch(`/api/generate?sessionId=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      if (sessionId === id) resetSession();
      await loadHistory();
    }
  };

  const hasResults = !!questions && (
    (questions.multiple_choice?.length ?? 0) > 0 ||
    (questions.short_answer?.length ?? 0) > 0 ||
    (questions.true_false?.length ?? 0) > 0 ||
    (questions.flashcards?.length ?? 0) > 0
  );

  const selectGeneration = (generation: Generation) => {
    setQuestions(generation.questions);
    setMode(generation.mode);
    setDifficulty(generation.difficulty as (typeof difficultyOptions)[number]);
    setActiveGenerationId(generation.id);
  };

  const startTest = async (includePrevious: boolean) => {
    if (!sessionId) { setError("Generate at least one question set in this session before taking a test."); return; }
    setLoading(true);
    setError("");
    setTestPromptOpen(false);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate_test", sessionId, includePrevious }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Could not generate test.");
      setTestQuestions(data.questions ?? null);
      setTestAnswers({});
      setTestSubmitted(false);
      setShowTestResults(false);
      setTestScore(null);
      setTestHistoryOpen(false);
      setActiveTestSubmissionId(null);
      setTestMode(true);
    } catch (err: any) {
      setError(err.message || "Could not generate test.");
    } finally {
      setLoading(false);
    }
  };

  const setTestAnswer = (key: string, value: string) => {
    if (testSubmitted) return;
    setTestAnswers((current) => ({ ...current, [key]: value }));
  };

  const getShortAnswerEvaluation = (submission: TestSubmission | null, index: number) => {
    if (!submission?.shortAnswerEvaluations) return undefined;
    return submission.shortAnswerEvaluations.find((item) => item.index === index);
  };

  const submitTest = async () => {
    if (!testQuestions || !sessionId) return;
    let score = 0;
    let total = 0;
    const mcq = Array.isArray(testQuestions.multiple_choice) ? testQuestions.multiple_choice : [];
    mcq.forEach((q, i) => {
      total += 1;
      const expected = String(q.answer ?? "").trim().toUpperCase().match(/[A-D]/)?.[0] || "";
      if ((testAnswers[`mcq-${i}`] ?? "") === expected) score += 1;
    });
    const tf = Array.isArray(testQuestions.true_false) ? testQuestions.true_false : [];
    tf.forEach((q, i) => {
      total += 1;
      const expected = typeof q.answer === "boolean" ? (q.answer ? "True" : "False") : String(q.answer);
      if ((testAnswers[`tf-${i}`] ?? "") === expected) score += 1;
    });
    const shortAnswer = Array.isArray(testQuestions.short_answer) ? testQuestions.short_answer : [];
    let shortAnswerEvaluations: ShortAnswerEvaluation[] = [];
    if (shortAnswer.length) {
      total += shortAnswer.length;
      const gradeRes = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "grade_short_answers", questions: shortAnswer, answers: testAnswers }),
      });
      const gradeData = await gradeRes.json().catch(() => ({}));
      if (!gradeRes.ok) {
        setError(gradeData.detail || "Could not grade short answers.");
        return;
      }
      shortAnswerEvaluations = Array.isArray(gradeData.evaluations) ? gradeData.evaluations : [];
      score += Number(gradeData.score ?? 0);
    }
    const payload: TestSubmission = { id: `${Date.now()}`, created_at: new Date().toISOString(), score, total, answers: testAnswers, questions: testQuestions, shortAnswerEvaluations };
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit_test", sessionId, submission: payload }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.detail || "Could not save test submission.");
      return;
    }
    setTestSubmissions((current) => [...current, payload]);
    setTestSubmitted(true);
    setTestScore({ score, total });
    setActiveTestSubmissionId(payload.id);
  };

  const openTestSubmission = (submission: TestSubmission) => {
    setTestQuestions(submission.questions);
    setTestAnswers(submission.answers);
    setTestSubmitted(true);
    setTestScore({ score: submission.score, total: submission.total });
    setShowTestResults(true);
    setTestMode(true);
    setActiveTestSubmissionId(submission.id);
  };

  return (
    <main style={{ minHeight: "100dvh", background: "linear-gradient(180deg,#06060b 0%,#0b0b12 45%,#11111a 100%)", color: "#f2efff", fontFamily: "'Cormorant Garamond', serif", position: "relative", overflowX: "hidden" }}>
      <style>{GLOBAL_CSS}</style>
      <div className="top-actions">
        <button type="button" onClick={resetSession} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}><Plus size={16} />NEW SESSION</button>
        <button type="button" onClick={() => setTestPromptOpen(true)} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}><ClipboardCheck size={16} />TAKE TEST</button>
        <button type="button" onClick={toggleHistory} className="push-right" style={{ width: 46, height: 46, borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{historyOpen ? <X size={18} /> : <Ellipsis size={18} />}</button>
        {testSubmitted && <button type="button" onClick={() => setShowTestResults((v) => !v)} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>SEE RESULT</button>}
        {!!testSubmissions.length && <button type="button" onClick={() => setTestHistoryOpen((v) => !v)} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{testHistoryOpen ? "HIDE TESTS" : "TEST HISTORY"}</button>}
      </div>
      {testHistoryOpen && !!testSubmissions.length && <aside className="side-panel right"><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}><div style={{ color: "#f9a8d4", fontFamily: "'DM Mono', monospace", fontSize: 11, letterSpacing: 2 }}>TEST HISTORY</div><button type="button" onClick={() => setTestHistoryOpen(false)} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(248,113,113,0.08)", color: "#f87171", cursor: "pointer" }}><X size={16} /></button></div><div style={{ display: "grid", gap: 8 }}>{[...testSubmissions].reverse().map((submission, index) => <button key={submission.id} type="button" onClick={() => openTestSubmission(submission)} style={{ width: "100%", textAlign: "left", padding: "12px 14px", borderRadius: 12, border: `1px solid ${activeTestSubmissionId === submission.id ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.06)"}`, background: activeTestSubmissionId === submission.id ? "rgba(167,139,250,0.14)" : "rgba(255,255,255,0.03)", color: "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}><div style={{ marginBottom: 6 }}>Submission {testSubmissions.length - index}</div><div style={{ color: "#a59dbd", fontSize: 10 }}>{new Date(submission.created_at).toLocaleString()} • {submission.score}/{submission.total}</div></button>)}</div></aside>}
      {testPromptOpen && <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(6,6,11,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}><div className="mobile-sheet" style={{ background: "rgba(11,11,18,0.98)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 20, padding: 22 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><div style={{ color: "#f9a8d4", fontFamily: "'DM Mono', monospace", fontSize: 12, letterSpacing: 2 }}>TAKE TEST</div><button type="button" onClick={() => setTestPromptOpen(false)} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(248,113,113,0.08)", color: "#f87171", cursor: "pointer" }}><X size={16} /></button></div><div style={{ color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 1.8, marginBottom: 16 }}>Choose how the test should be built.</div><div style={{ display: "grid", gap: 10 }}><button type="button" onClick={() => startTest(true)} style={{ textAlign: "left", padding: "14px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.18)", background: "rgba(167,139,250,0.08)", color: "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>INCLUDE PREVIOUS SESSION QUESTIONS</button><button type="button" onClick={() => startTest(false)} style={{ textAlign: "left", padding: "14px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.18)", background: "rgba(255,255,255,0.04)", color: "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>USE JUST THIS SESSION</button></div></div></div>}
      {historyOpen && <aside className="side-panel left">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {historyLoading ? <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>Loading sessions...</p> : history.map((item) => <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "stretch" }}><button type="button" onClick={() => openSession(item.id)} style={{ flex: 1, textAlign: "left", padding: 14, borderRadius: 14, border: "1px solid rgba(255,255,255,0.06)", background: sessionId === item.id ? "rgba(167,139,250,0.14)" : "rgba(255,255,255,0.03)", color: "#f2efff", cursor: "pointer" }}><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, marginBottom: 6 }}>{item.title}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#a59dbd" }}>{item.latest_mode} • {item.latest_difficulty}</div></button><button type="button" onClick={() => deleteSession(item.id)} style={{ width: 44, borderRadius: 14, border: "1px solid rgba(248,113,113,0.2)", background: "rgba(248,113,113,0.08)", color: "#f87171", cursor: "pointer" }}><Trash2 size={16} /></button></div>)}
          {!historyLoading && history.length === 0 && <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>No saved sessions yet.</p>}
        </div>
      </aside>}
      <div className="content-shell">
        <div style={{ textAlign: "center", marginBottom: 36, animation: "fade-up .6s both" }}>
          <div style={{ fontSize: 11, color: "#a78bfa", letterSpacing: 5, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>STUDY BUDDY</div>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 10 }}>
            <h1 style={{ fontSize: "clamp(34px,5vw,56px)", lineHeight: 1.1, marginBottom: 12 }}><span style={{ color: "#f2efff" }}>Turn notes into</span><br /><span style={{ background: "linear-gradient(135deg,#a78bfa,#f9a8d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontStyle: "italic" }}>smart questions.</span></h1>
            <button type="button" onClick={() => setHelpOpen(true)} style={{ marginTop: 8, width: 34, height: 34, borderRadius: 999, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(255,255,255,0.04)", color: "#f9a8d4", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><CircleHelp size={16} /></button>
          </div>
          <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{sessionTitle}</p>
        </div>

        {helpOpen && <div style={{ marginBottom: 22 }}><Glass><div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}><div><div style={{ fontSize: 11, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>HOW TO USE</div><div style={{ color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12, lineHeight: 1.8 }}>Start one session with only one source type: pasted notes, one PDF, or one or more photos. After that, you can change difficulty and question format as many times as you want for that same session. Use `TAKE TEST` to build a test from this session or blend in previous sessions. In test mode you answer first, then press `SUBMIT TEST` and use `SEE RESULT` to reveal scoring and correct answers. `TEST HISTORY` opens a sidebar with previous submissions you can reopen anytime.</div></div><button type="button" onClick={() => setHelpOpen(false)} style={{ width: 34, height: 34, borderRadius: 12, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(248,113,113,0.08)", color: "#f87171", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={16} /></button></div></Glass></div>}

        {!testMode && <Glass>
          <div style={{ display: "grid", gap: 22 }}>
            <div>
              <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>NOTES</div>
              <textarea value={text} onChange={(e) => handleTextChange(e.target.value)} disabled={sourceKind === "pdf" || sourceKind === "image"} placeholder="Paste notes here..." style={{ width: "100%", minHeight: 170, resize: "vertical", background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.22)", borderRadius: 14, padding: "16px 18px", fontSize: 13, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.8 }} />
            </div>

            <div>
              <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>FILES</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                <label style={{ padding: "10px 14px", borderRadius: 12, background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.24)", cursor: sourceKind === "text" ? "not-allowed" : "pointer", opacity: sourceKind === "text" ? 0.55 : 1, fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
                  <input type="file" accept="application/pdf,image/*" multiple disabled={sourceKind === "text" || uploading} onChange={(e) => handleFilesAdded(e, "upload")} style={{ display: "none" }} />
                  ADD FILES
                </label>
                <label style={{ padding: "10px 14px", borderRadius: 12, background: "rgba(249,168,212,0.12)", border: "1px solid rgba(249,168,212,0.24)", cursor: sourceKind === "text" ? "not-allowed" : "pointer", opacity: sourceKind === "text" ? 0.55 : 1, fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
                  <input type="file" accept="image/*" capture="environment" disabled={sourceKind === "text" || uploading} onChange={(e) => handleFilesAdded(e, "camera")} style={{ display: "none" }} />
                  TAKE PHOTO
                </label>
              </div>
              <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{sourceKind === "image" ? "This session accepts more photos only." : sourceKind === "pdf" ? "This session is locked to one PDF." : sourceKind === "text" ? "This session is locked to pasted notes." : "Choose one source type for this session."}</p>
              {uploadStatus && <p style={{ color: "#ddd6fe", fontFamily: "'DM Mono', monospace", fontSize: 11, marginTop: 8 }}>{uploadStatus}</p>}
              {!!attachments.length && <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>{attachments.map((item) => <div key={item.id} style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{item.name}</div>)}</div>}
            </div>

            <div>
              <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>DIFFICULTY</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{difficultyOptions.map((option) => <button key={option} type="button" onClick={() => setDifficulty(option)} style={{ padding: "10px 14px", borderRadius: 12, border: `1px solid ${difficulty === option ? "#a78bfa" : "rgba(255,255,255,0.08)"}`, background: difficulty === option ? "linear-gradient(135deg,#857ca2,#a78bfa)" : "rgba(255,255,255,0.04)", color: difficulty === option ? "#06060b" : "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, textTransform: "uppercase" }}>{option}</button>)}</div>
            </div>

            <div>
              <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>FORMAT</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{modeOptions.map((opt) => { const Icon = opt.icon; return <button key={opt.value} type="button" onClick={() => setMode(opt.value)} style={{ padding: "10px 14px", borderRadius: 12, border: `1px solid ${mode === opt.value ? "#a78bfa" : "rgba(255,255,255,0.08)"}`, background: mode === opt.value ? "linear-gradient(135deg,#857ca2,#a78bfa)" : "rgba(255,255,255,0.04)", color: mode === opt.value ? "#06060b" : "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, display: "flex", alignItems: "center", gap: 7 }}><Icon size={13} />{opt.label}</button>; })}</div>
            </div>

            {error && <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", color: "#f87171", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{error}</div>}
            {!!generations.length && <div style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>This session has {generations.length} generation{generations.length === 1 ? "" : "s"}. You can keep changing difficulty and format without starting over.</div>}
            {!!generations.length && <div><div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>GENERATIONS</div><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{generations.map((generation, index) => <button key={generation.id} type="button" onClick={() => selectGeneration(generation)} style={{ padding: "10px 12px", borderRadius: 12, border: `1px solid ${activeGenerationId === generation.id ? "#a78bfa" : "rgba(255,255,255,0.08)"}`, background: activeGenerationId === generation.id ? "rgba(167,139,250,0.16)" : "rgba(255,255,255,0.03)", color: "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 11, textAlign: "left" }}>GEN {index + 1}<br />{generation.mode} • {generation.difficulty}</button>)}</div></div>}

            <button type="button" onClick={generate} disabled={loading || uploading} style={{ width: "100%", padding: "18px", borderRadius: 14, border: "none", background: loading ? "rgba(167,139,250,0.32)" : "linear-gradient(135deg,#857ca2,#a78bfa,#f9a8d4)", color: "#06060b", fontFamily: "'DM Mono', monospace", fontWeight: 700, letterSpacing: 3, cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              {loading ? <><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce .8s 0s infinite" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce .8s .2s infinite" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce .8s .4s infinite" }} /><span>GENERATING</span></> : <><Sparkles size={15} /><span>GENERATE QUESTIONS</span></>}
            </button>
          </div>
        </Glass>}

        {testMode && testQuestions && <Glass><div style={{ display: "grid", gap: 22 }}><div style={{ color: "#f9a8d4", fontFamily: "'DM Mono', monospace", fontSize: 12, letterSpacing: 2 }}>TEST MODE</div>{showTestResults && testScore && <div style={{ color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>Score: {testScore.score}/{testScore.total}</div>}{testQuestions.multiple_choice?.length ? <div><SectionLabel text={`Multiple Choice • ${testQuestions.multiple_choice.length}`} color="#a78bfa" /><div style={{ display: "grid", gap: 12 }}>{testQuestions.multiple_choice.map((q, i) => <TestMCQCard key={i} q={q} idx={i} answer={testAnswers[`mcq-${i}`]} onAnswer={(value) => setTestAnswer(`mcq-${i}`, value)} showResults={showTestResults} />)}</div></div> : null}{testQuestions.true_false?.length ? <div><SectionLabel text={`True / False • ${testQuestions.true_false.length}`} color="#f87171" /><div style={{ display: "grid", gap: 12 }}>{testQuestions.true_false.map((q, i) => <TestTFCard key={i} q={q} idx={i} answer={testAnswers[`tf-${i}`]} onAnswer={(value) => setTestAnswer(`tf-${i}`, value)} showResults={showTestResults} />)}</div></div> : null}{testQuestions.short_answer?.length ? <div><SectionLabel text={`Short Answer • ${testQuestions.short_answer.length}`} color="#f9a8d4" /><div style={{ display: "grid", gap: 12 }}>{testQuestions.short_answer.map((q, i) => <TestShortAnswerCard key={i} q={q} idx={i} answer={testAnswers[`sa-${i}`]} onAnswer={(value) => setTestAnswer(`sa-${i}`, value)} showResults={showTestResults} evaluation={getShortAnswerEvaluation(testSubmissions.find((item) => item.id === activeTestSubmissionId) ?? null, i)} />)}</div></div> : null}<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{!testSubmitted && <button type="button" onClick={submitTest} style={{ padding: "14px 18px", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#857ca2,#a78bfa,#f9a8d4)", color: "#06060b", fontFamily: "'DM Mono', monospace", fontWeight: 700, cursor: "pointer" }}>SUBMIT TEST</button>}<button type="button" onClick={() => { setTestMode(false); setShowTestResults(false); }} style={{ padding: "14px 18px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.2)", background: "rgba(255,255,255,0.04)", color: "#f2efff", fontFamily: "'DM Mono', monospace", cursor: "pointer" }}>EXIT TEST</button></div></div></Glass>}

        {!testMode && hasResults && <div style={{ marginTop: 28, display: "grid", gap: 28, animation: "fade-up .5s both" }}>
          {questions?.multiple_choice?.length ? <div><SectionLabel text={`Multiple Choice • ${questions.multiple_choice.length}`} color="#a78bfa" /><div style={{ display: "grid", gap: 12 }}>{questions.multiple_choice.map((q, i) => <MCQRevealCard key={i} q={q} idx={i} />)}</div></div> : null}
          {questions?.short_answer?.length ? <div><SectionLabel text={`Short Answer • ${questions.short_answer.length}`} color="#f9a8d4" /><div style={{ display: "grid", gap: 12 }}>{questions.short_answer.map((q, i) => <ShortAnswerCard key={i} q={q} idx={i} delay={i * 60} />)}</div></div> : null}
          {questions?.true_false?.length ? <div><SectionLabel text={`True / False • ${questions.true_false.length}`} color="#f87171" /><div style={{ display: "grid", gap: 12 }}>{questions.true_false.map((q, i) => <TrueFalseCard key={i} q={q} idx={i} delay={i * 60} />)}</div></div> : null}
          {questions?.flashcards?.length ? <div><SectionLabel text={`Flashcards • ${questions.flashcards.length}`} color="#ddd6fe" /><div style={{ display: "grid", gap: 12 }}>{questions.flashcards.map((q, i) => <Flashcard key={i} q={q} idx={i} />)}</div></div> : null}
        </div>}
      </div>
      <div style={{ paddingBottom: 26, textAlign: "center", color: "#f9a8d4", fontFamily: "'DM Mono', monospace", fontSize: 13, letterSpacing: 2 }}>made by aawaz</div>
    </main>
  );
}
