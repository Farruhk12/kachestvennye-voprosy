/**
 * POST /api/generate
 * Runs generation synchronously and returns all questions in one response.
 * Vercel max duration: 60s (hobby) / 300s (pro) — set in vercel.json
 */
import {
  normalizeStartPayload, LEVELS,
  generateFast, generateOneQuestionQuality,
  runWithConcurrency, isQuestionSemanticallyDuplicate
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

  // If singleTopicIndex is provided, process only that topic
  const singleTopicIndex = payload.singleTopicIndex;
  const topicsToProcess = (typeof singleTopicIndex === "number" && singleTopicIndex >= 0 && singleTopicIndex < topics.length)
    ? [topics[singleTopicIndex]]
    : topics;

  // Build task list
  const tasks = [];
  for (const topic of topicsToProcess) {
    for (const level of LEVELS) {
      for (const language of languages) {
        const count = topic.counts[level];
        if (count > 0) tasks.push({ topic: topic.name, level, language, count });
      }
    }
  }

  const resultByLanguage = Object.fromEntries(languages.map((l) => [l, []]));
  const errors = [];
  let duplicatesSkipped = 0;
  const concurrency = context.mode === "quality" ? 2 : 5;

  await runWithConcurrency(tasks, concurrency, async (task) => {
    try {
      if (context.mode === "quality") {
        let accepted = 0;
        let attempts = 0;
        const maxAttempts = task.count * 4;
        while (accepted < task.count && attempts < maxAttempts) {
          try {
            const banned = resultByLanguage[task.language].slice(-12);
            const q = await generateOneQuestionQuality(
              context,
              task.topic,
              task.level,
              task.language,
              attempts + 1,
              banned
            ); // eslint-disable-line no-await-in-loop
            if (isQuestionSemanticallyDuplicate(q, resultByLanguage[task.language])) {
              duplicatesSkipped += 1;
              attempts += 1;
              continue;
            }
            resultByLanguage[task.language].push(q);
            accepted += 1;
            attempts += 1;
          } catch {
            attempts += 1;
          }
        }
        if (accepted < task.count) {
          errors.push({
            task: { topic: task.topic, level: task.level, language: task.language },
            message: `Недостаточно уникальных вопросов: ${accepted}/${task.count}.`
          });
        }
      } else {
        let accepted = 0;
        let attempts = 0;
        while (accepted < task.count && attempts < 4) {
          const missing = task.count - accepted;
          const requestCount = Math.min(missing + 2, Math.max(missing, missing * 2));
          const questions = await generateFast({ ...task, count: requestCount }, context, resultByLanguage[task.language]);
          for (const q of questions) {
            if (isQuestionSemanticallyDuplicate(q, resultByLanguage[task.language])) {
              duplicatesSkipped += 1;
              continue;
            }
            resultByLanguage[task.language].push(q);
            accepted += 1;
            if (accepted >= task.count) break;
          }
          attempts += 1;
        }
        if (accepted < task.count) {
          errors.push({
            task: { topic: task.topic, level: task.level, language: task.language },
            message: `Недостаточно уникальных вопросов: ${accepted}/${task.count}.`
          });
        }
      }
    } catch (error) {
      errors.push({ task: { topic: task.topic, level: task.level, language: task.language }, message: error instanceof Error ? error.message : "Error" });
    }
  });

  const plannedTotal = topicsToProcess.reduce((sum, topic) => (
    sum + (topic.counts.easy + topic.counts.medium + topic.counts.hard) * languages.length
  ), 0);
  const totalGenerated = Object.values(resultByLanguage).reduce((s, arr) => s + arr.length, 0);

  return res.status(200).json({
    status: errors.length > 0 && totalGenerated === 0 ? "failed" : errors.length > 0 ? "completed_with_errors" : "completed",
    metadata: {
      subject: context.subject, faculty: context.faculty, course: context.course,
      examType: context.examType, mode: context.mode, questionLength: context.questionLength || "short",
      totalQuestions: totalGenerated, plannedQuestions: plannedTotal, duplicatesSkipped
    },
    questionsByLanguage: resultByLanguage,
    errors
  });
}
