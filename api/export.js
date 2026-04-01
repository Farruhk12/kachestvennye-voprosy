import { jobs, buildDocx } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const jobId = String(payload?.jobId || "");
  const language = String(payload?.language || "RU").toUpperCase();

  if (!jobId) return res.status(400).json({ error: "jobId обязателен." });

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (!["completed", "completed_with_errors", "cancelled"].includes(job.status)) {
    return res.status(409).json({ error: "Job is not completed yet" });
  }

  if (!job.languages.includes(language)) {
    return res.status(400).json({ error: `Язык ${language} недоступен для этого задания.` });
  }

  const docxBuffer = buildDocx(job, language);
  const dateStr = new Date().toLocaleDateString("ru-RU");
  const safeName = [job.context.subject, job.context.faculty, `${job.context.course}курс`, dateStr]
    .map((s) => String(s).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-.]/g, "_"))
    .join("_");
  const filename = `${safeName}_${language}.docx`;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Length", String(docxBuffer.length));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).end(docxBuffer);
}
