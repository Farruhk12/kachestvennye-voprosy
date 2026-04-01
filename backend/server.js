import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Env loader (no external deps)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "../public"
);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const LEVELS = ["easy", "medium", "hard"];
const LANGUAGES = ["RU", "TJ", "EN"];
const LEVEL_LABELS = {
  RU: { easy: "лёгкий", medium: "средний", hard: "сложный" },
  TJ: { easy: "осон", medium: "миёна", hard: "мураккаб" },
  EN: { easy: "easy", medium: "medium", hard: "hard" }
};
const LANG_NAMES = { RU: "русском языке", TJ: "таджикском языке (Тоҷикӣ)", EN: "English" };

// Job TTL: remove completed jobs older than 2 hours
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

const jobs = new Map();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(data);
}

async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8");
  try { return JSON.parse(raw); } catch { throw new Error("INVALID_JSON"); }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeStartPayload(payload) {
  const context = payload?.context ?? {};
  const subject = String(context.subject ?? "").trim();
  const faculty = String(context.faculty ?? "").trim();
  const examType = String(context.examType ?? "").trim();
  const modeRaw = String(context.mode ?? "fast").toLowerCase();
  const mode = modeRaw === "quality" ? "quality" : "fast";
  const VALID_QTYPES = ["knowledge", "understanding", "tasks"];
  const questionTypes = Array.isArray(context.questionTypes)
    ? [...new Set(context.questionTypes.map((x) => String(x).toLowerCase()))].filter((x) => VALID_QTYPES.includes(x))
    : ["knowledge", "understanding"];
  const course = clampInt(context.course, 1, 6, 1);

  const languages = Array.isArray(payload?.languages)
    ? [...new Set(payload.languages.map((x) => String(x).toUpperCase().trim()))].filter((x) => LANGUAGES.includes(x))
    : [];

  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  const normalizedTopics = topics.slice(0, 15).map((topic) => {
    const name = String(topic?.name ?? "").trim();
    const counts = topic?.counts ?? {};
    return {
      name,
      counts: {
        easy: clampInt(counts.easy, 0, 100, 20),
        medium: clampInt(counts.medium, 0, 100, 20),
        hard: clampInt(counts.hard, 0, 100, 20)
      }
    };
  }).filter((topic) => topic.name.length > 0);

  const totalQ = normalizedTopics.reduce((a, t) => a + t.counts.easy + t.counts.medium + t.counts.hard, 0);

  if (!subject) return { ok: false, message: "Поле «Предмет» обязательно." };
  if (!faculty) return { ok: false, message: "Поле «Факультет» обязательно." };
  if (!examType) return { ok: false, message: "Поле «Тип экзамена» обязательно." };
  if (languages.length === 0) return { ok: false, message: "Выберите минимум один язык генерации." };
  if (questionTypes.length === 0) return { ok: false, message: "Выберите минимум один тип заданий." };
  if (normalizedTopics.length === 0) return { ok: false, message: "Добавьте минимум одну тему." };
  if (totalQ <= 0) return { ok: false, message: "Укажите количество вопросов больше нуля." };

  return { ok: true, value: { context: { subject, faculty, examType, course, mode, questionTypes }, languages, topics: normalizedTopics } };
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runWithConcurrency(items, concurrency, handler) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        await handler(item); // eslint-disable-line no-await-in-loop
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------
async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Gemini API (Agent 1 — Generator)
// ---------------------------------------------------------------------------
function buildTypeInstruction(questionTypes) {
  const has = (t) => questionTypes.includes(t);
  const parts = [];
  if (has("knowledge")) parts.push(`- ЗНАНИЕ: прямые вопросы на воспроизведение фактов — определения, классификации, нормальные показатели, перечисления. Формат: «Что такое...», «Перечислите...», «Какова норма...», «Назовите классификацию...».`);
  if (has("understanding")) parts.push(`- ПОНИМАНИЕ: вопросы на объяснение механизмов и взаимосвязей — патогенез, причинно-следственные связи, сравнение, интерпретация. Формат: «Объясните механизм...», «Почему...», «Чем отличается... от ...», «Каков патогенез...».`);
  if (has("tasks")) parts.push(`- КЛИНИЧЕСКИЕ ЗАДАЧИ: описание конкретного пациента (возраст, пол, симптомы, анамнез, данные обследования) + чёткий вопрос требующий клинического решения. Формат: «У ребёнка X лет... Ваш диагноз?», «Пациент поступил с... Назначьте лечение.».`);

  const onlyTheory = has("knowledge") || has("understanding");
  const onlyTasks = has("tasks") && !onlyTheory;
  const mixed = has("tasks") && onlyTheory;

  let typeInstruction = `Ты составляешь задания следующих типов:\n${parts.join("\n")}`;
  if (onlyTasks) typeInstruction += `\n\nВАЖНО: составляй ТОЛЬКО клинические задачи с описанием пациента. Теоретические вопросы без случая недопустимы.`;
  else if (!mixed) typeInstruction += `\n\nВАЖНО: составляй ТОЛЬКО теоретические вопросы (знание/понимание). Клинические случаи с описанием пациента недопустимы.`;
  else typeInstruction += `\n\nЧередуй типы равномерно в рамках задания. Каждое задание должно явно принадлежать одному из выбранных типов.`;

  return typeInstruction;
}

function buildSystemPrompt(context) {
  const typeInstruction = buildTypeInstruction(context.questionTypes || ["knowledge", "understanding"]);

  return `Ты — эксперт в области «${context.subject}» и опытный преподаватель медицинского вуза.
Твоя задача — составлять экзаменационные задания для студентов ${context.course} курса ${context.faculty} факультета, тип экзамена: ${context.examType}.

${typeInstruction}

Общие правила:
- Задания соответствуют уровню обучения: курс и факультет учитываются.
- Язык профессиональный, соответствует медицинской терминологии предмета.
- Каждое задание самодостаточно и понятно без дополнительного контекста.
- Соответствие актуальным стандартам и протоколам.
- Задания не дублируют друг друга по содержанию и формулировке.
- Не включать подсказку к ответу в текст.
- Не использовать устаревшие классификации и стандарты.
- Не генерировать вымышленные препараты, болезни или показатели.
- Не выходить за рамки указанного предмета и темы.`;
}

function buildLevelDescription(level) {
  const desc = {
    easy: "Лёгкий уровень: типичный, классический, стандартный случай. Проверяет знание определений, классификаций, базовых механизмов, нормальных показателей, стандартных алгоритмов.",
    medium: "Средний уровень: нетипичная картина, сочетание факторов, необходимость выбора из нескольких близких вариантов. Проверяет умение анализировать, сравнивать, интерпретировать данные.",
    hard: "Сложный уровень: редкий вариант, конфликт данных, критическая ситуация, необходимость принятия решения в условиях неопределённости. Проверяет клиническое мышление, синтез знаний."
  };
  return desc[level];
}

async function callGemini(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не настроен");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
  });

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }, 55000);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini вернул пустой ответ");
  return text;
}

