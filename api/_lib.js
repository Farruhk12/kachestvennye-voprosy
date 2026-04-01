// Shared business logic for all Vercel serverless handlers

export const LEVELS = ["easy", "medium", "hard"];
export const LANGUAGES = ["RU", "TJ", "EN"];
export const LEVEL_LABELS = {
  RU: { easy: "лёгкий", medium: "средний", hard: "сложный" },
  TJ: { easy: "осон", medium: "миёна", hard: "мураккаб" },
  EN: { easy: "easy", medium: "medium", hard: "hard" }
};
export const LANG_NAMES = { RU: "русском языке", TJ: "таджикском языке (Тоҷикӣ)", EN: "English" };

// In-memory job store (shared across handlers in same serverless instance)
export const jobs = new Map();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeStartPayload(payload) {
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
  }).filter((t) => t.name.length > 0);

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
// Helpers
// ---------------------------------------------------------------------------
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function runWithConcurrency(items, concurrency, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        await fn(item); // eslint-disable-line no-await-in-loop
      }
    })
  );
}

export async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Gemini API
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

async function callGeminiRaw(systemPrompt, userPrompt, temperature, maxTokens, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY не настроен");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    })
  }, timeoutMs);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini вернул пустой ответ");
  return text;
}

export const callGemini = (sys, usr) => callGeminiRaw(sys, usr, 0.7, 8192, 55000);
export const callGeminiLowTemp = (sys, usr) => callGeminiRaw(sys, usr, 0.2, 1024, 30000);

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
export function buildTypeInstruction(questionTypes) {
  const has = (t) => questionTypes.includes(t);
  const parts = [];
  if (has("knowledge")) parts.push(`- ЗНАНИЕ: прямые вопросы на воспроизведение фактов — определения, классификации, нормальные показатели, перечисления.`);
  if (has("understanding")) parts.push(`- ПОНИМАНИЕ: вопросы на объяснение механизмов и взаимосвязей — патогенез, причинно-следственные связи, сравнение, интерпретация.`);
  if (has("tasks")) parts.push(`- КЛИНИЧЕСКИЕ ЗАДАЧИ: описание конкретного пациента (возраст, пол, симптомы, анамнез) + чёткий вопрос требующий клинического решения.`);

  const onlyTheory = has("knowledge") || has("understanding");
  const onlyTasks = has("tasks") && !onlyTheory;
  const mixed = has("tasks") && onlyTheory;

  let r = `Ты составляешь задания следующих типов:\n${parts.join("\n")}`;
  if (onlyTasks) r += `\n\nВАЖНО: составляй ТОЛЬКО клинические задачи с описанием пациента.`;
  else if (!mixed) r += `\n\nВАЖНО: составляй ТОЛЬКО теоретические вопросы (знание/понимание). Клинические случаи недопустимы.`;
  else r += `\n\nЧередуй типы равномерно. Каждое задание должно явно принадлежать одному типу.`;
  return r;
}

export function buildSystemPrompt(context) {
  return `Ты — эксперт в области «${context.subject}» и опытный преподаватель медицинского вуза.
Твоя задача — составлять экзаменационные задания для студентов ${context.course} курса ${context.faculty} факультета, тип экзамена: ${context.examType}.

${buildTypeInstruction(context.questionTypes || ["knowledge", "understanding"])}

Общие правила:
- Задания соответствуют уровню обучения: курс и факультет учитываются.
- Язык профессиональный, соответствует медицинской терминологии предмета.
- Каждое задание самодостаточно и понятно без дополнительного контекста.
- Соответствие актуальным стандартам и протоколам.
- Задания не дублируют друг друга по содержанию и формулировке.
- Не включать подсказку к ответу в текст.
- Не использовать устаревшие классификации.
- Не генерировать вымышленные препараты, болезни или показатели.`;
}

export function buildLevelDescription(level) {
  return {
    easy: "Лёгкий уровень: типичный, классический случай. Проверяет знание определений, базовых механизмов, стандартных алгоритмов.",
    medium: "Средний уровень: нетипичная картина, выбор из нескольких близких вариантов. Проверяет умение анализировать и интерпретировать данные.",
    hard: "Сложный уровень: редкий вариант, конфликт данных, критическая ситуация. Проверяет клиническое мышление и синтез знаний."
  }[level];
}

