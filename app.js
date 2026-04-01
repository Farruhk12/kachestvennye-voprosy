const MAX_TOPICS = 15;
const DEFAULT_COUNTS = { easy: 20, medium: 20, hard: 20 };
const COUNT_PRESET_VALUES = [1, 5, 10, 20, 25, 30];

const state = {
  topics: [],
  job: {
    id: null,
    status: "idle",
    pollTimer: null,
    result: null,
    activeLanguage: "RU"
  }
};

const refs = {
  facultySelect: document.getElementById("facultySelect"),
  customFacultyField: document.getElementById("customFacultyField"),
  customFacultyInput: document.getElementById("customFacultyInput"),
  courseSelect: document.getElementById("courseSelect"),
  examTypeSelect: document.getElementById("examTypeSelect"),
  subjectInput: document.getElementById("subjectInput"),
  modeSelect: document.getElementById("modeSelect"),
  questionLengthSelect: document.getElementById("questionLengthSelect"),
  topicInput: document.getElementById("topicInput"),
  addTopicBtn: document.getElementById("addTopicBtn"),
  bulkTopicsInput: document.getElementById("bulkTopicsInput"),
  addBulkTopicsBtn: document.getElementById("addBulkTopicsBtn"),
  topicsChips: document.getElementById("topicsChips"),
  countPresets: document.getElementById("countPresets"),
  countsTableBody: document.getElementById("countsTableBody"),
  totalQuestions: document.getElementById("totalQuestions"),
  generateBtn: document.getElementById("generateBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  formError: document.getElementById("formError"),
  progressBlock: document.getElementById("progressBlock"),
  progressText: document.getElementById("progressText"),
  progressStatusLabel: document.getElementById("progressStatusLabel"),
  progressFill: document.getElementById("progressFill"),
  progressCount: document.getElementById("progressCount"),
  topicStatusGrid: document.getElementById("topicStatusGrid"),
  generationErrors: document.getElementById("generationErrors"),
  resultsSection: document.getElementById("resultsSection"),
  languageTabs: document.getElementById("languageTabs"),
  questionsList: document.getElementById("questionsList"),
  copyBtn: document.getElementById("copyBtn"),
  exportBtn: document.getElementById("exportBtn"),
  newGenerationBtn: document.getElementById("newGenerationBtn"),
  resultInfo: document.getElementById("resultInfo")
};

function uid() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function selectedLanguages() {
  return Array.from(document.querySelectorAll('input[type="checkbox"]:not([name="questionType"])'))
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function selectedQuestionTypes() {
  return Array.from(document.querySelectorAll('input[name="questionType"]'))
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function getFaculty() {
  if (refs.facultySelect.value === "OTHER") {
    return refs.customFacultyInput.value.trim();
  }
  return refs.facultySelect.value;
}

function questionLengthLabel(mode) {
  if (mode === "detailed") return "Развернутый (6-8 мин)";
  if (mode === "standard") return "Стандартный (4-6 мин)";
  return "Короткий (2-4 мин)";
}

function totalQuestionsForTopic(topic) {
  return topic.counts.easy + topic.counts.medium + topic.counts.hard;
}

function overallQuestions() {
  return state.topics.reduce((sum, topic) => sum + totalQuestionsForTopic(topic), 0);
}

function renderTopics() {
  refs.topicsChips.innerHTML = "";
  for (const topic of state.topics) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const span = document.createElement("span");
    span.textContent = topic.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-topic-id", topic.id);
    btn.textContent = "✕";
    chip.appendChild(span);
    chip.appendChild(btn);
    refs.topicsChips.appendChild(chip);
  }
}

function renderCountsTable() {
  refs.countsTableBody.innerHTML = "";
  if (state.topics.length === 0) {
    refs.countsTableBody.innerHTML =
      '<tr><td colspan="5" class="empty">Добавьте темы, чтобы настроить количество вопросов.</td></tr>';
    refs.totalQuestions.textContent = "0";
    return;
  }

  for (const topic of state.topics) {
    const row = document.createElement("tr");
    row.setAttribute("data-row-topic-id", topic.id);

    const tdName = document.createElement("td");
    tdName.textContent = topic.name;

    const tdEasy = document.createElement("td");
    const inEasy = document.createElement("input");
    inEasy.type = "number"; inEasy.min = "0"; inEasy.max = "100";
    inEasy.setAttribute("data-topic-id", topic.id); inEasy.setAttribute("data-level", "easy");
    inEasy.value = String(topic.counts.easy);
    tdEasy.appendChild(inEasy);

    const tdMed = document.createElement("td");
    const inMed = document.createElement("input");
    inMed.type = "number"; inMed.min = "0"; inMed.max = "100";
    inMed.setAttribute("data-topic-id", topic.id); inMed.setAttribute("data-level", "medium");
    inMed.value = String(topic.counts.medium);
    tdMed.appendChild(inMed);

    const tdHard = document.createElement("td");
    const inHard = document.createElement("input");
    inHard.type = "number"; inHard.min = "0"; inHard.max = "100";
    inHard.setAttribute("data-topic-id", topic.id); inHard.setAttribute("data-level", "hard");
    inHard.value = String(topic.counts.hard);
    tdHard.appendChild(inHard);

    const tdTotal = document.createElement("td");
    tdTotal.className = "row-total";
    tdTotal.textContent = String(totalQuestionsForTopic(topic));

    row.appendChild(tdName);
    row.appendChild(tdEasy);
    row.appendChild(tdMed);
    row.appendChild(tdHard);
    row.appendChild(tdTotal);
    refs.countsTableBody.appendChild(row);
  }

  refs.totalQuestions.textContent = String(overallQuestions());
}

function renderAll() {
  renderTopics();
  renderCountsTable();
  validateForm();
}

function addTopic(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  if (state.topics.length >= MAX_TOPICS) {
    setFormError(`Достигнут лимит: максимум ${MAX_TOPICS} тем.`);
    return;
  }

  const alreadyExists = state.topics.some((topic) => topic.name.toLowerCase() === trimmed.toLowerCase());
  if (alreadyExists) {
    setFormError("Такая тема уже добавлена.");
    return;
  }

  state.topics.push({
    id: uid(),
    name: trimmed,
    counts: { ...DEFAULT_COUNTS }
  });

  clearFormError();
  renderAll();
}

function removeTopic(topicId) {
  state.topics = state.topics.filter((topic) => topic.id !== topicId);
  renderAll();
}

function updateTopicCount(topicId, level, value) {
  const topic = state.topics.find((item) => item.id === topicId);
  if (!topic) return;

  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? Math.floor(value) : 0));
  topic.counts[level] = clamped;

  // Update only the total cell of this row to avoid focus loss on full re-render
  const row = refs.countsTableBody.querySelector(`tr[data-row-topic-id="${CSS.escape(topicId)}"]`);
  if (row) {
    const totalCell = row.querySelector(".row-total");
    if (totalCell) totalCell.textContent = String(totalQuestionsForTopic(topic));
  }
  refs.totalQuestions.textContent = String(overallQuestions());
  validateForm();
}

