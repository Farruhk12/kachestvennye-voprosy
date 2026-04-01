import { normalizeStartPayload, createJob } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const normalized = normalizeStartPayload(payload);
  if (!normalized.ok) return res.status(400).json({ error: normalized.message });

  const job = createJob(normalized.value);
  return res.status(202).json({ jobId: job.id, status: job.status, progress: job.progress });
}