export function buildFastTypeHint(questionTypes, count) {
  const has = (t) => questionTypes.includes(t);
  if (has("tasks") && !has("knowledge") && !has("understanding"))
    return `Каждый из ${count} элементов — отдельная КЛИНИЧЕСКАЯ ЗАДАЧА: описание пациента + вопрос требующий решения.`;
  if (has("knowledge") && !has("understanding") && !has("tasks"))
    return `Каждый из ${count} элементов — ВОПРОС НА ЗНАНИЕ: определение, классификация, норма. Без клинических случаев.`;
  if (has("understanding") && !has("knowledge") && !has("tasks"))
    return `Каждый из ${count} элементов — ВОПРОС НА ПОНИМАНИЕ: объяснение механизма, патогенеза. Без клинических случаев.`;
  const labels = [];
  if (has("knowledge")) labels.push("ЗНАНИЕ");
  if (has("understanding")) labels.push("ПОНИМАНИЕ");
  if (has("tasks")) labels.push("КЛИНИЧЕСКАЯ ЗАДАЧА");
  return `Распредели ${count} заданий равномерно по типам: ${labels.join(", ")}.`;
}

export function buildQualityTypeHint(questionTypes, index) {
  const has = (t) => questionTypes.includes(t);
  if (has("tasks") && !has("knowledge") && !has("understanding"))
    return `Это КЛИНИЧЕСКАЯ ЗАДАЧА: опиши конкретного пациента (возраст, пол, симптомы) + вопрос требующий клинического решения.`;
  if (!has("tasks")) {
    if (has("knowledge") && has("understanding"))
      return index % 2 === 1
        ? `Это ВОПРОС НА ЗНАНИЕ: спроси о факте, определении, классификации или норме. Без клинических случаев.`
        : `Это ВОПРОС НА ПОНИМАНИЕ: спроси об объяснении механизма, патогенеза. Без клинических случаев.`;
    if (has("knowledge")) return `Это ВОПРОС НА ЗНАНИЕ: факт, определение, классификация. Без клинических случаев.`;
    return `Это ВОПРОС НА ПОНИМАНИЕ: механизм, патогенез, сравнение. Без клинических случаев.`;
  }
  const types = [];
  if (has("knowledge")) types.push("knowledge");
  if (has("understanding")) types.push("understanding");
  if (has("tasks")) types.push("tasks");
  const pick = types[(index - 1) % types.length];
  if (pick === "tasks") return `Это КЛИНИЧЕСКАЯ ЗАДАЧА: пациент с симптомами + вопрос.`;
  if (pick === "knowledge") return `Это ВОПРОС НА ЗНАНИЕ: факт, определение, норма. Без клинических случаев.`;
  return `Это ВОПРОС НА ПОНИМАНИЕ: механизм, патогенез. Без клинических случаев.`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
export function parseNumberedList(text) {
  const questions = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^\d+[\.\)]\s+(.+)/);
    if (match) questions.push(match[1].trim());
  }
  return questions;
}

export async function generateFast(task, context) {
  const systemPrompt = buildSystemPrompt(context);
  const userPrompt = `Тема: ${task.topic}
Уровень сложности: ${LEVEL_LABELS.RU[task.level]} — ${buildLevelDescription(task.level)}
Количество заданий: ${task.count}
Язык: сформулируй все задания на ${LANG_NAMES[task.language] || task.language}.
${buildFastTypeHint(context.questionTypes || ["knowledge", "understanding"], task.count)}
Формат: только нумерованный список (1. 2. 3. ...). Без заголовков, пояснений и ответов.`;

  const text = await withRetry(() => callGemini(systemPrompt, userPrompt));
  const questions = parseNumberedList(text);
  return (questions.length > 0 ? questions : text.split("\n").map((l) => l.trim()).filter(Boolean)).slice(0, task.count);
}

