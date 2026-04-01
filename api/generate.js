/**
 * POST /api/generate
 * Runs generation synchronously and returns all questions in one response.
 * Vercel max duration: 60s (hobby) / 300s (pro) — set in vercel.json
 */
import {
  normalizeStartPayload, LEVELS, LANGUAGES, LEVEL_LABELS, LANG_NAMES,
  generateFast, generateOneQuestionQuality,
  withRetry, runWithConcurrency
} from "./_lib.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const normalized = normalizeStartPayload(payload);
  if (!normalized.ok) return res.status(400).json({ error: normalized.message });

  const { context, languages, topics } = normalized.value;

  // Build task list
  const tasks = [];
  for (const topic of topics) {
    for (const level of LEVELS) {
      for (const language of languages) {
        const count = topic.counts[level];
        if (count > 0) tasks.push({ topic: topic.name, level, language, count });
      }
    }
  }

  const resultByLanguage = Object.fromEntries(languages.map((l) => [l, []]));
  const errors = [];
  const concurrency = context.mode === "quality" ? 2 : 5;

  await runWithConcurrency(tasks, concurrency, async (task) => {
    try {
      if (context.mode === "quality") {
        for (let i = 1; i <= task.count; i++) {
          try {
            const q = await generateOneQuestionQuality(context, task.topic, task.level, task.language, i); // eslint-disable-line no-await-in-loop
            resultByLanguage[task.language].push(q);
          } catch { /* skip */ }
        }
      } else {
        const questions = await generateFast(task, context);
        for (const q of questions) resultByLanguage[task.language].push(q);
      }
    } catch (error) {
      errors.push({ task: { topic: task.topic, level: task.level, language: task.language }, message: error instanceof Error ? error.message : "Error" });
    }
  });

  const totalGenerated = Object.values(resultByLanguage).reduce((s, arr) => s + arr.length, 0);

  return res.status(200).json({
    status: errors.length > 0 && totalGenerated === 0 ? "failed" : errors.length > 0 ? "completed_with_errors" : "completed",
    metadata: {
      subject: context.subject, faculty: context.faculty, course: context.course,
      examType: context.examType, mode: context.mode, totalQuestions: totalGenerated
    },
    questionsByLanguage: resultByLanguage,
    errors
  });
}