// ---------------------------------------------------------------------------
// Gemini with low temperature — used for Critic and Editor roles
// ---------------------------------------------------------------------------
async function callGeminiLowTemp(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не настроен");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
  });

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }, 30000);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini вернул пустой ответ");
  return text;
}

// ---------------------------------------------------------------------------
// fetch with timeout (Node 18+ has native fetch)
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Parse numbered list from AI response
// ---------------------------------------------------------------------------
function parseNumberedList(text) {
  const lines = text.split("\n");
  const questions = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "1.", "1)", "1 ." at start of line
    const match = trimmed.match(/^\d+[\.\)]\s+(.+)/);
    if (match) {
      questions.push(match[1].trim());
    }
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Type hint builders for prompts
function buildFastTypeHint(questionTypes, count) {
  const has = (t) => questionTypes.includes(t);
  const onlyKnowledge = has("knowledge") && !has("understanding") && !has("tasks");
  const onlyUnderstanding = has("understanding") && !has("knowledge") && !has("tasks");
  const onlyTasks = has("tasks") && !has("knowledge") && !has("understanding");

  if (onlyTasks) return `Каждый из ${count} элементов — отдельная КЛИНИЧЕСКАЯ ЗАДАЧА: описание пациента (возраст, пол, симптомы/анамнез/данные) + вопрос требующий решения. Без теоретических вопросов.`;
  if (onlyKnowledge) return `Каждый из ${count} элементов — ВОПРОС НА ЗНАНИЕ: определение, классификация, норма, перечисление. Без клинических случаев.`;
  if (onlyUnderstanding) return `Каждый из ${count} элементов — ВОПРОС НА ПОНИМАНИЕ: объяснение механизма, патогенеза, причины, сравнение. Без клинических случаев.`;

  // Mixed — distribute evenly
  const labels = [];
  if (has("knowledge")) labels.push("ЗНАНИЕ (определения, классификации, нормы)");
  if (has("understanding")) labels.push("ПОНИМАНИЕ (механизмы, патогенез, сравнения)");
  if (has("tasks")) labels.push("КЛИНИЧЕСКАЯ ЗАДАЧА (случай с пациентом + вопрос)");
  return `Распредели ${count} заданий равномерно по типам: ${labels.join(", ")}. Каждое задание явно принадлежит одному типу.`;
}