export async function generateOneQuestionQuality(context, topic, level, language, index) {
  const systemPrompt = buildSystemPrompt(context);
  const typeHintGen = buildQualityTypeHint(context.questionTypes || ["knowledge", "understanding"], index);

  const draft = await withRetry(() => callGemini(systemPrompt,
    `Тема: ${topic}\nУровень: ${LEVEL_LABELS.RU[level]} — ${buildLevelDescription(level)}\nСоставь ровно 1 задание (№${index}).\n${typeHintGen}\nЯзык: ${LANG_NAMES[language] || language}.\nФормат: только текст задания без нумерации, заголовков и ответов.`
  ));

  const criticSystem = `Ты — строгий критик экзаменационных заданий для медицинского вуза.
Проверь задание по чеклисту и выдай краткий список замечаний (если есть) или напиши ровно одно слово "ОДОБРЕНО".
Чеклист:
1. Медицинская корректность — нет фактических ошибок, устаревших данных, вымышленных препаратов или диагнозов.
2. Соответствие уровню сложности (${LEVEL_LABELS.RU[level]}).
3. Соответствие курсу (${context.course}) и факультету (${context.faculty}).
4. Отсутствие подсказки в тексте.
5. Однозначность — чёткий единственно правильный ответ.
6. Самодостаточность — понятно без контекста.
7. Актуальность — современные протоколы.
8. Тип задания соответствует: ${typeHintGen.split(":")[0]}.
Отвечай кратко. Если замечаний нет — только "ОДОБРЕНО".`;

  const criticism = await withRetry(() => callGeminiLowTemp(criticSystem,
    `Предмет: ${context.subject}. Тема: ${topic}.\nЗадание: ${draft}`
  ));

  if (criticism.trim().toUpperCase().startsWith("ОДОБРЕНО")) return draft.trim();

  const edited = await withRetry(() => callGeminiLowTemp(
    `Ты — редактор экзаменационных заданий. Исправь задание по замечаниям критика.\n${typeHintGen}\nВерни только исправленный текст без комментариев.`,
    `Предмет: ${context.subject}. Тема: ${topic}. Уровень: ${LEVEL_LABELS.RU[level]}. Язык: ${LANG_NAMES[language] || language}.\n\nЧерновик:\n${draft}\n\nЗамечания:\n${criticism}\n\nВерни только исправленный текст.`
  ));
  return (edited || draft).trim();
}

export async function generateQuality(task, context, onQuestion) {
  for (let i = 1; i <= task.count; i++) {
    try {
      const q = await generateOneQuestionQuality(context, task.topic, task.level, task.language, i); // eslint-disable-line no-await-in-loop
      onQuestion(q);
    } catch { /* skip on persistent failure */ }
  }
}