function applyPresetToAllCounts(value) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? Math.floor(value) : 0));
  if (state.topics.length === 0) {
    setFormError("Сначала добавьте минимум одну тему.");
    return;
  }

  for (const topic of state.topics) {
    topic.counts.easy = clamped;
    topic.counts.medium = clamped;
    topic.counts.hard = clamped;
  }

  clearFormError();
  renderCountsTable();
  validateForm();
}

function setFormError(message) {
  refs.formError.textContent = message;
}

function clearFormError() {
  refs.formError.textContent = "";
}

function validateForm() {
  const subject = refs.subjectInput.value.trim();
  const faculty = getFaculty();
  const languages = selectedLanguages();
  const questionTypes = selectedQuestionTypes();
  const total = overallQuestions();

  if (!subject || !faculty || languages.length === 0 || questionTypes.length === 0 ||
      state.topics.length === 0 || total <= 0) {
    refs.generateBtn.disabled = true;
    return;
  }

  refs.generateBtn.disabled = false;
}

function currentPayload() {
  return {
    context: {
      faculty: getFaculty(),
      course: Number(refs.courseSelect.value),
      examType: refs.examTypeSelect.value,
      subject: refs.subjectInput.value.trim(),
      questionTypes: selectedQuestionTypes(),
      mode: refs.modeSelect.value,
      questionLength: refs.questionLengthSelect.value
    },
    languages: selectedLanguages(),
    topics: state.topics.map((topic) => ({
      name: topic.name,
      counts: { ...topic.counts }
    }))
  };
}

function resetProgressUI() {
  refs.progressBlock.classList.add("hidden");
  refs.progressStatusLabel.textContent = "Генерация...";
  refs.progressText.textContent = "0%";
  refs.progressFill.style.width = "0%";
  refs.progressCount.textContent = "";
  refs.topicStatusGrid.innerHTML = "";
  refs.generationErrors.innerHTML = "";
}