function buildQualityTypeHint(questionTypes, index, total) {
  const has = (t) => questionTypes.includes(t);
  const onlyTasks = has("tasks") && !has("knowledge") && !has("understanding");
  const onlyTheory = !has("tasks");

  if (onlyTasks) return `Это КЛИНИЧЕСКАЯ ЗАДАЧА: опиши конкретного пациента (возраст, пол, симптомы, анамнез или данные обследования) + поставь чёткий вопрос. Без теоретических вопросов.`;
  if (onlyTheory) {
    // Alternate knowledge/understanding if both selected
    if (has("knowledge") && has("understanding")) {
      return index % 2 === 1
        ? `Это ВОПРОС НА ЗНАНИЕ: спроси о конкретном факте, определении, классификации или норме. Без клинических случаев.`
        : `Это ВОПРОС НА ПОНИМАНИЕ: спроси об объяснении механизма, патогенеза, причинно-следственной связи или сравнении. Без клинических случаев.`;
    }
    if (has("knowledge")) return `Это ВОПРОС НА ЗНАНИЕ: спроси о факте, определении, классификации или норме. Без клинических случаев.`;
    return `Это ВОПРОС НА ПОНИМАНИЕ: спроси об объяснении механизма, патогенеза или сравнении. Без клинических случаев.`;
  }
  // Mixed: cycle through types
  const types = [];
  if (has("knowledge")) types.push("knowledge");
  if (has("understanding")) types.push("understanding");
  if (has("tasks")) types.push("tasks");
  const pick = types[(index - 1) % types.length];
  if (pick === "tasks") return `Это КЛИНИЧЕСКАЯ ЗАДАЧА: опиши конкретного пациента (возраст, пол, симптомы) + вопрос требующий клинического решения.`;
  if (pick === "knowledge") return `Это ВОПРОС НА ЗНАНИЕ: спроси о факте, определении, классификации или норме. Без клинических случаев.`;
  return `Это ВОПРОС НА ПОНИМАНИЕ: спроси об объяснении механизма, патогенеза или сравнении. Без клинических случаев.`;
}

