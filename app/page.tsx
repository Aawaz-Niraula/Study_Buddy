"use client";
import { useState } from "react";
import { Sparkles, BookOpen, ToggleLeft, AlignLeft, Layers, ChevronDown, ChevronUp, Ellipsis, X } from "lucide-react";

declare global {
  interface Window {
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (source: { data: Uint8Array }) => {
        promise: Promise<{
          numPages: number;
          getPage: (pageNumber: number) => Promise<{
            getTextContent: () => Promise<{
              items: Array<{ str?: string }>;
            }>;
          }>;
        }>;
      };
    };
  }
}

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=DM+Mono:wght@300;400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: linear-gradient(180deg, #06060b 0%, #0b0b12 45%, #11111a 100%); overflow-x: hidden; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #857ca2; border-radius: 99px; }
  ::selection { background: #a78bfa44; color: #f2efff; }
  textarea:focus { outline: none; }
  textarea::placeholder { color: #857ca2; }
  @keyframes float-orb { 0%, 100% { transform: translate(0,0) scale(1); } 33% { transform: translate(30px,-40px) scale(1.08); } 66% { transform: translate(-20px,20px) scale(0.94); } }
  @keyframes fade-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes shimmer-x { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
  @keyframes dot-bounce { 0%, 100% { transform: translateY(0); opacity: 0.4; } 50% { transform: translateY(-5px); opacity: 1; } }
  @keyframes card-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes grid-drift { 0% { transform: translateX(0) translateY(0); } 100% { transform: translateX(40px) translateY(40px); } }
  @keyframes flip-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes sidebar-in { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: translateX(0); } }
`;

const modeOptions = [
  { value: "mix", label: "Mixed", icon: Layers },
  { value: "multiple-choice", label: "Multiple Choice", icon: BookOpen },
  { value: "short-answer", label: "Short Answer", icon: AlignLeft },
  { value: "true-false", label: "True / False", icon: ToggleLeft },
  { value: "flashcard", label: "Flashcards", icon: Sparkles },
];

const difficultyOptions = [
  { value: "easy", label: "Easy", accent: "#f9a8d4" },
  { value: "medium", label: "Medium", accent: "#a78bfa" },
  { value: "difficult", label: "Difficult", accent: "#fbbf24" },
];

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;

type Attachment = {
  id: string;
  name: string;
  type: "pdf" | "image";
  extractedText?: string;
  mimeType: string;
  dataUrl?: string;
  origin: "upload" | "camera";
};

type SessionHistoryItem = {
  id: string;
  created_at: string;
  mode: string;
  difficulty: string;
  source_kind: string;
  source_names: string;
  attachment_count: number;
  model_used: string;
};

let pdfJsLoader: Promise<void> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") resolve();
      else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
      }
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensurePdfJs() {
  if (!pdfJsLoader) {
    pdfJsLoader = loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js").then(() => {
      if (!window.pdfjsLib) throw new Error("PDF reader failed to load.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    });
  }
  await pdfJsLoader;
}

async function extractPdfText(file: File) {
  await ensurePdfJs();
  if (!window.pdfjsLib) throw new Error("PDF reader is unavailable.");
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str?.trim() ?? "").filter(Boolean).join(" ");
    if (pageText) pages.push(pageText);
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

function Background() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: "-40px", backgroundImage: "linear-gradient(rgba(167,139,250,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(167,139,250,0.05) 1px, transparent 1px)", backgroundSize: "60px 60px", animation: "grid-drift 24s linear infinite" }} />
      <div style={{ position: "absolute", top: "-10%", left: "-5%", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.18) 0%, transparent 70%)", animation: "float-orb 18s ease-in-out infinite", filter: "blur(1px)" }} />
      <div style={{ position: "absolute", bottom: "-15%", right: "-10%", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(133,124,162,0.14) 0%, transparent 70%)", animation: "float-orb 24s ease-in-out infinite reverse", filter: "blur(1px)" }} />
      <div style={{ position: "absolute", top: "45%", right: "15%", width: 350, height: 350, borderRadius: "50%", background: "radial-gradient(circle, rgba(249,168,212,0.10) 0%, transparent 70%)", animation: "float-orb 15s ease-in-out infinite 5s" }} />
    </div>
  );
}

function SectionLabel({ text, color }: { text: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <div style={{ width: 5, height: 5, borderRadius: "50%", background: color, boxShadow: `0 0 10px ${color}` }} />
      <span style={{ fontSize: 11, letterSpacing: 3, color, fontWeight: 500, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{text}</span>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${color}44, transparent)` }} />
    </div>
  );
}