// ---------------------------------------------------------------------------
// Job management
// ---------------------------------------------------------------------------
export function createJob(normalizedPayload) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const totalQuestions = normalizedPayload.topics.reduce((sum, topic) => {
    return sum + (topic.counts.easy + topic.counts.medium + topic.counts.hard) * normalizedPayload.languages.length;
  }, 0);

  const byTopic = {};
  for (const topic of normalizedPayload.topics) {
    byTopic[topic.name] = {
      totalQuestions: (topic.counts.easy + topic.counts.medium + topic.counts.hard) * normalizedPayload.languages.length,
      generatedQuestions: 0
    };
  }

  const tasks = [];
  for (const topic of normalizedPayload.topics) {
    for (const level of LEVELS) {
      for (const language of normalizedPayload.languages) {
        const count = topic.counts[level];
        if (count > 0) tasks.push({ topic: topic.name, level, language, count });
      }
    }
  }

  const job = {
    id, createdAt, updatedAt: createdAt,
    status: "running", cancelled: false,
    context: normalizedPayload.context,
    mode: normalizedPayload.context.mode,
    topics: normalizedPayload.topics,
    languages: normalizedPayload.languages,
    resultByLanguage: Object.fromEntries(normalizedPayload.languages.map((l) => [l, []])),
    errors: [],
    progress: { totalTasks: tasks.length, completedTasks: 0, failedTasks: 0, totalQuestions, generatedQuestions: 0, byTopic }
  };

  jobs.set(id, job);

  processJob(job, tasks).catch((error) => {
    job.status = "failed";
    job.errors.push({ message: error instanceof Error ? error.message : "Unknown error" });
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

async function processJob(job, tasks) {
  const concurrency = job.mode === "quality" ? 2 : 5;
  await runWithConcurrency(tasks, concurrency, async (task) => {
    if (job.cancelled) return;
    try {
      if (job.mode === "quality") {
        await generateQuality(task, job.context, (q) => {
          if (job.cancelled) return;
          job.resultByLanguage[task.language].push(q);
          job.progress.generatedQuestions += 1;
          job.progress.byTopic[task.topic].generatedQuestions += 1;
          job.updatedAt = new Date().toISOString();
        });
      } else {
        const questions = await generateFast(task, job.context);
        if (!job.cancelled) {
          for (const q of questions) {
            job.resultByLanguage[task.language].push(q);
            job.progress.generatedQuestions += 1;
            job.progress.byTopic[task.topic].generatedQuestions += 1;
          }
        }
      }
      if (!job.cancelled) job.progress.completedTasks += 1;
    } catch (error) {
      job.progress.failedTasks += 1;
      job.errors.push({ task: { topic: task.topic, level: task.level, language: task.language }, message: error instanceof Error ? error.message : "Unknown task error" });
    }
    job.updatedAt = new Date().toISOString();
  });

  job.status = job.cancelled ? "cancelled"
    : job.progress.failedTasks > 0 && job.progress.completedTasks === 0 ? "failed"
    : job.progress.failedTasks > 0 ? "completed_with_errors"
    : "completed";
  job.updatedAt = new Date().toISOString();
}

export function jobStatusPayload(job) {
  return {
    jobId: job.id, status: job.status, mode: job.mode,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    progress: { ...job.progress, byTopic: Object.entries(job.progress.byTopic).map(([topic, v]) => ({ topic, ...v })) },
    errors: job.errors
  };
}

export function jobResultPayload(job) {
  return {
    jobId: job.id, status: job.status,
    metadata: { subject: job.context.subject, faculty: job.context.faculty, course: job.context.course, examType: job.context.examType, mode: job.mode, totalQuestions: job.progress.generatedQuestions },
    questionsByLanguage: job.resultByLanguage
  };
}

// ---------------------------------------------------------------------------
// DOCX export
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

export function buildDocx(job, language) {
  const questions = job.resultByLanguage[language] || [];
  const today = new Date().toLocaleDateString("ru-RU");
  const title = `Экзаменационные вопросы — ${job.context.subject} — ${job.context.faculty}, ${job.context.course} курс`;
  const subtitle = `Дата: ${today} | Вопросов: ${questions.length} | Язык: ${language} | Режим: ${job.mode === "quality" ? "Качественный" : "Быстрый"}`;

  const qXml = questions.map((q, i) => `<w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${escapeXml(`${i + 1}. ${q}`)}</w:t></w:r></w:p>`).join("\n");

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="400"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:color w:val="555555"/></w:rPr><w:t xml:space="preserve">${escapeXml(subtitle)}</w:t></w:r></w:p>${qXml}<w:sectPr><w:pgMar w:top="1134" w:right="851" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relsMain = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(relsMain, "utf-8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(wordRels, "utf-8") },
    { name: "word/document.xml", data: Buffer.from(docXml, "utf-8") }
  ]);
}

function buildZip(files) {
  const parts = [], centralDir = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf-8");
    const data = file.data;
    const crc = crc32buf(data);
    const mod = dosTime(new Date());
    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0x0800,6); lh.writeUInt16LE(0,8);
    lh.writeUInt16LE(mod.time,10); lh.writeUInt16LE(mod.date,12); lh.writeUInt32LE(crc>>>0,14);
    lh.writeUInt32LE(data.length,18); lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(nameBytes.length,26); lh.writeUInt16LE(0,28);
    nameBytes.copy(lh,30); parts.push(lh, data);
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6); cd.writeUInt16LE(0x0800,8); cd.writeUInt16LE(0,10);
    cd.writeUInt16LE(mod.time,12); cd.writeUInt16LE(mod.date,14); cd.writeUInt32LE(crc>>>0,16);
    cd.writeUInt32LE(data.length,20); cd.writeUInt32LE(data.length,24); cd.writeUInt16LE(nameBytes.length,28);
    cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32); cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38); cd.writeUInt32LE(offset,42);
    nameBytes.copy(cd,46); centralDir.push(cd);
    offset += lh.length + data.length;
  }
  const cdb = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(files.length,8); eocd.writeUInt16LE(files.length,10);
  eocd.writeUInt32LE(cdb.length,12); eocd.writeUInt32LE(offset,16); eocd.writeUInt16LE(0,20);
  return Buffer.concat([...parts, cdb, eocd]);
}

function dosTime(date) {
  return {
    time: ((date.getHours()&0x1f)<<11)|((date.getMinutes()&0x3f)<<5)|((date.getSeconds()>>1)&0x1f),
    date: ((date.getFullYear()-1980)<<9)|(((date.getMonth()+1)&0x0f)<<5)|(date.getDate()&0x1f)
  };
}

function crc32buf(buf) {
  const table = crc32buf.t || (crc32buf.t = (() => {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[i]=c;}
    return t;
  })());
  let crc = 0xffffffff;
  for (let i=0;i<buf.length;i++) crc=table[(crc^buf[i])&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
