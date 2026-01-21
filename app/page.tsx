"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function Home() {
  const sampleNotes = `The water cycle describes how water moves between the Earth's surface and the atmosphere.

The process has four main stages: evaporation, condensation, precipitation, and collection.

Evaporation occurs when the sun's heat turns water from liquid into vapor. This happens from oceans, lakes, rivers, and even soil.

Condensation is when water vapor cools and turns back into liquid droplets. This forms clouds in the atmosphere.

Precipitation happens when clouds become heavy with water droplets and release them as rain, snow, sleet, or hail.

Collection is when the precipitation falls back to Earth and collects in bodies of water, soil, and underground aquifers.

The water cycle is continuous and essential for life on Earth. It distributes fresh water across the planet and regulates temperature.

About 97% of Earth's water is saltwater in oceans, while only 3% is freshwater that humans can use.`;

  const [text, setText] = useState(sampleNotes);
  const [mode, setMode] = useState("mix");
  const [questions, setQuestions] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    if (!text.trim()) {
      toast.error("Please enter some study notes first.");
      return;
    }

    setLoading(true);
    setQuestions(null);

    try {
      const res = await fetch("http://localhost:8000/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.detail || "Failed to generate questions");
      }

      const data = await res.json();
      setQuestions(data);
    } catch (err: any) {
      toast.error(err.message || "Something went wrong. Try again later.");
    } finally {
      setLoading(false);
    }
  };

  const renderMultipleChoice = (items: any[]) => (
    <div className="space-y-4">
      {items.map((q, idx) => (
        <Card key={idx} className="border p-4 shadow-sm">
          <p className="font-semibold">{idx + 1}. {q.question}</p>
          <div className="ml-4 mt-2 space-y-1">
            {q.options.split("\n").map((opt: string, i: number) => (
              <p key={i}>{opt}</p>
            ))}
          </div>
          <p className="mt-2 font-bold text-green-600">Answer: {q.answer}</p>
        </Card>
      ))}
    </div>
  );

  const renderShortAnswer = (items: any[]) => (
    <div className="space-y-4">
      {items.map((q, idx) => (
        <Card key={idx} className="border p-4 shadow-sm">
          <p className="font-semibold">{idx + 1}. {q.question}</p>
          <p className="mt-2 font-bold text-green-600">Answer: {q.answer}</p>
        </Card>
      ))}
    </div>
  );

  const renderTrueFalse = (items: any[]) => (
    <div className="space-y-4">
      {items.map((q, idx) => (
        <Card key={idx} className="border p-4 shadow-sm">
          <p className="font-semibold">{idx + 1}. {q.statement}</p>
          <p className="mt-2 font-bold text-green-600">Answer: {q.answer ? "True" : "False"}</p>
        </Card>
      ))}
    </div>
  );

  const renderFlashcards = (items: any[]) => (
    <div className="space-y-4">
      {items.map((q, idx) => (
        <Card key={idx} className="border p-4 shadow-sm">
          <p className="font-semibold">Q: {q.question}</p>
          <p className="mt-1 font-bold text-green-600">A: {q.answer}</p>
        </Card>
      ))}
    </div>
  );

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white dark:from-slate-950 dark:to-slate-900">
      <div className="container mx-auto max-w-4xl px-4 py-12 md:py-20">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
            AI Study Buddy
          </h1>
          <p className="mt-4 text-lg text-slate-600 dark:text-slate-400">
            Turn your notes into smart questions — powered by Gemini
          </p>
        </div>

        {/* Input Form */}
        <Card className="border-2 shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl">Generate Questions</CardTitle>
            <CardDescription>Paste your notes and select question type</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="notes">Your Study Notes</Label>
              <Textarea
                id="notes"
                placeholder="Paste notes here..."
                className="min-h-[180px] resize-y"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mode">Question Type</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger>
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mix">Mixed</SelectItem>
                  <SelectItem value="multiple-choice">Multiple Choice</SelectItem>
                  <SelectItem value="short-answer">Short Answer</SelectItem>
                  <SelectItem value="true-false">True/False</SelectItem>
                  <SelectItem value="flashcard">Flashcards</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full h-12 text-lg font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
            >
              {loading ? "Generating..." : "Generate Questions ✨"}
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        {questions && (
          <div className="mt-10 space-y-8">
            {questions.multiple_choice?.length > 0 && (
              <>
                <h2 className="text-xl font-bold">Multiple Choice</h2>
                {renderMultipleChoice(questions.multiple_choice)}
              </>
            )}

            {questions.short_answer?.length > 0 && (
              <>
                <h2 className="text-xl font-bold">Short Answer</h2>
                {renderShortAnswer(questions.short_answer)}
              </>
            )}

            {questions.true_false?.length > 0 && (
              <>
                <h2 className="text-xl font-bold">True/False</h2>
                {renderTrueFalse(questions.true_false)}
              </>
            )}

            {questions.flashcards?.length > 0 && (
              <>
                <h2 className="text-xl font-bold">Flashcards</h2>
                {renderFlashcards(questions.flashcards)}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