function renderProgress(statusPayload) {
  const progress = statusPayload.progress;
  refs.progressBlock.classList.remove("hidden");

  const total = progress.totalQuestions || 0;
  const done = progress.generatedQuestions || 0;
  const duplicatesSkipped = progress.duplicatesSkipped || 0;
  const shouldForceFullBar = ["completed", "completed_with_errors", "cancelled"].includes(statusPayload.status);
  const percent = shouldForceFullBar ? 100 : (total > 0 ? Math.round((done / total) * 100) : 0);

  const statusLabel = {
    running: statusPayload.mode === "quality" ? "Генерация · цепочка агентов..." : "Генерация...",
    cancelling: "Отмена...",
    completed: "Готово ✓",
    completed_with_errors: "Завершено с ошибками",
    cancelled: "Отменено",
    failed: "Ошибка"
  }[statusPayload.status] || "...";

  refs.progressStatusLabel.textContent = statusLabel;
  refs.progressText.textContent = `${percent}%`;
  refs.progressFill.style.width = `${percent}%`;
  refs.progressCount.textContent = duplicatesSkipped > 0
    ? `${done} из ${total} вопросов · убрано дублей: ${duplicatesSkipped}`
    : `${done} из ${total} вопросов`;

  // Topic mini-progress bars
  refs.topicStatusGrid.innerHTML = "";
  for (const topic of progress.byTopic || []) {
    const topicPct = topic.totalQuestions > 0
      ? Math.min(100, Math.round((topic.generatedQuestions / topic.totalQuestions) * 100))
      : 0;
    const isDone = topic.generatedQuestions >= topic.totalQuestions;

    const item = document.createElement("div");
    item.className = "topic-status-item";
    item.innerHTML = `
      <div class="topic-status-row">
        <span class="topic-status-name">${topic.topic}</span>
        <span class="topic-status-nums${isDone ? " done" : ""}">${topic.generatedQuestions}/${topic.totalQuestions}${isDone ? " ✓" : ""}</span>
      </div>
      <div class="topic-mini-track">
        <div class="topic-mini-fill" style="width:${topicPct}%"></div>
      </div>`;
    refs.topicStatusGrid.appendChild(item);
  }

  refs.generationErrors.innerHTML = "";
  for (const error of statusPayload.errors || []) {
    const li = document.createElement("li");
    li.textContent = error.message || "Ошибка во время генерации";
    refs.generationErrors.appendChild(li);
  }
}

function availableResultLanguages(result) {
  return Object.keys(result.questionsByLanguage || {}).filter(
    (lang) => Array.isArray(result.questionsByLanguage[lang])
  );
}

function renderResultQuestions() {
  const result = state.job.result;
  if (!result) return;

  const lang = state.job.activeLanguage;
  const questions = result.questionsByLanguage[lang] || [];
  refs.questionsList.innerHTML = "";
  for (const question of questions) {
    const li = document.createElement("li");
    li.textContent = question;
    refs.questionsList.appendChild(li);
  }

  const modeLabel = state.job.result?.metadata?.mode === "quality" ? "Качественный (цепочка агентов)" : "Быстрый";
  const lengthLabel = questionLengthLabel(state.job.result?.metadata?.questionLength);
  refs.resultInfo.textContent = `Язык: ${lang} · Вопросов: ${questions.length} · Режим: ${modeLabel} · Длина: ${lengthLabel}`;
}