// ---------------------------------------------------------------------------
// Fast mode: single Gemini call for a batch of questions
// ---------------------------------------------------------------------------
async function generateFast(task, context) {
  const systemPrompt = buildSystemPrompt(context);
  const levelDesc = buildLevelDescription(task.level);
  const langName = LANG_NAMES[task.language] || task.language;
  const typeHint = buildFastTypeHint(context.questionTypes || ["knowledge", "understanding"], task.count);

  const userPrompt = `Тема: ${task.topic}
Уровень сложности: ${LEVEL_LABELS.RU[task.level]} — ${levelDesc}
Количество заданий: ${task.count}
Язык: сформулируй все задания на ${langName}.
${typeHint}
Формат: только нумерованный список (1. 2. 3. ...). Без заголовков, пояснений и ответов.`;

  const text = await withRetry(() => callGemini(systemPrompt, userPrompt));
  const questions = parseNumberedList(text);
  // If parsing got nothing (model returned prose), split by lines as fallback
  if (questions.length === 0) {
    return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, task.count);
  }
  return questions.slice(0, task.count);
}

// ---------------------------------------------------------------------------
// Quality mode: per-question chain Generator → Critic → Editor (all Gemini)
// ---------------------------------------------------------------------------
async function generateOneQuestionQuality(context, topic, level, language, index) {
  const systemPrompt = buildSystemPrompt(context);
  const levelDesc = buildLevelDescription(level);
  const langName = LANG_NAMES[language] || language;

  const typeHintGen = buildQualityTypeHint(context.questionTypes || ["knowledge", "understanding"], index, 1);

  // Agent 1: Generator — Gemini, temperature 0.7 (creative)
  const genPrompt = `Тема: ${topic}
Уровень сложности: ${LEVEL_LABELS.RU[level]} — ${levelDesc}
Составь ровно 1 задание (№${index}).
${typeHintGen}
Язык: ${langName}.
Формат: только текст задания без нумерации, заголовков и ответов.`;

  const draft = await withRetry(() => callGemini(systemPrompt, genPrompt));

  // Agent 2: Critic — Gemini, temperature 0.2 (analytical)
  const typeCheckCritic = `8. Тип задания соответствует выбранному: ${typeHintGen.split(":")[0]}.`;

  const criticSystem = `Ты — строгий критик экзаменационных заданий для медицинского вуза.
Проверь задание по чеклисту и выдай краткий список замечаний (если есть) или напиши ровно одно слово "ОДОБРЕНО".
Чеклист:
1. Медицинская корректность — нет фактических ошибок, устаревших данных, вымышленных препаратов или диагнозов.
2. Соответствие уровню сложности (${LEVEL_LABELS.RU[level]}) согласно критериям.
3. Соответствие курсу (${context.course}) и факультету (${context.faculty}).
4. Отсутствие подсказки — текст не намекает на правильный ответ.
5. Однозначность — есть чёткий единственно правильный ответ.
6. Самодостаточность — задание понятно без дополнительного контекста.
7. Актуальность — опирается на современные клинические протоколы.
${typeCheckCritic}
Отвечай кратко. Если замечаний нет — только слово "ОДОБРЕНО".`;

  const criticUser = `Предмет: ${context.subject}. Тема: ${topic}.
Задание: ${draft}`;

  const criticism = await withRetry(() => callGeminiLowTemp(criticSystem, criticUser));

  // If approved — skip editor
  if (criticism.trim().toUpperCase().startsWith("ОДОБРЕНО")) {
    return draft.trim();
  }

  // Agent 3: Editor — Gemini, temperature 0.2 (precise)
  const typeHintEditor = typeHintGen;

  const editorSystem = `Ты — редактор экзаменационных заданий для медицинского вуза.
Получаешь черновик задания и замечания критика. Исправь задание так, чтобы устранить все замечания.
${typeHintEditor}
Верни только исправленный текст задания — без комментариев, нумерации и пояснений.`;

  const editorUser = `Предмет: ${context.subject}. Тема: ${topic}. Уровень: ${LEVEL_LABELS.RU[level]}.
Язык: ${langName}.

Черновик задания:
${draft}

Замечания критика:
${criticism}

Верни только исправленный текст задания.`;

  const edited = await withRetry(() => callGeminiLowTemp(editorSystem, editorUser));
  return (edited || draft).trim();
}