function GlassCard({ children, accent = "#a78bfa", delay = 0 }: { children: React.ReactNode; accent?: string; delay?: number; }) {
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)",
      backdropFilter: "blur(20px)",
      border: `1px solid ${accent}33`,
      borderLeft: `2px solid ${accent}`,
      borderRadius: 16,
      padding: "20px 24px",
      position: "relative",
      overflow: "hidden",
      animation: `card-in 0.5s cubic-bezier(0.22,1,0.36,1) ${delay}ms both`,
      boxShadow: `0 8px 32px ${accent}0d, inset 0 1px 0 rgba(255,255,255,0.04)`,
    }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(105deg, transparent 40%, ${accent}07 50%, transparent 60%)`, animation: "shimmer-x 5s ease-in-out infinite", pointerEvents: "none" }} />
      {children}
    </div>
  );
}

function Flashcard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div onClick={() => setFlipped((f) => !f)} style={{ animation: `flip-in 0.5s cubic-bezier(0.22,1,0.36,1) ${delay}ms both`, cursor: "pointer" }}>
      <div style={{ background: flipped ? "linear-gradient(135deg, rgba(167,139,250,0.15), rgba(249,168,212,0.08))" : "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))", border: `1px solid ${flipped ? "#a78bfa66" : "#a78bfa22"}`, borderLeft: `2px solid ${flipped ? "#f9a8d4" : "#a78bfa"}`, borderRadius: 16, padding: "22px 24px", position: "relative", overflow: "hidden", boxShadow: flipped ? "0 8px 40px rgba(167,139,250,0.2)" : "0 4px 20px rgba(167,139,250,0.06)", transition: "all 0.35s cubic-bezier(0.22,1,0.36,1)", minHeight: 90 }}>
        <div style={{ position: "absolute", top: 14, right: 16, fontSize: 9, color: flipped ? "#f9a8d4" : "#857ca2", fontFamily: "'DM Mono', monospace", letterSpacing: 2 }}>{flipped ? "ANSWER" : "TAP TO REVEAL"}</div>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <span style={{ fontSize: 11, color: "#a59dbd", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
          <p style={{ fontSize: 14, color: flipped ? "#f2efff" : "#ddd6fe", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, transition: "color 0.3s", paddingRight: 80 }}>{flipped ? q.answer : q.question}</p>
        </div>
      </div>
    </div>
  );
}

function MCQCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [revealed, setRevealed] = useState(false);
  const options = Array.isArray(q.options) ? q.options.filter((o: any) => typeof o === "string" && o.trim()) : typeof q.options === "string" ? q.options.split("\n").filter((o: string) => o.trim()) : [];
  const correctLetter = String(q.answer ?? "").trim().toUpperCase().match(/[A-D]/)?.[0] || "";
  return (
    <GlassCard accent="#a78bfa" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: "#a59dbd", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
        <p style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>{q.question}</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 28, marginBottom: 14 }}>
        {options.map((opt: string, i: number) => {
          const letter = opt.trim().charAt(0).toUpperCase();
          const isCorrect = revealed && letter === correctLetter;
          return <div key={i} style={{ padding: "10px 14px", borderRadius: 10, background: isCorrect ? "rgba(167,139,250,0.15)" : "rgba(255,255,255,0.02)", border: `1px solid ${isCorrect ? "#a78bfa55" : "rgba(255,255,255,0.06)"}`, fontSize: 13, color: isCorrect ? "#f2efff" : "#a59dbd", fontFamily: "'DM Mono', monospace", lineHeight: 1.5 }}>{opt}</div>;
        })}
      </div>
      <button onClick={() => setRevealed((r) => !r)} style={{ marginLeft: 28, padding: "8px 16px", borderRadius: 99, border: "1px solid rgba(167,139,250,0.3)", background: revealed ? "rgba(167,139,250,0.15)" : "transparent", color: revealed ? "#f2efff" : "#857ca2", cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", letterSpacing: 2, display: "flex", alignItems: "center", gap: 6 }}>
        {revealed ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
        {revealed ? `ANSWER: ${correctLetter || "?"}` : "REVEAL ANSWER"}
      </button>
    </GlassCard>
  );
}

function ShortAnswerCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <GlassCard accent="#f9a8d4" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: "#a59dbd", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
        <p style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>{q.question}</p>
      </div>
      {revealed && <div style={{ marginLeft: 28, padding: "12px 16px", borderRadius: 10, background: "rgba(249,168,212,0.08)", border: "1px solid rgba(249,168,212,0.2)", marginBottom: 12 }}><p style={{ fontSize: 13, color: "#fbcfe8", fontFamily: "'DM Mono', monospace", lineHeight: 1.7 }}>{q.answer}</p></div>}
      <button onClick={() => setRevealed((r) => !r)} style={{ marginLeft: 28, padding: "8px 16px", borderRadius: 99, border: "1px solid rgba(249,168,212,0.3)", background: revealed ? "rgba(249,168,212,0.12)" : "transparent", color: revealed ? "#fbcfe8" : "#a59dbd", cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", letterSpacing: 2, display: "flex", alignItems: "center", gap: 6 }}>
        {revealed ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
        {revealed ? "HIDE ANSWER" : "REVEAL ANSWER"}
      </button>
    </GlassCard>
  );
}

function TrueFalseCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const correctAnswer = typeof q.answer === "boolean" ? (q.answer ? "True" : "False") : String(q.answer).trim().charAt(0).toUpperCase() + String(q.answer).trim().slice(1).toLowerCase();
  return (
    <GlassCard accent="#f87171" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: "#a59dbd", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
        <p style={{ fontSize: 14, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>{q.statement}</p>
      </div>
      <div style={{ display: "flex", gap: 10, marginLeft: 28, alignItems: "center", flexWrap: "wrap" }}>
        {["True", "False"].map((option) => {
          const isCorrect = selected !== null && option === correctAnswer;
          const isWrong = selected === option && option !== correctAnswer;
          return <button key={option} onClick={() => setSelected(option)} style={{ padding: "10px 28px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontFamily: "'DM Mono', monospace", letterSpacing: 1, fontWeight: 500, background: isCorrect ? "rgba(251,191,36,0.18)" : isWrong ? "rgba(248,113,113,0.2)" : "rgba(255,255,255,0.04)", color: isCorrect ? "#fbbf24" : isWrong ? "#f87171" : "#a59dbd", border: `1px solid ${isCorrect ? "rgba(251,191,36,0.4)" : isWrong ? "rgba(248,113,113,0.4)" : "rgba(255,255,255,0.1)"}` }}>{option}</button>;
        })}
        {selected && selected !== correctAnswer && <span style={{ fontSize: 11, color: "#fbbf24", fontFamily: "'DM Mono', monospace", letterSpacing: 1, marginLeft: 4 }}>CORRECT: {correctAnswer}</span>}
      </div>
    </GlassCard>
  );
}

export default function Home() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("mix");
  const [difficulty, setDifficulty] = useState("medium");
  const [questions, setQuestions] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [activeSource, setActiveSource] = useState<"text" | "files" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<SessionHistoryItem[]>([]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/generate`);
      const data = await res.json().catch(() => ({}));
      setHistory(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) await loadHistory();
  };

  const openHistorySession = async (sessionId: string) => {
    setError("");
    try {
      const res = await fetch(`/.netlify/functions/generate?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || "Could not load saved session.");
      }

      const session = data.session;
      if (!session) {
        throw new Error("Saved session was empty.");
      }

      setQuestions(session.questions ?? null);
      setMode(String(session.mode ?? "mix"));
      setDifficulty(String(session.difficulty ?? "medium"));
      setText("");
      setAttachments([]);
      setActiveSource(null);
      setUploadStatus("");
      setHistoryOpen(false);
    } catch (err: any) {
      setError(err.message || "Could not load saved session.");
    }
  };

  const handleFilesAdded = async (event: React.ChangeEvent<HTMLInputElement>, origin: "upload" | "camera") => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    if (text.trim()) {
      setError("Clear your pasted notes before adding a PDF, image, or camera photo.");
      event.target.value = "";
      return;
    }
    setUploading(true);
    setError("");
    setUploadStatus("Preparing files...");
    try {
      const parsed: Attachment[] = [];
      for (const file of files) {
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        const isImage = file.type.startsWith("image/");
        if (!isPdf && !isImage) throw new Error(`${file.name}: only PDF and image files are supported.`);
        if (isPdf && file.size > MAX_PDF_SIZE_BYTES) throw new Error(`${file.name}: PDF is too large. Please keep it under 3 MB.`);
        if (isImage && file.size > MAX_IMAGE_SIZE_BYTES) throw new Error(`${file.name}: image is too large. Please keep it under 5 MB.`);
        setUploadStatus(`Preparing ${file.name}...`);
        const extractedText = isPdf ? await extractPdfText(file) : undefined;
        const dataUrl = isImage ? await fileToDataUrl(file) : undefined;
        if (isPdf && !extractedText?.trim()) throw new Error(`${file.name}: no readable text was found.`);
        parsed.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, type: isPdf ? "pdf" : "image", extractedText: extractedText?.trim(), mimeType: file.type || (isPdf ? "application/pdf" : "image/jpeg"), dataUrl, origin });
      }
      setAttachments((current) => {
        const next = [...current];
        for (const item of parsed) {
          const index = next.findIndex((existing) => existing.id === item.id);
          if (index >= 0) next[index] = item;
          else next.push(item);
        }
        return next;
      });
      setActiveSource("files");
      setUploadStatus(`Added ${parsed.length} file${parsed.length === 1 ? "" : "s"} successfully.`);
    } catch (err: any) {
      setError(err.message || "Could not read the selected file.");
      setUploadStatus("");
    } finally {
      event.target.value = "";
      setUploading(false);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const next = current.filter((item) => item.id !== id);
      if (next.length === 0) {
        setActiveSource(null);
        setUploadStatus("");
      }
      return next;
    });
  };

  const handleTextChange = (value: string) => {
    if (attachments.length > 0) {
      setError("Remove your uploaded file or camera photo before pasting notes.");
      return;
    }
    if (error) setError("");
    setActiveSource(value.trim() ? "text" : null);
    setText(value);
  };

  const handleGenerate = async () => {
    if (!text.trim() && attachments.length === 0) {
      setError("Please enter notes or upload a PDF, image, or camera photo first.");
      return;
    }
    setLoading(true);
    setQuestions(null);
    setError("");
    try {
      const res = await fetch(`/.netlify/functions/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          mode,
          difficulty,
          attachments: attachments.map((item) => ({
            name: item.name,
            type: item.type,
            extractedText: item.extractedText ?? "",
            dataUrl: item.dataUrl ?? "",
            mimeType: item.mimeType,
            origin: item.origin,
          })),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error ${res.status}`);
      }
      const data = await res.json();
      setQuestions(data);
      if (historyOpen) await loadHistory();
    } catch (err: any) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const hasResults = questions && (
    questions.multiple_choice?.length > 0 ||
    questions.short_answer?.length > 0 ||
    questions.true_false?.length > 0 ||
    questions.flashcards?.length > 0
  );

  return (
    <main style={{ minHeight: "100vh", background: "linear-gradient(180deg, #06060b 0%, #0b0b12 45%, #11111a 100%)", color: "#f2efff", fontFamily: "'Cormorant Garamond', serif", position: "relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Background />
      <button type="button" onClick={toggleHistory} style={{ position: "fixed", top: 20, right: 20, zIndex: 30, width: 48, height: 48, borderRadius: 16, border: "1px solid rgba(167,139,250,0.25)", background: "linear-gradient(135deg, rgba(17,17,26,0.92), rgba(11,11,18,0.82))", color: "#f2efff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 12px 30px rgba(0,0,0,0.35)", cursor: "pointer", backdropFilter: "blur(18px)" }}>
        {historyOpen ? <X style={{ width: 18, height: 18 }} /> : <Ellipsis style={{ width: 18, height: 18 }} />}
      </button>
      {historyOpen && <aside style={{ position: "fixed", top: 80, right: 16, width: "min(360px, calc(100vw - 32px))", maxHeight: "calc(100vh - 110px)", overflowY: "auto", zIndex: 25, borderRadius: 24, padding: 20, background: "linear-gradient(180deg, rgba(17,17,26,0.96), rgba(11,11,18,0.96))", border: "1px solid rgba(167,139,250,0.18)", boxShadow: "0 22px 70px rgba(0,0,0,0.42)", backdropFilter: "blur(24px)", animation: "sidebar-in 0.24s ease both" }}>
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 11, letterSpacing: 3, color: "#f9a8d4", fontFamily: "'DM Mono', monospace", marginBottom: 8 }}>HISTORY</p>
          <p style={{ fontSize: 13, color: "#a59dbd", fontFamily: "'DM Mono', monospace", lineHeight: 1.6 }}>Recent saved study sessions from Turso.</p>
        </div>
        {historyLoading ? <p style={{ fontSize: 12, color: "#a59dbd", fontFamily: "'DM Mono', monospace" }}>Loading history...</p> : history.length === 0 ? <p style={{ fontSize: 12, color: "#a59dbd", fontFamily: "'DM Mono', monospace" }}>No history yet.</p> : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{history.map((item) => <button key={item.id} type="button" onClick={() => openHistorySession(item.id)} style={{ padding: "14px", borderRadius: 16, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", textAlign: "left", cursor: "pointer" }}><p style={{ fontSize: 12, color: "#f2efff", fontFamily: "'DM Mono', monospace", marginBottom: 8 }}>{item.source_names || item.source_kind.toUpperCase()}</p><p style={{ fontSize: 10, color: "#f9a8d4", fontFamily: "'DM Mono', monospace", letterSpacing: 1.5, marginBottom: 6 }}>{item.mode.toUpperCase()} • {item.difficulty.toUpperCase()}</p><p style={{ fontSize: 10, color: "#a59dbd", fontFamily: "'DM Mono', monospace", lineHeight: 1.6 }}>{new Date(item.created_at).toLocaleString()} • {item.model_used}</p></button>)}</div>}
      </aside>}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "64px 24px 100px", position: "relative", zIndex: 1 }}>
        <div style={{ textAlign: "center", marginBottom: 52, animation: "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 16 }}>
            <div style={{ height: 1, width: 32, background: "linear-gradient(90deg, transparent, #a78bfa)" }} />
            <span style={{ fontSize: 10, color: "#a78bfa", letterSpacing: 5, fontFamily: "'DM Mono', monospace" }}>AI STUDY BUDDY</span>
            <div style={{ height: 1, width: 32, background: "linear-gradient(90deg, #a78bfa, transparent)" }} />
          </div>
          <h1 style={{ fontSize: "clamp(36px, 5.5vw, 56px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: -0.5, marginBottom: 16 }}>
            <span style={{ color: "#f2efff" }}>Turn notes into</span><br />
            <span style={{ background: "linear-gradient(135deg, #a78bfa, #f9a8d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontStyle: "italic", fontWeight: 400 }}>smart questions.</span>
          </h1>
          <p style={{ fontSize: 13, color: "#a59dbd", fontFamily: "'DM Mono', monospace", letterSpacing: 1 }}>Powered by Groq · Turso · Vision</p>
        </div>
        <div style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.035), rgba(255,255,255,0.012))", backdropFilter: "blur(20px)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 24, padding: "32px", marginBottom: 32, boxShadow: "0 24px 70px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.05)", animation: "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) 0.1s both", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(105deg, transparent 40%, rgba(167,139,250,0.05) 50%, transparent 60%)", animation: "shimmer-x 6s ease-in-out infinite", pointerEvents: "none" }} />
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>YOUR NOTES</div>
            <textarea value={text} onChange={(e) => handleTextChange(e.target.value)} placeholder="Paste your study notes here, or upload a PDF, image, or camera photo below..." style={{ width: "100%", minHeight: 180, resize: "vertical", background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.22)", borderRadius: 14, padding: "16px 18px", fontSize: 13, color: "#f2efff", fontFamily: "'DM Mono', monospace", lineHeight: 1.8, letterSpacing: 0.3 }} disabled={attachments.length > 0} />
          </div>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>PDFS & PHOTOS</div>
            <div style={{ border: "1px dashed rgba(167,139,250,0.32)", background: "rgba(167,139,250,0.04)", borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: attachments.length > 0 || uploadStatus ? 14 : 0 }}>
                <label style={{ padding: "10px 16px", borderRadius: 12, cursor: uploading ? "not-allowed" : "pointer", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.24)", color: "#f2efff", fontSize: 12, fontFamily: "'DM Mono', monospace", letterSpacing: 1, opacity: uploading ? 0.7 : 1 }}>
                  <input type="file" accept="application/pdf,image/*" multiple disabled={uploading || Boolean(text.trim())} onChange={(event) => handleFilesAdded(event, "upload")} style={{ display: "none" }} />
                  {uploading ? "READING FILES..." : "ADD PDF OR IMAGE"}
                </label>
                <label style={{ padding: "10px 16px", borderRadius: 12, cursor: uploading || Boolean(text.trim()) ? "not-allowed" : "pointer", background: "rgba(249,168,212,0.12)", border: "1px solid rgba(249,168,212,0.24)", color: "#f9a8d4", fontSize: 12, fontFamily: "'DM Mono', monospace", letterSpacing: 1, opacity: uploading || Boolean(text.trim()) ? 0.7 : 1 }}>
                  <input type="file" accept="image/*" capture="environment" disabled={uploading || Boolean(text.trim())} onChange={(event) => handleFilesAdded(event, "camera")} style={{ display: "none" }} />
                  TAKE PHOTO
                </label>
                <p style={{ fontSize: 11, color: "#a59dbd", fontFamily: "'DM Mono', monospace", lineHeight: 1.6 }}>PDFs use extracted text. Images and camera photos use vision. PDFs up to 3 MB, images up to 5 MB.</p>
              </div>
              {uploadStatus && <p style={{ fontSize: 11, color: "#ddd6fe", fontFamily: "'DM Mono', monospace", marginBottom: attachments.length > 0 ? 12 : 0 }}>{uploadStatus}</p>}
              {attachments.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{attachments.map((item) => <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}><div><p style={{ fontSize: 12, color: "#f2efff", fontFamily: "'DM Mono', monospace" }}>{item.name}</p><p style={{ fontSize: 10, color: "#a59dbd", fontFamily: "'DM Mono', monospace", letterSpacing: 1.2 }}>{item.type === "pdf" ? "PDF TEXT EXTRACTED" : item.origin === "camera" ? "CAMERA PHOTO WITH VISION" : "IMAGE WITH VISION"}</p></div><button type="button" onClick={() => removeAttachment(item.id)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.2)", background: "rgba(248,113,113,0.06)", color: "#f87171", cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", letterSpacing: 1 }}>REMOVE</button></div>)}</div>}
            </div>
          </div>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>DIFFICULTY</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {difficultyOptions.map((option) => {
                const active = difficulty === option.value;
                return <button key={option.value} type="button" onClick={() => setDifficulty(option.value)} style={{ padding: "10px 16px", borderRadius: 12, cursor: "pointer", fontSize: 12, fontFamily: "'DM Mono', monospace", letterSpacing: 1, background: active ? `linear-gradient(135deg, ${option.accent}, #857ca2)` : "rgba(255,255,255,0.04)", color: active ? "#06060b" : "#f2efff", border: `1px solid ${active ? option.accent : "rgba(255,255,255,0.08)"}`, boxShadow: active ? `0 0 24px ${option.accent}40` : "none" }}>{option.label}</button>;
              })}
            </div>
          </div>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, color: "#f9a8d4", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>QUESTION TYPE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {modeOptions.map((opt) => {
                const Icon = opt.icon;
                const active = mode === opt.value;
                return <button key={opt.value} onClick={() => setMode(opt.value)} style={{ padding: "10px 16px", borderRadius: 12, cursor: "pointer", fontSize: 12, fontFamily: "'DM Mono', monospace", letterSpacing: 1, background: active ? "linear-gradient(135deg, #857ca2, #a78bfa)" : "rgba(167,139,250,0.06)", color: active ? "#06060b" : "#f2efff", border: `1px solid ${active ? "#a78bfa" : "rgba(167,139,250,0.2)"}`, boxShadow: active ? "0 0 20px rgba(167,139,250,0.28)" : "none", display: "flex", alignItems: "center", gap: 7 }}><Icon style={{ width: 13, height: 13 }} />{opt.label}</button>;
              })}
            </div>
          </div>
          {error && <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}><p style={{ fontSize: 12, color: "#f87171", fontFamily: "'DM Mono', monospace" }}>{error}</p></div>}
          {activeSource && <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}><p style={{ fontSize: 11, color: "#ddd6fe", fontFamily: "'DM Mono', monospace", letterSpacing: 1.2 }}>SOURCE MODE: {activeSource === "text" ? "PASTED NOTES" : "FILES / CAMERA"} • DIFFICULTY: {difficulty.toUpperCase()}</p></div>}
          <button onClick={handleGenerate} disabled={loading} style={{ width: "100%", padding: "18px", borderRadius: 14, border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.85 : 1, background: loading ? "rgba(167,139,250,0.3)" : "linear-gradient(135deg, #857ca2, #a78bfa, #f9a8d4)", color: "#06060b", fontWeight: 600, fontSize: 13, fontFamily: "'DM Mono', monospace", letterSpacing: 3, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: loading ? "none" : "0 0 32px rgba(167,139,250,0.32), 0 4px 20px rgba(249,168,212,0.2)", position: "relative", overflow: "hidden" }}>
            {!loading && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent)", animation: "shimmer-x 3s ease-in-out infinite" }} />}
            {loading ? <><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce 0.8s 0s ease-in-out infinite" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce 0.8s 0.2s ease-in-out infinite" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#06060b", animation: "dot-bounce 0.8s 0.4s ease-in-out infinite" }} /><span>GENERATING</span></> : <><Sparkles style={{ width: 15, height: 15 }} /><span>GENERATE QUESTIONS</span></>}
          </button>
        </div>
        {hasResults && <div style={{ animation: "fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both" }}>
          {questions.multiple_choice?.length > 0 && <div style={{ marginBottom: 36 }}><SectionLabel text={`Multiple Choice · ${questions.multiple_choice.length} questions`} color="#a78bfa" /><div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{questions.multiple_choice.map((q: any, i: number) => <MCQCard key={i} q={q} idx={i} delay={i * 70} />)}</div></div>}
          {questions.short_answer?.length > 0 && <div style={{ marginBottom: 36 }}><SectionLabel text={`Short Answer · ${questions.short_answer.length} questions`} color="#f9a8d4" /><div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{questions.short_answer.map((q: any, i: number) => <ShortAnswerCard key={i} q={q} idx={i} delay={i * 70} />)}</div></div>}
          {questions.true_false?.length > 0 && <div style={{ marginBottom: 36 }}><SectionLabel text={`True / False · ${questions.true_false.length} questions`} color="#f87171" /><div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{questions.true_false.map((q: any, i: number) => <TrueFalseCard key={i} q={q} idx={i} delay={i * 70} />)}</div></div>}
          {questions.flashcards?.length > 0 && <div style={{ marginBottom: 36 }}><SectionLabel text={`Flashcards · ${questions.flashcards.length} cards · tap to flip`} color="#ddd6fe" /><div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{questions.flashcards.map((q: any, i: number) => <Flashcard key={i} q={q} idx={i} delay={i * 70} />)}</div></div>}
        </div>}
      </div>
      <div style={{ position: "relative", zIndex: 1, paddingBottom: 34 }}>
        <p style={{ textAlign: "center", fontSize: 13, fontFamily: "'DM Mono', monospace", letterSpacing: 2, color: "#f9a8d4", textShadow: "0 0 18px rgba(249,168,212,0.24)" }}>made by aawaz</p>
      </div>
    </main>
  );
}