function renderLanguageTabs() {
  const result = state.job.result;
  if (!result) return;
  const languages = availableResultLanguages(result);

  refs.languageTabs.innerHTML = "";
  for (const lang of languages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab${lang === state.job.activeLanguage ? " active" : ""}`;
    button.textContent = lang;
    button.addEventListener("click", () => {
      state.job.activeLanguage = lang;
      renderLanguageTabs();
      renderResultQuestions();
    });
    refs.languageTabs.appendChild(button);
  }
}

function showResult(resultPayload, options = {}) {
  const previousLanguage = state.job.activeLanguage;
  state.job.result = resultPayload;
  const languages = availableResultLanguages(resultPayload);
  state.job.activeLanguage = languages.includes(previousLanguage) ? previousLanguage : (languages[0] || "RU");

  const wasHidden = refs.resultsSection.classList.contains("hidden");
  refs.resultsSection.classList.remove("hidden");
  renderLanguageTabs();
  renderResultQuestions();
  if (options.scroll !== false && wasHidden) {
    setTimeout(() => refs.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }
}

function clearResult() {
  state.job.result = null;
  refs.resultsSection.classList.add("hidden");
  refs.languageTabs.innerHTML = "";
  refs.questionsList.innerHTML = "";
  refs.resultInfo.textContent = "";
}

function setRunningUi(isRunning) {
  refs.generateBtn.disabled = isRunning;
  refs.cancelBtn.classList.toggle("hidden", !isRunning);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Ошибка запроса к серверу");
  }
  return payload;
}

function mergeLiveResult(payload) {
  const previous = state.job.result || { metadata: {}, questionsByLanguage: {} };
  const merged = {
    jobId: payload.jobId || previous.jobId || state.job.id,
    status: payload.status || previous.status || state.job.status,
    metadata: { ...(previous.metadata || {}), ...(payload.metadata || {}) },
    questionsByLanguage: payload.questionsByLanguage || previous.questionsByLanguage || {}
  };
  showResult(merged, { scroll: false });
}

async function fetchResult(allowPartial = false) {
  const query = allowPartial ? "&allowPartial=1" : "";
  return api(`/api/result?id=${encodeURIComponent(state.job.id)}${query}`, { method: "GET" });
}

async function fetchResultIfReady() {
  const result = await fetchResult(false);
  showResult(result, { scroll: false });
}

async function pollStatus() {
  if (!state.job.id) return;

  try {
    const status = await api(`/api/status?id=${encodeURIComponent(state.job.id)}`, { method: "GET" });
    state.job.status = status.status;
    renderProgress(status);
    if (status.questionsByLanguage) {
      mergeLiveResult(status);
    } else {
      try {
        const partial = await fetchResult(true);
        mergeLiveResult(partial);
      } catch {
        // ignore until first partial appears
      }
    }

    const terminal = ["completed", "completed_with_errors", "cancelled", "failed"].includes(status.status);
    if (!terminal) {
      return;
    }

    clearInterval(state.job.pollTimer);
    state.job.pollTimer = null;
    setRunningUi(false);

    if (["completed", "completed_with_errors", "cancelled"].includes(status.status)) {
      try {
        await fetchResultIfReady();
      } catch {
        // Keep the latest partial result if final payload is temporarily unavailable.
      }
    }
  } catch (error) {
    setFormError(error instanceof Error ? error.message : "Ошибка получения статуса.");
    clearInterval(state.job.pollTimer);
    state.job.pollTimer = null;
    setRunningUi(false);
  }
}

async function startGeneration() {
  clearFormError();
  clearResult();
  resetProgressUI();
  if (state.job.pollTimer) {
    clearInterval(state.job.pollTimer);
    state.job.pollTimer = null;
  }
  state.job.id = null;
  state.job.status = "idle";
  validateForm();
  if (refs.generateBtn.disabled) {
    setFormError("Заполните обязательные поля: предмет, факультет, темы, языки, количество вопросов.");
    return;
  }

  setRunningUi(true);
  refs.progressBlock.classList.remove("hidden");
  refs.progressStatusLabel.textContent = "Генерация...";
  refs.progressText.textContent = "0%";
  refs.progressFill.style.width = "0%";
  refs.progressCount.textContent = "Подготовка задачи...";

  try {
    const payload = currentPayload();
    const started = await api("/api/start", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.job.id = started.jobId;
    state.job.status = started.status || "running";

    const initialQuestions = Object.fromEntries(payload.languages.map((lang) => [lang, []]));
    mergeLiveResult({
      jobId: started.jobId,
      status: started.status || "running",
      metadata: {
        subject: payload.context.subject,
        faculty: payload.context.faculty,
        course: payload.context.course,
        examType: payload.context.examType,
        mode: payload.context.mode,
        questionLength: payload.context.questionLength,
        totalQuestions: 0,
        plannedQuestions: started.progress?.totalQuestions || 0
      },
      questionsByLanguage: initialQuestions
    });

    if (started.progress) {
      renderProgress(started);
    }

    await pollStatus();
    if (state.job.pollTimer) {
      clearInterval(state.job.pollTimer);
      state.job.pollTimer = null;
    }
    if (["running", "cancelling"].includes(state.job.status)) {
      state.job.pollTimer = setInterval(pollStatus, 1200);
    }
  } catch (error) {
    setFormError(error instanceof Error ? error.message : "Не удалось выполнить генерацию.");
    refs.progressBlock.classList.add("hidden");
  } finally {
    if (!state.job.pollTimer && !["running", "cancelling"].includes(state.job.status)) {
      setRunningUi(false);
    }
  }
}

async function cancelGeneration() {
  if (!state.job.id || !["running", "cancelling"].includes(state.job.status)) return;
  try {
    const payload = await api(`/api/cancel?id=${encodeURIComponent(state.job.id)}`, { method: "POST" });
    state.job.status = payload.status || "cancelling";
    refs.progressStatusLabel.textContent = "Отмена...";
  } catch (error) {
    setFormError(error instanceof Error ? error.message : "Не удалось отменить генерацию.");
  }
}

async function copyCurrentLanguage() {
  if (!state.job.result) return;
  const questions = state.job.result.questionsByLanguage[state.job.activeLanguage] || [];
  const text = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  if (!text) {
    setFormError("Нет вопросов для копирования.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    refs.resultInfo.textContent = `Скопировано: ${questions.length} вопросов (${state.job.activeLanguage}).`;
  } catch {
    setFormError("Не удалось скопировать в буфер обмена.");
  }
}

async function requestExport() {
  if (!state.job.result) return;
  try {
    const response = await fetch("/api/export/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        result: state.job.result,
        language: state.job.activeLanguage
      })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Ошибка экспорта");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
    a.download = match ? decodeURIComponent(match[1].replace(/"/g, "")) : "questions.docx";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    setFormError(error instanceof Error ? error.message : "Экспорт временно недоступен.");
  }
}

function resetForm() {
  refs.facultySelect.value = "Лечебный";
  refs.customFacultyInput.value = "";
  refs.customFacultyField.classList.add("hidden");
  refs.courseSelect.value = "6";
  refs.examTypeSelect.value = "Устный";
  refs.subjectInput.value = "";
  refs.modeSelect.value = "fast";
  refs.questionLengthSelect.value = "short";
  document.querySelectorAll('input[type="checkbox"]:not([name="questionType"])').forEach((input) => {
    input.checked = input.value === "RU";
  });
  document.querySelectorAll('input[name="questionType"]').forEach((input) => {
    input.checked = input.value === "knowledge" || input.value === "understanding";
  });

  refs.topicInput.value = "";
  refs.bulkTopicsInput.value = "";
  state.topics = [];
  state.job.id = null;
  state.job.status = "idle";
  if (state.job.pollTimer) {
    clearInterval(state.job.pollTimer);
    state.job.pollTimer = null;
  }

  setRunningUi(false);
  clearResult();
  resetProgressUI();
  clearFormError();
  renderAll();
}

function bindEvents() {
  refs.facultySelect.addEventListener("change", () => {
    const isOther = refs.facultySelect.value === "OTHER";
    refs.customFacultyField.classList.toggle("hidden", !isOther);
    validateForm();
  });

  refs.customFacultyInput.addEventListener("input", validateForm);
  refs.courseSelect.addEventListener("change", validateForm);
  refs.examTypeSelect.addEventListener("change", validateForm);
  refs.subjectInput.addEventListener("input", validateForm);
  refs.modeSelect.addEventListener("change", validateForm);
  refs.questionLengthSelect.addEventListener("change", validateForm);
  document.querySelectorAll('input[type="checkbox"][value]').forEach((input) => {
    input.addEventListener("change", validateForm);
  });

  refs.addTopicBtn.addEventListener("click", () => {
    addTopic(refs.topicInput.value);
    refs.topicInput.value = "";
    refs.topicInput.focus();
  });

  refs.topicInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      refs.addTopicBtn.click();
    }
  });

  refs.addBulkTopicsBtn.addEventListener("click", () => {
    const lines = refs.bulkTopicsInput.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      addTopic(line);
    }
    refs.bulkTopicsInput.value = "";
  });

  refs.topicsChips.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const topicId = target.getAttribute("data-topic-id");
    if (!topicId) return;
    removeTopic(topicId);
  });

  refs.countsTableBody.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const topicId = target.getAttribute("data-topic-id");
    const level = target.getAttribute("data-level");
    if (!topicId || !level) return;
    updateTopicCount(topicId, level, Number(target.value));
  });

  refs.countPresets.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const presetValue = Number(target.getAttribute("data-count-preset"));
    if (!COUNT_PRESET_VALUES.includes(presetValue)) return;
    applyPresetToAllCounts(presetValue);
  });

  refs.generateBtn.addEventListener("click", startGeneration);
  refs.cancelBtn.addEventListener("click", cancelGeneration);
  refs.copyBtn.addEventListener("click", copyCurrentLanguage);
  refs.exportBtn.addEventListener("click", requestExport);
  refs.newGenerationBtn.addEventListener("click", resetForm);
}

function init() {
  bindEvents();
  resetForm();
}

init();
