"use client";
import { useState } from "react";
import { Sparkles, BookOpen, ToggleLeft, AlignLeft, Layers, ChevronDown, ChevronUp, Ellipsis, X, Plus, Trash2, CircleHelp } from "lucide-react";

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

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0} body{background:linear-gradient(180deg,#06060b 0%,#0b0b12 45%,#11111a 100%);overflow-x:hidden}
  textarea:focus{outline:none} textarea::placeholder{color:#857ca2}
  ::selection{background:#a78bfa44;color:#f2efff} ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-thumb{background:#857ca2;border-radius:99px}
  @keyframes fade-up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}} @keyframes dot-bounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-5px);opacity:1}}
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
  return <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(248,113,113,0.18)", borderRadius: 16, padding: 18 }}><div style={{ fontSize: 10, color: "#f87171", fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>{String(idx + 1).padStart(2, "0")}</div><div style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, marginBottom: 14 }}>{q.statement}</div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{["True", "False"].map((option) => <button key={option} type="button" onClick={() => setSelected(option)} style={{ padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: selected === option ? (option === correctAnswer ? "rgba(251,191,36,0.16)" : "rgba(248,113,113,0.16)") : "rgba(255,255,255,0.03)", color: selected === option ? (option === correctAnswer ? "#fbbf24" : "#f87171") : "#f2efff", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{option}</button>)}</div>{selected && selected !== correctAnswer && <div style={{ marginTop: 12, color: "#fbbf24", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>Correct: {correctAnswer}</div>}</div>;
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

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/.netlify/functions/generate");
      const data = await res.json().catch(() => ({}));
      setHistory(Array.isArray(data.sessions) ? data.sessions : []);
    } finally {
      setHistoryLoading(false);
    }
  };

  const resetSession = () => {
    setSessionId(null); setSessionTitle("New session"); setSourceKind(null); setText(""); setAttachments([]); setQuestions(null); setGenerations([]); setActiveGenerationId(null); setUploadStatus(""); setError("");
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
      const res = await fetch("/.netlify/functions/generate", {
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
    const res = await fetch(`/.netlify/functions/generate?sessionId=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.detail || "Could not open session."); return; }
    const session = data.session;
    setSessionId(session.id);
    setSessionTitle(session.title);
    setSourceKind(session.source_kind);
    setMode(session.latest_mode ?? "mix");
    setDifficulty(session.latest_difficulty ?? "medium");
    setText(session.source_payload?.text ?? "");
    setAttachments(session.source_payload?.attachments ?? []);
    setGenerations(Array.isArray(session.generations) ? session.generations : []);
    setQuestions(session.latest_generation?.questions ?? null);
    setActiveGenerationId(session.latest_generation?.id ?? null);
    setUploadStatus("");
    setHistoryOpen(false);
  };

  const deleteSession = async (id: string) => {
    const res = await fetch(`/.netlify/functions/generate?sessionId=${encodeURIComponent(id)}`, { method: "DELETE" });
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

  return (
    <main style={{ minHeight: "100vh", background: "linear-gradient(180deg,#06060b 0%,#0b0b12 45%,#11111a 100%)", color: "#f2efff", fontFamily: "'Cormorant Garamond', serif", position: "relative" }}>
      <style>{GLOBAL_CSS}</style>
      <button type="button" onClick={toggleHistory} style={{ position: "fixed", top: 18, right: 18, zIndex: 30, width: 46, height: 46, borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{historyOpen ? <X size={18} /> : <Ellipsis size={18} />}</button>
      <button type="button" onClick={resetSession} style={{ position: "fixed", top: 18, left: 18, zIndex: 30, padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(11,11,18,0.88)", color: "#f2efff", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12 }}><Plus size={16} />NEW SESSION</button>
      {historyOpen && <aside style={{ position: "fixed", top: 76, left: 16, width: "min(360px, calc(100vw - 32px))", maxHeight: "calc(100vh - 92px)", overflowY: "auto", zIndex: 25, borderRadius: 22, padding: 16, background: "rgba(11,11,18,0.96)", border: "1px solid rgba(167,139,250,0.18)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {historyLoading ? <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>Loading sessions...</p> : history.map((item) => <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "stretch" }}><button type="button" onClick={() => openSession(item.id)} style={{ flex: 1, textAlign: "left", padding: 14, borderRadius: 14, border: "1px solid rgba(255,255,255,0.06)", background: sessionId === item.id ? "rgba(167,139,250,0.14)" : "rgba(255,255,255,0.03)", color: "#f2efff", cursor: "pointer" }}><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, marginBottom: 6 }}>{item.title}</div><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#a59dbd" }}>{item.latest_mode} • {item.latest_difficulty}</div></button><button type="button" onClick={() => deleteSession(item.id)} style={{ width: 44, borderRadius: 14, border: "1px solid rgba(248,113,113,0.2)", background: "rgba(248,113,113,0.08)", color: "#f87171", cursor: "pointer" }}><Trash2 size={16} /></button></div>)}
          {!historyLoading && history.length === 0 && <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>No saved sessions yet.</p>}
        </div>
      </aside>}
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "78px 24px 96px", position: "relative", zIndex: 1 }}>
        <div style={{ textAlign: "center", marginBottom: 36, animation: "fade-up .6s both" }}>
          <div style={{ fontSize: 11, color: "#a78bfa", letterSpacing: 5, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>STUDY BUDDY</div>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 10 }}>
            <h1 style={{ fontSize: "clamp(34px,5vw,56px)", lineHeight: 1.1, marginBottom: 12 }}><span style={{ color: "#f2efff" }}>Turn notes into</span><br /><span style={{ background: "linear-gradient(135deg,#a78bfa,#f9a8d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontStyle: "italic" }}>smart questions.</span></h1>
            <button type="button" onClick={() => setHelpOpen(true)} style={{ marginTop: 8, width: 34, height: 34, borderRadius: 999, border: "1px solid rgba(167,139,250,0.22)", background: "rgba(255,255,255,0.04)", color: "#f9a8d4", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><CircleHelp size={16} /></button>
          </div>
          <p style={{ color: "#a59dbd", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{sessionTitle}</p>
        </div>

        {helpOpen && <div style={{ marginBottom: 22 }}><Glass><div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}><div><div style={{ fontSize: 11, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>HOW TO USE</div><div style={{ color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12, lineHeight: 1.8 }}>Start one session with only one source type: pasted notes, one PDF, or one or more photos. After that, you can change difficulty and question format as many times as you want for that same session. Click `NEW SESSION` only when you want to start over with a different source.</div></div><button type="button" onClick={() => setHelpOpen(false)} style={{ width: 34, height: 34, borderRadius: 12, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(248,113,113,0.08)", color: "#f87171", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={16} /></button></div></Glass></div>}

        <Glass>
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
        </Glass>

        {hasResults && <div style={{ marginTop: 28, display: "grid", gap: 28, animation: "fade-up .5s both" }}>
          {questions?.multiple_choice?.length ? <div><SectionLabel text={`Multiple Choice • ${questions.multiple_choice.length}`} color="#a78bfa" /><div style={{ display: "grid", gap: 12 }}>{questions.multiple_choice.map((q, i) => <Glass key={i}><div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, marginBottom: 14 }}>{q.question}</div><div style={{ display: "grid", gap: 8 }}>{(Array.isArray(q.options) ? q.options : []).map((opt: string, idx: number) => <div key={idx} style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", color: "#f2efff", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{opt}</div>)}</div></Glass>)}</div></div> : null}
          {questions?.short_answer?.length ? <div><SectionLabel text={`Short Answer • ${questions.short_answer.length}`} color="#f9a8d4" /><div style={{ display: "grid", gap: 12 }}>{questions.short_answer.map((q, i) => <ShortAnswerCard key={i} q={q} idx={i} delay={i * 60} />)}</div></div> : null}
          {questions?.true_false?.length ? <div><SectionLabel text={`True / False • ${questions.true_false.length}`} color="#f87171" /><div style={{ display: "grid", gap: 12 }}>{questions.true_false.map((q, i) => <TrueFalseCard key={i} q={q} idx={i} delay={i * 60} />)}</div></div> : null}
          {questions?.flashcards?.length ? <div><SectionLabel text={`Flashcards • ${questions.flashcards.length}`} color="#ddd6fe" /><div style={{ display: "grid", gap: 12 }}>{questions.flashcards.map((q, i) => <Flashcard key={i} q={q} idx={i} />)}</div></div> : null}
        </div>}
      </div>
      <div style={{ paddingBottom: 26, textAlign: "center", color: "#f9a8d4", fontFamily: "'DM Mono', monospace", fontSize: 13, letterSpacing: 2 }}>made by aawaz</div>
    </main>
  );
}
