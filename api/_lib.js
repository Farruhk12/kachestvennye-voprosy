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

const QUESTION_LENGTH_PROFILES = {
  short: { words: { RU: 16, TJ: 16, EN: 14 }, answerMinutes: "2-4" },
  standard: { words: { RU: 24, TJ: 24, EN: 20 }, answerMinutes: "4-6" },
  detailed: { words: { RU: 34, TJ: 34, EN: 30 }, answerMinutes: "6-8" }
};

function normalizeQuestionLength(value) {
  const mode = String(value || "short").toLowerCase();
  return Object.prototype.hasOwnProperty.call(QUESTION_LENGTH_PROFILES, mode) ? mode : "short";
}

function getWordLimit(language, questionLength) {
  const profile = QUESTION_LENGTH_PROFILES[normalizeQuestionLength(questionLength)];
  const lang = String(language || "RU").toUpperCase();
  return profile.words[lang] || profile.words.RU;
}

function getAnswerMinutes(questionLength) {
  return QUESTION_LENGTH_PROFILES[normalizeQuestionLength(questionLength)].answerMinutes;
}

function sanitizeQuestionText(question) {
  return String(question || "")
    .replace(/^\s*\d+[\.\)]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[;:]\s*/g, ", ")
    .trim();
}

function enforceQuestionBrevity(question, language, questionLength) {
  let clean = sanitizeQuestionText(question);
  if (!clean) return "";

  const firstSentence = clean.match(/^(.+?[.?!])(?:\s|$)/);
  if (firstSentence) clean = firstSentence[1].trim();

  const maxWords = getWordLimit(language, questionLength);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    clean = `${words.slice(0, maxWords).join(" ").replace(/[.,!?]+$/g, "").trim()}?`;
  }

  if (!/[.?!]$/.test(clean)) clean += "?";
  return clean;
}

function buildBrevityHint(language, questionLength) {
  const maxWords = getWordLimit(language, questionLength);
  const answerMinutes = getAnswerMinutes(questionLength);
  return [
    `Strict brevity: one sentence only, up to ${maxWords} words.`,
    `Keep it answerable in ${answerMinutes} minutes in oral exam.`,
    "Do not use multi-part wording such as 'list, characterize, compare and justify' in one item.",
    "For mini clinical cases: use only age + 1-2 key symptoms, no long narrative."
  ].join("\n");
}

const DUPLICATE_STOPWORDS = new Set([
  "и", "или", "в", "во", "на", "по", "к", "ко", "с", "со", "у", "о", "об", "от", "до", "из", "за", "для", "при",
  "как", "что", "какой", "какая", "какие", "каково", "какова", "каковы", "чем", "почему", "когда",
  "назовите", "перечислите", "укажите", "опишите", "объясните", "охарактеризуйте", "представьте",
  "основные", "критерии", "классификацию", "классификация", "дифференциальной", "диагностики",
  "имеющих", "имеющие", "имеющим", "значение", "клинические", "задачи", "задача", "детей", "ребенка", "ребенка",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "from", "at",
  "what", "which", "why", "how", "list", "describe", "explain", "name", "define"
]);

