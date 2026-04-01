import { buildDocx } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const result = payload?.result;
  const language = String(payload?.language || "RU").toUpperCase();

  if (!result) return res.status(400).json({ error: "result обязателен." });
  if (!result.questionsByLanguage?.[language]) {
    return res.status(400).json({ error: `Язык ${language} недоступен.` });
  }

  // Build a synthetic job object for buildDocx
  const job = {
    context: result.metadata || {},
    mode: result.metadata?.mode || "fast",
    languages: Object.keys(result.questionsByLanguage),
    resultByLanguage: result.questionsByLanguage
  };

  const docxBuffer = buildDocx(job, language);
  const dateStr = new Date().toLocaleDateString("ru-RU");
  const ctx = result.metadata || {};
  const safeName = [ctx.subject, ctx.faculty, `${ctx.course || ""}курс`, dateStr]
    .map((s) => String(s || "").replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-.]/g, "_"))
    .join("_");
  const filename = `${safeName}_${language}.docx`;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Length", String(docxBuffer.length));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).end(docxBuffer);
}