async function generateQuality(task, context, onQuestion) {
  const questions = [];
  for (let i = 1; i <= task.count; i++) {
    try {
      const q = await generateOneQuestionQuality(context, task.topic, task.level, task.language, i); // eslint-disable-line no-await-in-loop
      questions.push(q);
      onQuestion(q);
    } catch {
      // On persistent failure, skip this question
    }
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Job creation & processing
// ---------------------------------------------------------------------------
function createJob(normalizedPayload) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const totalQuestions = normalizedPayload.topics.reduce((sum, topic) => {
    const perLanguage = topic.counts.easy + topic.counts.medium + topic.counts.hard;
    return sum + perLanguage * normalizedPayload.languages.length;
  }, 0);

  const byTopic = {};
  for (const topic of normalizedPayload.topics) {
    const topicTotal = (topic.counts.easy + topic.counts.medium + topic.counts.hard) * normalizedPayload.languages.length;
    byTopic[topic.name] = { totalQuestions: topicTotal, generatedQuestions: 0 };
  }

  const tasks = [];
  for (const topic of normalizedPayload.topics) {
    for (const level of LEVELS) {
      for (const language of normalizedPayload.languages) {
        const count = topic.counts[level];
        if (count <= 0) continue;
        tasks.push({ topic: topic.name, level, language, count });
      }
    }
  }

  const job = {
    id,
    createdAt,
    updatedAt: createdAt,
    status: "running",
    cancelled: false,
    context: normalizedPayload.context,
    mode: normalizedPayload.context.mode,
    topics: normalizedPayload.topics,
    languages: normalizedPayload.languages,
    resultByLanguage: Object.fromEntries(normalizedPayload.languages.map((lang) => [lang, []])),
    errors: [],
    progress: {
      totalTasks: tasks.length,
      completedTasks: 0,
      failedTasks: 0,
      totalQuestions,
      generatedQuestions: 0,
      byTopic
    }
  };

  jobs.set(id, job);

  processJob(job, tasks).catch((error) => {
    job.status = "failed";
    job.errors.push({ message: error instanceof Error ? error.message : "Unknown job processing error" });
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

async function processJob(job, tasks) {
  const mode = job.mode;
  // Quality mode: sequential per question (3 API calls each), lower concurrency
  const concurrency = mode === "quality" ? 2 : 5;

  await runWithConcurrency(tasks, concurrency, async (task) => {
    if (job.cancelled) return;

    try {
      if (mode === "quality") {
        await generateQuality(task, job.context, (question) => {
          if (job.cancelled) return;
          job.resultByLanguage[task.language].push(question);
          job.progress.generatedQuestions += 1;
          job.progress.byTopic[task.topic].generatedQuestions += 1;
          job.updatedAt = new Date().toISOString();
        });
      } else {
        const questions = await generateFast(task, job.context);
        if (!job.cancelled) {
          for (const question of questions) {
            job.resultByLanguage[task.language].push(question);
            job.progress.generatedQuestions += 1;
            job.progress.byTopic[task.topic].generatedQuestions += 1;
          }
        }
      }

      if (job.cancelled) return;
      job.progress.completedTasks += 1;
    } catch (error) {
      job.progress.failedTasks += 1;
      job.errors.push({
        task: { topic: task.topic, level: task.level, language: task.language },
        message: error instanceof Error ? error.message : "Unknown task error"
      });
    }

    job.updatedAt = new Date().toISOString();
  });

  if (job.cancelled) {
    job.status = "cancelled";
  } else if (job.progress.failedTasks > 0 && job.progress.completedTasks === 0) {
    job.status = "failed";
  } else if (job.progress.failedTasks > 0) {
    job.status = "completed_with_errors";
  } else {
    job.status = "completed";
  }
  job.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Job status/result payloads
// ---------------------------------------------------------------------------
function jobStatusPayload(job) {
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: {
      ...job.progress,
      byTopic: Object.entries(job.progress.byTopic).map(([topic, value]) => ({ topic, ...value }))
    },
    errors: job.errors
  };
}

function jobResultPayload(job) {
  return {
    jobId: job.id,
    status: job.status,
    metadata: {
      subject: job.context.subject,
      faculty: job.context.faculty,
      course: job.context.course,
      examType: job.context.examType,
      mode: job.mode,
      totalQuestions: job.progress.generatedQuestions
    },
    questionsByLanguage: job.resultByLanguage
  };
}

// ---------------------------------------------------------------------------
// docx export (pure JS, no dependencies)
// Generates a minimal valid .docx (ZIP with OOXML)
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDocxXml(job, language) {
  const questions = job.resultByLanguage[language] || [];
  const today = new Date().toLocaleDateString("ru-RU");
  const title = `Экзаменационные вопросы — ${job.context.subject} — ${job.context.faculty}, ${job.context.course} курс`;
  const subtitle = `Дата: ${today} | Вопросов: ${questions.length} | Язык: ${language} | Режим: ${job.mode === "quality" ? "Качественный" : "Быстрый"}`;

  const paragraphXml = (text, style = "Normal", bold = false) => {
    const runProps = bold ? "<w:rPr><w:b/></w:rPr>" : "";
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  };

  const questionParagraphs = questions.map((q, i) =>
    `<w:p>
      <w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:left="0"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(`${i + 1}. ${q}`)}</w:t>
      </w:r>
    </w:p>`
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>
      <w:r><w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="32"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(title)}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="400"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:color w:val="555555"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(subtitle)}</w:t>
      </w:r>
    </w:p>
    ${questionParagraphs}
    <w:sectPr>
      <w:pgMar w:top="1134" w:right="851" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// Minimal ZIP builder (store method, no compression — sufficient for docx)
function buildDocx(job, language) {
  const documentXml = buildDocxXml(job, language);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsMain = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(relsMain, "utf-8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(wordRels, "utf-8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf-8") }
  ];

  return buildZip(files);
}

function buildZip(files) {
  const parts = [];

  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf-8");
    const data = file.data;
    const crc = crc32(data);
    const modTime = dosTime(new Date());

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0x0800, 6);      // flags: UTF-8
    localHeader.writeUInt16LE(0, 8);           // compression: store
    localHeader.writeUInt16LE(modTime.time, 10);
    localHeader.writeUInt16LE(modTime.date, 12);
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    parts.push(localHeader, data);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);      // signature
    cdEntry.writeUInt16LE(20, 4);              // version made by
    cdEntry.writeUInt16LE(20, 6);              // version needed
    cdEntry.writeUInt16LE(0x0800, 8);          // flags: UTF-8
    cdEntry.writeUInt16LE(0, 10);              // compression: store
    cdEntry.writeUInt16LE(modTime.time, 12);
    cdEntry.writeUInt16LE(modTime.date, 14);
    cdEntry.writeUInt32LE(crc >>> 0, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30);              // extra length
    cdEntry.writeUInt16LE(0, 32);              // comment length
    cdEntry.writeUInt16LE(0, 34);              // disk start
    cdEntry.writeUInt16LE(0, 36);              // int attributes
    cdEntry.writeUInt32LE(0, 38);              // ext attributes
    cdEntry.writeUInt32LE(offset, 42);
    nameBytes.copy(cdEntry, 46);

    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const cdBuffer = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuffer, eocd]);
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = ((date.getFullYear() - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safeRelative = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const absolutePath = path.join(PUBLIC_DIR, safeRelative);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(absolutePath);
    if (stat.isDirectory()) {
      const content = await fsp.readFile(path.join(absolutePath, "index.html"));
      sendText(res, 200, content, "text/html; charset=utf-8");
      return;
    }
  } catch { /* fall through to 404 */ }

  if (!fs.existsSync(absolutePath)) {
    sendText(res, 404, "Not found");
    return;
  }

  const content = await fsp.readFile(absolutePath);
  sendText(res, 200, content, getMimeType(absolutePath));
}

// ---------------------------------------------------------------------------
// Job TTL cleanup — runs every 30 minutes
// ---------------------------------------------------------------------------
function scheduleJobCleanup() {
  setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      const terminal = ["completed", "completed_with_errors", "cancelled", "failed"].includes(job.status);
      if (terminal && new Date(job.updatedAt).getTime() < cutoff) {
        jobs.delete(id);
      }
    }
  }, 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// HTTP request handler (shared by local server and Vercel export)
