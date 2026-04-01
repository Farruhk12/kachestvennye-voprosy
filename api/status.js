import { jobs, jobStatusPayload } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const jobId = req.query.id;
  if (!jobId) return res.status(400).json({ error: "id обязателен" });

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  return res.status(200).json(jobStatusPayload(job));
}