function normalizeQuestionForComparison(question) {
  return sanitizeQuestionText(question)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuestionForComparison(question) {
  return normalizeQuestionForComparison(question)
    .split(" ")
    .filter((token) => token.length >= 3 && !DUPLICATE_STOPWORDS.has(token));
}

function buildTrigramSet(text) {
  const normalized = normalizeQuestionForComparison(text).replace(/\s+/g, "");
  const set = new Set();
  if (normalized.length < 3) return set;
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

function trigramDiceCoefficient(a, b) {
  const aSet = buildTrigramSet(a);
  const bSet = buildTrigramSet(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  return (2 * intersection) / (aSet.size + bSet.size);
}

function areQuestionsSemanticallyDuplicate(a, b) {
  const normA = normalizeQuestionForComparison(a);
  const normB = normalizeQuestionForComparison(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.length > 20 && normB.length > 20 && (normA.includes(normB) || normB.includes(normA))) {
    return true;
  }

  const tokensA = new Set(tokenizeQuestionForComparison(normA));
  const tokensB = new Set(tokenizeQuestionForComparison(normB));
  if (tokensA.size > 0 && tokensB.size > 0) {
    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection += 1;
    }
    const minSize = Math.min(tokensA.size, tokensB.size);
    const unionSize = tokensA.size + tokensB.size - intersection;
    const overlap = minSize > 0 ? intersection / minSize : 0;
    const jaccard = unionSize > 0 ? intersection / unionSize : 0;
    if ((intersection >= 3 && overlap >= 0.8) || jaccard >= 0.68) {
      return true;
    }
  }

  return trigramDiceCoefficient(normA, normB) >= 0.86;
}

export function isQuestionSemanticallyDuplicate(question, existingQuestions) {
  if (!question || !Array.isArray(existingQuestions) || existingQuestions.length === 0) return false;
  return existingQuestions.some((existing) => areQuestionsSemanticallyDuplicate(question, existing));
}

function buildDuplicateAvoidanceHint(bannedQuestions) {
  if (!Array.isArray(bannedQuestions) || bannedQuestions.length === 0) return "";
  const lastItems = bannedQuestions.slice(-12).map((q, i) => `${i + 1}. ${sanitizeQuestionText(q)}`);
  return [
    "STRICT NO-DUPLICATES: each new question must be semantically different from the examples below.",
    "Change clinical focus/mechanism/criterion, not just word order.",
    ...lastItems
  ].join("\n");
}

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
  const questionLength = normalizeQuestionLength(context.questionLength);
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

  return {
    ok: true,
    value: { context: { subject, faculty, examType, course, mode, questionTypes, questionLength }, languages, topics: normalizedTopics }
  };
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

function buildClinicalFocusRule(subject) {
  const s = String(subject || "").toLowerCase();
  // Subjects that are primarily theoretical/basic science — no clinical slant needed
  const basicScience = ["анатомия", "гистология", "биохимия", "физиология", "биология", "химия", "физика", "латинский", "микробиология", "иммунология", "генетика", "патологическая анатомия", "патанатомия", "патологическая физиология", "патфизиология"];
  const isBasic = basicScience.some((kw) => s.includes(kw));
  if (isBasic) return "";
  return `Акцент на клиническое мышление:
- Большинство заданий (не менее 60%) должны проверять ПРАКТИЧЕСКОЕ применение знаний: диагностику, тактику ведения, выбор лечения, интерпретацию симптомов.
- Избегать заданий, сводящихся исключительно к перечислению лабораторных или инструментальных показателей в отрыве от клинической ситуации.
- Лабораторные и инструментальные данные допустимы только как часть клинического контекста (например, «У пациента такие-то показатели — ваша тактика?»), а не как самоцель.
- Вопросы типа «Назовите нормы анализа крови» или «Перечислите показатели ЭКГ» — недопустимы без клинической привязки.`;
}

export function buildSystemPrompt(context) {
  const clinicalFocus = buildClinicalFocusRule(context.subject);
  return `Ты — эксперт в области «${context.subject}» и опытный преподаватель медицинского вуза.
Твоя задача — составлять экзаменационные задания для студентов ${context.course} курса ${context.faculty} факультета, тип экзамена: ${context.examType}.

${buildTypeInstruction(context.questionTypes || ["knowledge", "understanding"])}
${clinicalFocus ? `\n${clinicalFocus}` : ""}
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
  if (has("tasks") && !has("knowledge") && !has("understanding")) {
    return `All ${count} items must be MINI clinical cases: age + 1-2 key symptoms, then one direct question. No long narratives or long lab panels.`;
  }
  if (has("knowledge") && !has("understanding") && !has("tasks")) {
    return `All ${count} items must be direct recall questions (definition, criterion, normal value, indication).`;
  }
  if (has("understanding") && !has("knowledge") && !has("tasks")) {
    return `All ${count} items must test mechanism/interpretation in one direct sentence.`;
  }

  const labels = [];
  if (has("knowledge")) labels.push("knowledge");
  if (has("understanding")) labels.push("understanding");
  if (has("tasks")) labels.push("mini clinical case");
  return `Distribute ${count} items evenly across selected types: ${labels.join(", ")}.`;
}
export function buildQualityTypeHint(questionTypes, index) {
  const has = (t) => questionTypes.includes(t);
  if (has("tasks") && !has("knowledge") && !has("understanding")) {
    return "This is a MINI clinical case: age + 1-2 key symptoms, then one direct question.";
  }

  if (!has("tasks")) {
    if (has("knowledge") && has("understanding")) {
      return index % 2 === 1
        ? "This is a direct knowledge question: one fact, definition, criterion, or normal value."
        : "This is a direct understanding question: one mechanism or one interpretation point.";
    }
    if (has("knowledge")) return "This is a direct knowledge question: one fact, definition, criterion, or normal value.";
    return "This is a direct understanding question: one mechanism or one interpretation point.";
  }

  const types = [];
  if (has("knowledge")) types.push("knowledge");
  if (has("understanding")) types.push("understanding");
  if (has("tasks")) types.push("mini clinical case");
  const pick = types[(index - 1) % types.length];
  if (pick === "mini clinical case") return "This is a MINI clinical case: age + 1-2 key symptoms, then one direct question.";
  if (pick === "knowledge") return "This is a direct knowledge question: one fact, definition, criterion, or normal value.";
  return "This is a direct understanding question: one mechanism or one interpretation point.";
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

export async function generateFast(task, context, bannedQuestions = []) {
  const systemPrompt = buildSystemPrompt(context);
  const duplicateHint = buildDuplicateAvoidanceHint(bannedQuestions);
  const userPrompt = `Ð¢ÐµÐ¼Ð°: ${task.topic}
Ð£Ñ€Ð¾Ð²ÐµÐ½ÑŒ ÑÐ»Ð¾Ð¶Ð½Ð¾ÑÑ‚Ð¸: ${LEVEL_LABELS.RU[task.level]} â€” ${buildLevelDescription(task.level)}
ÐšÐ¾Ð»Ð¸Ñ‡ÐµÑÑ‚Ð²Ð¾ Ð·Ð°Ð´Ð°Ð½Ð¸Ð¹: ${task.count}
Ð¯Ð·Ñ‹Ðº: ÑÑ„Ð¾Ñ€Ð¼ÑƒÐ»Ð¸Ñ€ÑƒÐ¹ Ð²ÑÐµ Ð·Ð°Ð´Ð°Ð½Ð¸Ñ Ð½Ð° ${LANG_NAMES[task.language] || task.language}.
${buildFastTypeHint(context.questionTypes || ["knowledge", "understanding"], task.count)}
${buildBrevityHint(task.language, context.questionLength)}
${duplicateHint}
Ð¤Ð¾Ñ€Ð¼Ð°Ñ‚: Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð½ÑƒÐ¼ÐµÑ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ð¹ ÑÐ¿Ð¸ÑÐ¾Ðº (1. 2. 3. ...). Ð‘ÐµÐ· Ð·Ð°Ð³Ð¾Ð»Ð¾Ð²ÐºÐ¾Ð², Ð¿Ð¾ÑÑÐ½ÐµÐ½Ð¸Ð¹ Ð¸ Ð¾Ñ‚Ð²ÐµÑ‚Ð¾Ð².`;

  const text = await withRetry(() => callGemini(systemPrompt, userPrompt));
  const questions = parseNumberedList(text);
  const raw = (questions.length > 0 ? questions : text.split("\n").map((l) => l.trim()).filter(Boolean)).slice(0, task.count);
  return raw.map((question) => enforceQuestionBrevity(question, task.language, context.questionLength)).filter(Boolean);
}
export async function generateOneQuestionQuality(context, topic, level, language, index, bannedQuestions = []) {
  const systemPrompt = buildSystemPrompt(context);
  const typeHintGen = buildQualityTypeHint(context.questionTypes || ["knowledge", "understanding"], index);
  const duplicateHint = buildDuplicateAvoidanceHint(bannedQuestions);

  const draft = await withRetry(() => callGemini(systemPrompt,
    `Ð¢ÐµÐ¼Ð°: ${topic}\nÐ£Ñ€Ð¾Ð²ÐµÐ½ÑŒ: ${LEVEL_LABELS.RU[level]} â€” ${buildLevelDescription(level)}\nÐ¡Ð¾ÑÑ‚Ð°Ð²ÑŒ Ñ€Ð¾Ð²Ð½Ð¾ 1 Ð·Ð°Ð´Ð°Ð½Ð¸Ðµ (â„–${index}).\n${typeHintGen}\n${buildBrevityHint(language, context.questionLength)}\n${duplicateHint}\nÐ¯Ð·Ñ‹Ðº: ${LANG_NAMES[language] || language}.\nÐ¤Ð¾Ñ€Ð¼Ð°Ñ‚: Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ñ‚ÐµÐºÑÑ‚ Ð·Ð°Ð´Ð°Ð½Ð¸Ñ Ð±ÐµÐ· Ð½ÑƒÐ¼ÐµÑ€Ð°Ñ†Ð¸Ð¸, Ð·Ð°Ð³Ð¾Ð»Ð¾Ð²ÐºÐ¾Ð² Ð¸ Ð¾Ñ‚Ð²ÐµÑ‚Ð¾Ð².`
  ));

  const criticSystem = `Ð¢Ñ‹ â€” ÑÑ‚Ñ€Ð¾Ð³Ð¸Ð¹ ÐºÑ€Ð¸Ñ‚Ð¸Ðº ÑÐºÐ·Ð°Ð¼ÐµÐ½Ð°Ñ†Ð¸Ð¾Ð½Ð½Ñ‹Ñ… Ð·Ð°Ð´Ð°Ð½Ð¸Ð¹ Ð´Ð»Ñ Ð¼ÐµÐ´Ð¸Ñ†Ð¸Ð½ÑÐºÐ¾Ð³Ð¾ Ð²ÑƒÐ·Ð°.
ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒ Ð·Ð°Ð´Ð°Ð½Ð¸Ðµ Ð¿Ð¾ Ñ‡ÐµÐºÐ»Ð¸ÑÑ‚Ñƒ Ð¸ Ð²Ñ‹Ð´Ð°Ð¹ ÐºÑ€Ð°Ñ‚ÐºÐ¸Ð¹ ÑÐ¿Ð¸ÑÐ¾Ðº Ð·Ð°Ð¼ÐµÑ‡Ð°Ð½Ð¸Ð¹ (ÐµÑÐ»Ð¸ ÐµÑÑ‚ÑŒ) Ð¸Ð»Ð¸ Ð½Ð°Ð¿Ð¸ÑˆÐ¸ Ñ€Ð¾Ð²Ð½Ð¾ Ð¾Ð´Ð½Ð¾ ÑÐ»Ð¾Ð²Ð¾ "ÐžÐ”ÐžÐ‘Ð Ð•ÐÐž".
Ð§ÐµÐºÐ»Ð¸ÑÑ‚:
1. ÐœÐµÐ´Ð¸Ñ†Ð¸Ð½ÑÐºÐ°Ñ ÐºÐ¾Ñ€Ñ€ÐµÐºÑ‚Ð½Ð¾ÑÑ‚ÑŒ â€” Ð½ÐµÑ‚ Ñ„Ð°ÐºÑ‚Ð¸Ñ‡ÐµÑÐºÐ¸Ñ… Ð¾ÑˆÐ¸Ð±Ð¾Ðº, ÑƒÑÑ‚Ð°Ñ€ÐµÐ²ÑˆÐ¸Ñ… Ð´Ð°Ð½Ð½Ñ‹Ñ…, Ð²Ñ‹Ð¼Ñ‹ÑˆÐ»ÐµÐ½Ð½Ñ‹Ñ… Ð¿Ñ€ÐµÐ¿Ð°Ñ€Ð°Ñ‚Ð¾Ð² Ð¸Ð»Ð¸ Ð´Ð¸Ð°Ð³Ð½Ð¾Ð·Ð¾Ð².
2. Ð¡Ð¾Ð¾Ñ‚Ð²ÐµÑ‚ÑÑ‚Ð²Ð¸Ðµ ÑƒÑ€Ð¾Ð²Ð½ÑŽ ÑÐ»Ð¾Ð¶Ð½Ð¾ÑÑ‚Ð¸ (${LEVEL_LABELS.RU[level]}).
3. Ð¡Ð¾Ð¾Ñ‚Ð²ÐµÑ‚ÑÑ‚Ð²Ð¸Ðµ ÐºÑƒÑ€ÑÑƒ (${context.course}) Ð¸ Ñ„Ð°ÐºÑƒÐ»ÑŒÑ‚ÐµÑ‚Ñƒ (${context.faculty}).
4. ÐžÑ‚ÑÑƒÑ‚ÑÑ‚Ð²Ð¸Ðµ Ð¿Ð¾Ð´ÑÐºÐ°Ð·ÐºÐ¸ Ð² Ñ‚ÐµÐºÑÑ‚Ðµ.
5. ÐžÐ´Ð½Ð¾Ð·Ð½Ð°Ñ‡Ð½Ð¾ÑÑ‚ÑŒ â€” Ñ‡Ñ‘Ñ‚ÐºÐ¸Ð¹ ÐµÐ´Ð¸Ð½ÑÑ‚Ð²ÐµÐ½Ð½Ð¾ Ð¿Ñ€Ð°Ð²Ð¸Ð»ÑŒÐ½Ñ‹Ð¹ Ð¾Ñ‚Ð²ÐµÑ‚.
6. Ð¡Ð°Ð¼Ð¾Ð´Ð¾ÑÑ‚Ð°Ñ‚Ð¾Ñ‡Ð½Ð¾ÑÑ‚ÑŒ â€” Ð¿Ð¾Ð½ÑÑ‚Ð½Ð¾ Ð±ÐµÐ· ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚Ð°.
7. ÐÐºÑ‚ÑƒÐ°Ð»ÑŒÐ½Ð¾ÑÑ‚ÑŒ â€” ÑÐ¾Ð²Ñ€ÐµÐ¼ÐµÐ½Ð½Ñ‹Ðµ Ð¿Ñ€Ð¾Ñ‚Ð¾ÐºÐ¾Ð»Ñ‹.
8. Ð¢Ð¸Ð¿ Ð·Ð°Ð´Ð°Ð½Ð¸Ñ ÑÐ¾Ð¾Ñ‚Ð²ÐµÑ‚ÑÑ‚Ð²ÑƒÐµÑ‚: ${typeHintGen.split(":")[0]}.
9. ÐšÑ€Ð°Ñ‚ÐºÐ¾ÑÑ‚ÑŒ: 1 Ñ„Ñ€Ð°Ð·Ð°, Ð±ÐµÐ· Ð¼Ð½Ð¾Ð³Ð¾ÑÐ¾ÑÑ‚Ð°Ð²Ð½Ð¾Ð¹ Ñ„Ð¾Ñ€Ð¼ÑƒÐ»Ð¸Ñ€Ð¾Ð²ÐºÐ¸, Ð¾Ñ‚Ð²ÐµÑ‚ Ð²Ð¾Ð·Ð¼Ð¾Ð¶ÐµÐ½ Ð·Ð° ${getAnswerMinutes(context.questionLength)} Ð¼Ð¸Ð½ÑƒÑ‚Ñ‹.
ÐžÑ‚Ð²ÐµÑ‡Ð°Ð¹ ÐºÑ€Ð°Ñ‚ÐºÐ¾. Ð•ÑÐ»Ð¸ Ð·Ð°Ð¼ÐµÑ‡Ð°Ð½Ð¸Ð¹ Ð½ÐµÑ‚ â€” Ñ‚Ð¾Ð»ÑŒÐºÐ¾ "ÐžÐ”ÐžÐ‘Ð Ð•ÐÐž".`;

  const criticism = await withRetry(() => callGeminiLowTemp(criticSystem,
    `ÐŸÑ€ÐµÐ´Ð¼ÐµÑ‚: ${context.subject}. Ð¢ÐµÐ¼Ð°: ${topic}.\nÐ—Ð°Ð´Ð°Ð½Ð¸Ðµ: ${draft}`
  ));

  if (criticism.trim().toUpperCase().startsWith("ÐžÐ”ÐžÐ‘Ð Ð•ÐÐž")) {
    return enforceQuestionBrevity(draft.trim(), language, context.questionLength);
  }

  const edited = await withRetry(() => callGeminiLowTemp(
    `Ð¢Ñ‹ â€” Ñ€ÐµÐ´Ð°ÐºÑ‚Ð¾Ñ€ ÑÐºÐ·Ð°Ð¼ÐµÐ½Ð°Ñ†Ð¸Ð¾Ð½Ð½Ñ‹Ñ… Ð·Ð°Ð´Ð°Ð½Ð¸Ð¹. Ð˜ÑÐ¿Ñ€Ð°Ð²ÑŒ Ð·Ð°Ð´Ð°Ð½Ð¸Ðµ Ð¿Ð¾ Ð·Ð°Ð¼ÐµÑ‡Ð°Ð½Ð¸ÑÐ¼ ÐºÑ€Ð¸Ñ‚Ð¸ÐºÐ°.\n${typeHintGen}\n${buildBrevityHint(language, context.questionLength)}\n${duplicateHint}\nÐ’ÐµÑ€Ð½Ð¸ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð¸ÑÐ¿Ñ€Ð°Ð²Ð»ÐµÐ½Ð½Ñ‹Ð¹ Ñ‚ÐµÐºÑÑ‚ Ð±ÐµÐ· ÐºÐ¾Ð¼Ð¼ÐµÐ½Ñ‚Ð°Ñ€Ð¸ÐµÐ².`,
    `ÐŸÑ€ÐµÐ´Ð¼ÐµÑ‚: ${context.subject}. Ð¢ÐµÐ¼Ð°: ${topic}. Ð£Ñ€Ð¾Ð²ÐµÐ½ÑŒ: ${LEVEL_LABELS.RU[level]}. Ð¯Ð·Ñ‹Ðº: ${LANG_NAMES[language] || language}.\n\nÐ§ÐµÑ€Ð½Ð¾Ð²Ð¸Ðº:\n${draft}\n\nÐ—Ð°Ð¼ÐµÑ‡Ð°Ð½Ð¸Ñ:\n${criticism}\n\nÐ’ÐµÑ€Ð½Ð¸ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð¸ÑÐ¿Ñ€Ð°Ð²Ð»ÐµÐ½Ð½Ñ‹Ð¹ Ñ‚ÐµÐºÑÑ‚.`
  ));
  return enforceQuestionBrevity((edited || draft).trim(), language, context.questionLength);
}
export async function generateQuality(task, context, onQuestion, options = {}) {
  const isDuplicate = typeof options.isDuplicate === "function" ? options.isDuplicate : () => false;
  const getBannedQuestions = typeof options.getBannedQuestions === "function"
    ? options.getBannedQuestions
    : () => [];
  const onDuplicate = typeof options.onDuplicate === "function" ? options.onDuplicate : () => {};
  const maxAttemptsPerQuestion = Math.max(1, Number(options.maxAttemptsPerQuestion) || 4);

  for (let i = 1; i <= task.count; i++) {
    let accepted = false;
    for (let attempt = 0; attempt < maxAttemptsPerQuestion; attempt++) {
      try {
        const promptIndex = i + (attempt * task.count);
        const banned = getBannedQuestions(task.language);
        const q = await generateOneQuestionQuality(context, task.topic, task.level, task.language, promptIndex, banned); // eslint-disable-line no-await-in-loop
        if (isDuplicate(q)) {
          onDuplicate(q);
          continue;
        }
        onQuestion(q);
        accepted = true;
        break;
      } catch {
        // keep retrying this slot
      }
    }
    if (!accepted) {
      // skip unresolved slot
    }
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
    progress: {
      totalTasks: tasks.length,
      completedTasks: 0,
      failedTasks: 0,
      totalQuestions,
      generatedQuestions: 0,
      duplicatesSkipped: 0,
      byTopic
    }
  };

  jobs.set(id, job);

  processJob(job, tasks).catch((error) => {
    job.status = "failed";
    job.errors.push({ message: error instanceof Error ? error.message : "Unknown error" });
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

function appendQuestionIfUnique(job, task, question) {
  const candidate = enforceQuestionBrevity(question, task.language, job.context.questionLength);
  if (!candidate) return false;

  const existing = job.resultByLanguage[task.language] || [];
  if (isQuestionSemanticallyDuplicate(candidate, existing)) {
    job.progress.duplicatesSkipped += 1;
    return false;
  }

  existing.push(candidate);
  job.progress.generatedQuestions += 1;
  job.progress.byTopic[task.topic].generatedQuestions += 1;
  return true;
}

async function processJob(job, tasks) {
  const concurrency = job.mode === "quality" ? 2 : 5;
  await runWithConcurrency(tasks, concurrency, async (task) => {
    if (job.cancelled) return;
    try {
      if (job.mode === "quality") {
        let acceptedForTask = 0;
        await generateQuality(task, job.context, (q) => {
          if (job.cancelled) return;
          if (appendQuestionIfUnique(job, task, q)) {
            acceptedForTask += 1;
            job.updatedAt = new Date().toISOString();
          }
        }, {
          isDuplicate: (q) => isQuestionSemanticallyDuplicate(q, job.resultByLanguage[task.language]),
          getBannedQuestions: () => job.resultByLanguage[task.language],
          onDuplicate: () => { job.progress.duplicatesSkipped += 1; },
          maxAttemptsPerQuestion: 4
        });
        if (acceptedForTask < task.count) {
          job.errors.push({
            task: { topic: task.topic, level: task.level, language: task.language },
            message: `Недостаточно уникальных вопросов: ${acceptedForTask}/${task.count}.`
          });
        }
      } else {
        let acceptedForTask = 0;
        let attempts = 0;
        while (!job.cancelled && acceptedForTask < task.count && attempts < 4) {
          const missing = task.count - acceptedForTask;
          const requestCount = Math.min(missing + 2, Math.max(missing, missing * 2));
          const questions = await generateFast({ ...task, count: requestCount }, job.context, job.resultByLanguage[task.language]);
          for (const q of questions) {
            if (job.cancelled) break;
            if (appendQuestionIfUnique(job, task, q)) {
              acceptedForTask += 1;
            }
            if (acceptedForTask >= task.count) break;
          }
          attempts += 1;
        }
        if (acceptedForTask < task.count) {
          job.errors.push({
            task: { topic: task.topic, level: task.level, language: task.language },
            message: `Недостаточно уникальных вопросов: ${acceptedForTask}/${task.count}.`
          });
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
    : (job.progress.failedTasks > 0 || job.errors.length > 0) ? "completed_with_errors"
    : "completed";
  job.updatedAt = new Date().toISOString();
}

export function jobStatusPayload(job) {
  const metadata = {
    subject: job.context.subject,
    faculty: job.context.faculty,
    course: job.context.course,
    examType: job.context.examType,
    mode: job.mode,
    questionLength: job.context.questionLength || "short",
    totalQuestions: job.progress.generatedQuestions,
    plannedQuestions: job.progress.totalQuestions,
    duplicatesSkipped: job.progress.duplicatesSkipped
  };
  return {
    jobId: job.id, status: job.status, mode: job.mode,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    progress: { ...job.progress, byTopic: Object.entries(job.progress.byTopic).map(([topic, v]) => ({ topic, ...v })) },
    metadata,
    questionsByLanguage: job.resultByLanguage,
    errors: job.errors
  };
}

export function jobResultPayload(job) {
  return {
    jobId: job.id, status: job.status,
    metadata: {
      subject: job.context.subject,
      faculty: job.context.faculty,
      course: job.context.course,
      examType: job.context.examType,
      mode: job.mode,
      questionLength: job.context.questionLength || "short",
      totalQuestions: job.progress.generatedQuestions,
      plannedQuestions: job.progress.totalQuestions,
      duplicatesSkipped: job.progress.duplicatesSkipped
    },
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