// ---------------------------------------------------------------------------
async function handler(req, res) {
  try {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = reqUrl;
    const method = req.method || "GET";

    // POST /api/generate/start
    if (method === "POST" && pathname === "/api/generate/start") {
      const payload = await readJsonBody(req);
      const normalized = normalizeStartPayload(payload);
      if (!normalized.ok) {
        sendJson(res, 400, { error: normalized.message });
        return;
      }
      const job = createJob(normalized.value);
      sendJson(res, 202, { jobId: job.id, status: job.status, progress: job.progress });
      return;
    }

    // GET /api/generate/:id/status
    if (method === "GET" && /^\/api\/generate\/[^/]+\/status$/.test(pathname)) {
      const jobId = pathname.split("/")[3];
      const job = jobs.get(jobId);
      if (!job) { sendJson(res, 404, { error: "Job not found" }); return; }
      sendJson(res, 200, jobStatusPayload(job));
      return;
    }

    // POST /api/generate/:id/cancel
    if (method === "POST" && /^\/api\/generate\/[^/]+\/cancel$/.test(pathname)) {
      const jobId = pathname.split("/")[3];
      const job = jobs.get(jobId);
      if (!job) { sendJson(res, 404, { error: "Job not found" }); return; }
      if (job.status === "running") {
        job.cancelled = true;
        job.status = "cancelling";
        job.updatedAt = new Date().toISOString();
      }
      sendJson(res, 200, { jobId: job.id, status: job.status });
      return;
    }

    // GET /api/generate/:id/result
    if (method === "GET" && /^\/api\/generate\/[^/]+\/result$/.test(pathname)) {
      const jobId = pathname.split("/")[3];
      const job = jobs.get(jobId);
      if (!job) { sendJson(res, 404, { error: "Job not found" }); return; }
      if (!["completed", "completed_with_errors", "cancelled"].includes(job.status)) {
        sendJson(res, 409, { error: "Result is not ready yet", status: job.status });
        return;
      }
      sendJson(res, 200, jobResultPayload(job));
      return;
    }

    // POST /api/export/docx
    if (method === "POST" && pathname === "/api/export/docx") {
      const payload = await readJsonBody(req);
      const jobId = String(payload?.jobId || "");
      const language = String(payload?.language || "RU").toUpperCase();

      if (!jobId) {
        sendJson(res, 400, { error: "jobId обязателен." });
        return;
      }
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" });
        return;
      }
      if (!["completed", "completed_with_errors", "cancelled"].includes(job.status)) {
        sendJson(res, 409, { error: "Job is not completed yet" });
        return;
      }
      if (!job.languages.includes(language)) {
        sendJson(res, 400, { error: `Язык ${language} недоступен для этого задания.` });
        return;
      }

      const docxBuffer = buildDocx(job, language);
      const dateStr = new Date().toLocaleDateString("ru-RU").replace(/\./g, ".");
      const safeName = [job.context.subject, job.context.faculty, `${job.context.course}курс`, dateStr]
        .map((s) => String(s).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-\.]/g, "_"))
        .join("_");
      const filename = `${safeName}_${language}.docx`;

      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(docxBuffer.length),
        "Cache-Control": "no-store"
      });
      res.end(docxBuffer);
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API route not found" });
      return;
    }

    await serveStatic(pathname, res);
  } catch (error) {
    if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { error: "Payload too large" });
      return;
    }
    if (error instanceof Error && error.message === "INVALID_JSON") {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
}

scheduleJobCleanup();

// Vercel serverless export — must be a plain function, not http.Server
export default handler;

// Local dev
if (process.env.VERCEL !== "1") {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`); // eslint-disable-line no-console
    if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set"); // eslint-disable-line no-console
  });
}
