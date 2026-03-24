"use client";
import { useState } from "react";
import { Sparkles, BookOpen, ToggleLeft, AlignLeft, Layers, ChevronDown, ChevronUp } from "lucide-react";

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
    Tesseract?: {
      recognize: (
        image: File,
        language: string,
        options?: {
          logger?: (info: { status?: string; progress?: number }) => void;
        }
      ) => Promise<{ data: { text: string } }>;
    };
  }
}

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=DM+Mono:wght@300;400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #05050e; overflow-x: hidden; }
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3b1f6a; border-radius: 99px; }
  ::selection { background: #7c3aed44; color: #e9d5ff; }
  textarea:focus { outline: none; }
  textarea::placeholder { color: #374151; }
  @keyframes float-orb {
    0%, 100% { transform: translate(0,0) scale(1); }
    33% { transform: translate(30px,-40px) scale(1.08); }
    66% { transform: translate(-20px,20px) scale(0.94); }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes shimmer-x {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  @keyframes spin-icon {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes dot-bounce {
    0%, 100% { transform: translateY(0); opacity: 0.4; }
    50% { transform: translateY(-5px); opacity: 1; }
  }
  @keyframes card-in {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes grid-drift {
    0% { transform: translateX(0) translateY(0); }
    100% { transform: translateX(40px) translateY(40px); }
  }
  @keyframes flip-in {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

const modeOptions = [
  { value: "mix", label: "Mixed", icon: Layers },
  { value: "multiple-choice", label: "Multiple Choice", icon: BookOpen },
  { value: "short-answer", label: "Short Answer", icon: AlignLeft },
  { value: "true-false", label: "True / False", icon: ToggleLeft },
  { value: "flashcard", label: "Flashcards", icon: Sparkles },
];

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;

type Attachment = {
  id: string;
  name: string;
  type: "pdf" | "image";
  extractedText: string;
};

let pdfJsLoader: Promise<void> | null = null;
let tesseractLoader: Promise<void> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
      } else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensurePdfJs() {
  if (!pdfJsLoader) {
    pdfJsLoader = loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js").then(() => {
      if (!window.pdfjsLib) {
        throw new Error("PDF reader failed to load.");
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    });
  }
  await pdfJsLoader;
}

async function ensureTesseract() {
  if (!tesseractLoader) {
    tesseractLoader = loadScript("https://unpkg.com/tesseract.js@5/dist/tesseract.min.js").then(() => {
      if (!window.Tesseract) {
        throw new Error("Image reader failed to load.");
      }
    });
  }
  await tesseractLoader;
}

async function extractPdfText(file: File) {
  await ensurePdfJs();
  if (!window.pdfjsLib) {
    throw new Error("PDF reader is unavailable.");
  }

  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => item.str?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      pages.push(pageText);
    }
  }

  return pages.join("\n");
}

async function extractImageText(
  file: File,
  onProgress: (message: string) => void
) {
  await ensureTesseract();
  if (!window.Tesseract) {
    throw new Error("Image reader is unavailable.");
  }

  const result = await window.Tesseract.recognize(file, "eng", {
    logger: (info) => {
      if (info.status === "recognizing text" && typeof info.progress === "number") {
        onProgress(`Reading image text... ${Math.round(info.progress * 100)}%`);
      }
    },
  });

  return result.data.text;
}

function Background() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: "-40px", backgroundImage: "linear-gradient(rgba(124,58,237,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(124,58,237,0.04) 1px, transparent 1px)", backgroundSize: "60px 60px", animation: "grid-drift 20s linear infinite" }} />
      <div style={{ position: "absolute", top: "-10%", left: "-5%", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, #4c1d9522 0%, transparent 70%)", animation: "float-orb 18s ease-in-out infinite", filter: "blur(1px)" }} />
      <div style={{ position: "absolute", bottom: "-15%", right: "-10%", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, #6d28d91a 0%, transparent 70%)", animation: "float-orb 24s ease-in-out infinite reverse", filter: "blur(1px)" }} />
      <div style={{ position: "absolute", top: "45%", right: "15%", width: 350, height: 350, borderRadius: "50%", background: "radial-gradient(circle, #be185d0e 0%, transparent 70%)", animation: "float-orb 15s ease-in-out infinite 5s" }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.02, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`, backgroundSize: "200px" }} />
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

function GlassCard({ children, accent = "#7c3aed", delay = 0, style = {} }: {
  children: React.ReactNode; accent?: string; delay?: number; style?: React.CSSProperties;
}) {
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
      ...style,
    }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(105deg, transparent 40%, ${accent}07 50%, transparent 60%)`, animation: "shimmer-x 5s ease-in-out infinite", pointerEvents: "none" }} />
      {children}
    </div>
  );
}

function Flashcard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div onClick={() => setFlipped(f => !f)} style={{ animation: `flip-in 0.5s cubic-bezier(0.22,1,0.36,1) ${delay}ms both`, cursor: "pointer" }}>
      <div style={{
        background: flipped ? "linear-gradient(135deg, rgba(124,58,237,0.15), rgba(109,40,217,0.08))" : "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
        border: `1px solid ${flipped ? "#7c3aed66" : "#7c3aed22"}`,
        borderLeft: `2px solid ${flipped ? "#a78bfa" : "#7c3aed"}`,
        borderRadius: 16, padding: "22px 24px", position: "relative", overflow: "hidden",
        boxShadow: flipped ? "0 8px 40px rgba(124,58,237,0.2)" : "0 4px 20px rgba(124,58,237,0.06)",
        transition: "all 0.35s cubic-bezier(0.22,1,0.36,1)", minHeight: 90,
      }}>
        <div style={{ position: "absolute", top: 14, right: 16, fontSize: 9, color: flipped ? "#a78bfa" : "#4b5563", fontFamily: "'DM Mono', monospace", letterSpacing: 2 }}>
          {flipped ? "ANSWER" : "TAP TO REVEAL"}
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
          <p style={{ fontSize: 14, color: flipped ? "#e9d5ff" : "#d1d5db", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, transition: "color 0.3s", paddingRight: 80 }}>
            {flipped ? q.answer : q.question}
          </p>
        </div>
      </div>
    </div>
  );
}

function MCQCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [revealed, setRevealed] = useState(false);

  // Fixed: safely handle array (current backend) or string (legacy format)
  const options = Array.isArray(q.options)
    ? q.options.filter((o: any) => typeof o === 'string' && o.trim())
    : typeof q.options === 'string'
      ? q.options.split("\n").filter((o: string) => o.trim())
      : [];

  // Robust answer letter extraction
  const correctLetter = String(q.answer ?? "")
    .trim()
    .toUpperCase()
    .match(/[A-D]/)?.[0] || "";

  return (
    <GlassCard accent="#a78bfa" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>
          {String(idx + 1).padStart(2, "0")}
        </span>
        <p style={{ fontSize: 14, color: "#f3f4f6", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>
          {q.question}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 28, marginBottom: 14 }}>
        {options.map((opt: string, i: number) => {
          const letter = opt.trim().charAt(0).toUpperCase();
          const isCorrect = revealed && letter === correctLetter;

          return (
            <div
              key={i}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: isCorrect ? "rgba(167,139,250,0.15)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${isCorrect ? "#a78bfa55" : "rgba(255,255,255,0.06)"}`,
                fontSize: 13,
                color: isCorrect ? "#e9d5ff" : "#9ca3af",
                fontFamily: "'DM Mono', monospace",
                lineHeight: 1.5,
                transition: "all 0.3s ease",
                boxShadow: isCorrect ? "0 0 16px rgba(167,139,250,0.15)" : "none",
              }}
            >
              {opt}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setRevealed(r => !r)}
        style={{
          marginLeft: 28,
          padding: "8px 16px",
          borderRadius: 99,
          border: "1px solid rgba(167,139,250,0.3)",
          background: revealed ? "rgba(167,139,250,0.15)" : "transparent",
          color: revealed ? "#e9d5ff" : "#7c6fa0",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "'DM Mono', monospace",
          letterSpacing: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
          transition: "all 0.25s ease",
        }}
      >
        {revealed ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
        {revealed ? `ANSWER: ${correctLetter || "?"}` : "REVEAL ANSWER"}
      </button>
    </GlassCard>
  );
}

function ShortAnswerCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <GlassCard accent="#34d399" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
        <p style={{ fontSize: 14, color: "#f3f4f6", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>{q.question}</p>
      </div>
      {revealed && (
        <div style={{ marginLeft: 28, padding: "12px 16px", borderRadius: 10, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", marginBottom: 12 }}>
          <p style={{ fontSize: 13, color: "#6ee7b7", fontFamily: "'DM Mono', monospace", lineHeight: 1.7 }}>{q.answer}</p>
        </div>
      )}
      <button onClick={() => setRevealed(r => !r)} style={{
        marginLeft: 28, padding: "8px 16px", borderRadius: 99,
        border: "1px solid rgba(52,211,153,0.3)",
        background: revealed ? "rgba(52,211,153,0.1)" : "transparent",
        color: revealed ? "#6ee7b7" : "#4b7a6a", cursor: "pointer", fontSize: 11,
        fontFamily: "'DM Mono', monospace", letterSpacing: 2,
        display: "flex", alignItems: "center", gap: 6, transition: "all 0.25s ease",
      }}>
        {revealed ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
        {revealed ? "HIDE ANSWER" : "REVEAL ANSWER"}
      </button>
    </GlassCard>
  );
}

function TrueFalseCard({ q, idx, delay }: { q: any; idx: number; delay: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  // Safely handle both boolean and string answers
  const correctAnswer = typeof q.answer === "boolean"
    ? (q.answer ? "True" : "False")
    : String(q.answer).trim().charAt(0).toUpperCase() + String(q.answer).trim().slice(1).toLowerCase();

  return (
    <GlassCard accent="#f87171" delay={delay}>
      <div style={{ display: "flex", gap: 14, marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Mono', monospace", marginTop: 2, flexShrink: 0 }}>{String(idx + 1).padStart(2, "0")}</span>
        <p style={{ fontSize: 14, color: "#f3f4f6", fontFamily: "'DM Mono', monospace", lineHeight: 1.7, fontWeight: 500 }}>{q.statement}</p>
      </div>
      <div style={{ display: "flex", gap: 10, marginLeft: 28, alignItems: "center" }}>
        {["True", "False"].map(option => {
          const isCorrect = selected !== null && option === correctAnswer;
          const isWrong = selected === option && option !== correctAnswer;
          return (
            <button key={option} onClick={() => setSelected(option)} style={{
              padding: "10px 28px", borderRadius: 10, cursor: "pointer", fontSize: 13,
              fontFamily: "'DM Mono', monospace", letterSpacing: 1, fontWeight: 500,
              background: isCorrect ? "rgba(52,211,153,0.2)" : isWrong ? "rgba(248,113,113,0.2)" : "rgba(255,255,255,0.04)",
              color: isCorrect ? "#6ee7b7" : isWrong ? "#fca5a5" : "#9ca3af",
              border: `1px solid ${isCorrect ? "rgba(52,211,153,0.4)" : isWrong ? "rgba(248,113,113,0.4)" : "rgba(255,255,255,0.1)"}`,
              transition: "all 0.25s ease",
              boxShadow: isCorrect ? "0 0 16px rgba(52,211,153,0.2)" : "none",
            }}>{option}</button>
          );
        })}
        {selected && selected !== correctAnswer && (
          <span style={{ fontSize: 11, color: "#6ee7b7", fontFamily: "'DM Mono', monospace", letterSpacing: 1, marginLeft: 4 }}>
            ✓ {correctAnswer}
          </span>
        )}
      </div>
    </GlassCard>
  );
}

export default function Home() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("mix");
  const [questions, setQuestions] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");

  const combinedText = [text.trim(), ...attachments.map((item) => item.extractedText.trim()).filter(Boolean)]
    .filter(Boolean)
    .join("\n\n");

  const handleFilesAdded = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) {
      return;
    }

    if (text.trim()) {
      setError("Clear your pasted notes before adding a PDF or photo.");
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

        if (!isPdf && !isImage) {
          throw new Error(`${file.name}: only PDF and image files are supported.`);
        }

        if (isPdf && file.size > MAX_PDF_SIZE_BYTES) {
          throw new Error(`${file.name}: PDF is too large. Please keep it under 3 MB.`);
        }

        if (isImage && file.size > MAX_IMAGE_SIZE_BYTES) {
          throw new Error(`${file.name}: image is too large. Please keep it under 5 MB.`);
        }

        setUploadStatus(`Extracting text from ${file.name}...`);
        const extractedText = isPdf
          ? await extractPdfText(file)
          : await extractImageText(file, setUploadStatus);

        if (!extractedText.trim()) {
          throw new Error(`${file.name}: no readable text was found.`);
        }

        parsed.push({
          id: `${file.name}-${file.size}-${file.lastModified}`,
          name: file.name,
          type: isPdf ? "pdf" : "image",
          extractedText: extractedText.trim(),
        });
      }

      setAttachments((current) => {
        const next = [...current];
        for (const item of parsed) {
          const index = next.findIndex((existing) => existing.id === item.id);
          if (index >= 0) {
            next[index] = item;
          } else {
            next.push(item);
          }
        }
        return next;
      });

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
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  const handleTextChange = (value: string) => {
    if (attachments.length > 0) {
      setError("Remove your uploaded PDF/photo before pasting notes.");
      return;
    }
    if (error) {
      setError("");
    }
    setText(value);
  };

  const handleGenerate = async () => {
    if (!combinedText.trim()) { setError("Please enter notes or upload a small PDF/photo first."); return; }
    setLoading(true); setQuestions(null); setError("");
    try {
      const res = await fetch(`/.netlify/functions/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: combinedText, mode }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error ${res.status}`);
      }
      const data = await res.json();
      setQuestions(data);
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
    <main style={{ minHeight: "100vh", background: "#05050e", color: "#e5e7eb", fontFamily: "'Cormorant Garamond', serif", position: "relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Background />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px 80px", position: "relative", zIndex: 1 }}>
        {/* Hero */}
        <div style={{ textAlign: "center", marginBottom: 52, animation: "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 16 }}>
            <div style={{ height: 1, width: 32, background: "linear-gradient(90deg, transparent, #7c3aed)" }} />
            <span style={{ fontSize: 10, color: "#7c3aed", letterSpacing: 5, fontFamily: "'DM Mono', monospace" }}>AI STUDY BUDDY</span>
            <div style={{ height: 1, width: 32, background: "linear-gradient(90deg, #7c3aed, transparent)" }} />
          </div>
          <h1 style={{ fontSize: "clamp(36px, 5.5vw, 56px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: -0.5, marginBottom: 16 }}>
            <span style={{ color: "#f3f4f6" }}>Turn notes into</span><br />
            <span style={{ background: "linear-gradient(135deg, #c4b5fd, #f9a8d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontStyle: "italic", fontWeight: 400 }}>smart questions.</span>
          </h1>
          <p style={{ fontSize: 13, color: "#8b8fa8", fontFamily: "'DM Mono', monospace", letterSpacing: 1 }}>
            Powered by Groq · Instant · Free
          </p>
        </div>

        {/* Input Card */}
        <div style={{
          background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
          backdropFilter: "blur(20px)", border: "1px solid rgba(124,58,237,0.2)", borderRadius: 24,
          padding: "32px", marginBottom: 32,
          boxShadow: "0 20px 60px rgba(124,58,237,0.08), inset 0 1px 0 rgba(255,255,255,0.05)",
          animation: "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) 0.1s both",
          position: "relative", overflow: "hidden",
        }}>
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(105deg, transparent 40%, rgba(124,58,237,0.04) 50%, transparent 60%)", animation: "shimmer-x 6s ease-in-out infinite", pointerEvents: "none" }} />
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: "#8b8fa8", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>YOUR NOTES</div>
            <textarea value={text} onChange={e => handleTextChange(e.target.value)}
              placeholder="Paste your study notes here, or upload a small PDF/image below..."
              style={{
                width: "100%", minHeight: 180, resize: "vertical",
                background: "rgba(124,58,237,0.05)", border: "1px solid rgba(124,58,237,0.2)",
                borderRadius: 14, padding: "16px 18px", fontSize: 13, color: "#d1d5db",
                fontFamily: "'DM Mono', monospace", lineHeight: 1.8, letterSpacing: 0.3,
                transition: "border-color 0.25s, box-shadow 0.25s",
              }}
              onFocus={e => { e.target.style.borderColor = "#7c3aed"; e.target.style.boxShadow = "0 0 0 3px rgba(124,58,237,0.1)"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(124,58,237,0.2)"; e.target.style.boxShadow = "none"; }}
              disabled={attachments.length > 0}
            />
          </div>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, color: "#8b8fa8", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>PDFS & PHOTOS</div>
            <div style={{
              border: "1px dashed rgba(124,58,237,0.32)",
              background: "rgba(124,58,237,0.04)",
              borderRadius: 14,
              padding: 16,
            }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: attachments.length > 0 || uploadStatus ? 14 : 0 }}>
                <label style={{
                  padding: "10px 16px",
                  borderRadius: 12,
                  cursor: uploading ? "not-allowed" : "pointer",
                  background: "rgba(124,58,237,0.12)",
                  border: "1px solid rgba(124,58,237,0.24)",
                  color: "#d8b4fe",
                  fontSize: 12,
                  fontFamily: "'DM Mono', monospace",
                  letterSpacing: 1,
                  opacity: uploading ? 0.7 : 1,
                }}>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    multiple
                    disabled={uploading || Boolean(text.trim())}
                    onChange={handleFilesAdded}
                    style={{ display: "none" }}
                  />
                  {uploading ? "READING FILES..." : "ADD PDF OR PHOTO"}
                </label>
                <p style={{ fontSize: 11, color: "#7c84a3", fontFamily: "'DM Mono', monospace", lineHeight: 1.6 }}>
                  Small files only. PDFs up to 3 MB, photos up to 5 MB.
                </p>
              </div>
              {uploadStatus && (
                <p style={{ fontSize: 11, color: "#c4b5fd", fontFamily: "'DM Mono', monospace", marginBottom: attachments.length > 0 ? 12 : 0 }}>
                  {uploadStatus}
                </p>
              )}
              {attachments.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {attachments.map((item) => (
                    <div key={item.id} style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}>
                      <div>
                        <p style={{ fontSize: 12, color: "#e5e7eb", fontFamily: "'DM Mono', monospace" }}>{item.name}</p>
                        <p style={{ fontSize: 10, color: "#8b8fa8", fontFamily: "'DM Mono', monospace", letterSpacing: 1.2 }}>
                          {item.type === "pdf" ? "PDF TEXT EXTRACTED" : "PHOTO TEXT EXTRACTED"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(item.id)}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(248,113,113,0.2)",
                          background: "rgba(248,113,113,0.06)",
                          color: "#fca5a5",
                          cursor: "pointer",
                          fontSize: 11,
                          fontFamily: "'DM Mono', monospace",
                          letterSpacing: 1,
                        }}
                      >
                        REMOVE
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, color: "#8b8fa8", letterSpacing: 3, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>QUESTION TYPE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {modeOptions.map(opt => {
                const Icon = opt.icon;
                const active = mode === opt.value;
                return (
                  <button key={opt.value} onClick={() => setMode(opt.value)} style={{
                    padding: "10px 16px", borderRadius: 12, cursor: "pointer", fontSize: 12,
                    fontFamily: "'DM Mono', monospace", letterSpacing: 1,
                    background: active ? "linear-gradient(135deg, #4c1d95, #7c3aed)" : "rgba(124,58,237,0.06)",
                    color: active ? "#e9d5ff" : "#6b7280",
                    border: `1px solid ${active ? "#7c3aed" : "rgba(124,58,237,0.2)"}`,
                    boxShadow: active ? "0 0 20px rgba(124,58,237,0.35)" : "none",
                    transition: "all 0.25s cubic-bezier(0.22,1,0.36,1)",
                    display: "flex", alignItems: "center", gap: 7,
                  }}
                    onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(124,58,237,0.5)"; (e.currentTarget as HTMLButtonElement).style.color = "#c4b5fd"; }}}
                    onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(124,58,237,0.2)"; (e.currentTarget as HTMLButtonElement).style.color = "#6b7280"; }}}
                  >
                    <Icon style={{ width: 13, height: 13 }} />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {error && (
            <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
              <p style={{ fontSize: 12, color: "#fca5a5", fontFamily: "'DM Mono', monospace" }}>{error}</p>
            </div>
          )}
          <button onClick={handleGenerate} disabled={loading} style={{
            width: "100%", padding: "18px", borderRadius: 14, border: "none",
            cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.8 : 1,
            background: loading ? "rgba(124,58,237,0.3)" : "linear-gradient(135deg, #4c1d95, #7c3aed, #6d28d9)",
            color: "#e9d5ff", fontWeight: 500, fontSize: 13,
            fontFamily: "'DM Mono', monospace", letterSpacing: 3,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            boxShadow: loading ? "none" : "0 0 32px rgba(124,58,237,0.45), 0 4px 20px rgba(124,58,237,0.3)",
            transition: "all 0.3s ease", position: "relative", overflow: "hidden",
          }}>
            {!loading && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)", animation: "shimmer-x 3s ease-in-out infinite" }} />}
            {loading ? (
              <>
                {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", animation: `dot-bounce 0.8s ${i * 0.2}s ease-in-out infinite` }} />)}
                <span>GENERATING</span>
              </>
            ) : (
              <>
                <Sparkles style={{ width: 15, height: 15 }} />
                <span>GENERATE QUESTIONS</span>
              </>
            )}
          </button>
        </div>

        {/* Results */}
        {hasResults && (
          <div style={{ animation: "fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both" }}>
            {questions.multiple_choice?.length > 0 && (
              <div style={{ marginBottom: 36 }}>
                <SectionLabel text={`Multiple Choice · ${questions.multiple_choice.length} questions`} color="#a78bfa" />
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {questions.multiple_choice.map((q: any, i: number) => <MCQCard key={i} q={q} idx={i} delay={i * 70} />)}
                </div>
              </div>
            )}
            {questions.short_answer?.length > 0 && (
              <div style={{ marginBottom: 36 }}>
                <SectionLabel text={`Short Answer · ${questions.short_answer.length} questions`} color="#34d399" />
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {questions.short_answer.map((q: any, i: number) => <ShortAnswerCard key={i} q={q} idx={i} delay={i * 70} />)}
                </div>
              </div>
            )}
            {questions.true_false?.length > 0 && (
              <div style={{ marginBottom: 36 }}>
                <SectionLabel text={`True / False · ${questions.true_false.length} questions`} color="#f87171" />
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {questions.true_false.map((q: any, i: number) => <TrueFalseCard key={i} q={q} idx={i} delay={i * 70} />)}
                </div>
              </div>
            )}
            {questions.flashcards?.length > 0 && (
              <div style={{ marginBottom: 36 }}>
                <SectionLabel text={`Flashcards · ${questions.flashcards.length} cards · tap to flip`} color="#c4b5fd" />
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {questions.flashcards.map((q: any, i: number) => <Flashcard key={i} q={q} idx={i} delay={i * 70} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
