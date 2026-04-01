import { jobs, jobResultPayload } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const jobId = req.query.id;
  if (!jobId) return res.status(400).json({ error: "id обязателен" });
  const allowPartial = ["1", "true", "yes"].includes(String(req.query.allowPartial || "").toLowerCase());

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (!allowPartial && !["completed", "completed_with_errors", "cancelled"].includes(job.status)) {
    return res.status(409).json({ error: "Result is not ready yet", status: job.status });
  }

  return res.status(200).json(jobResultPayload(job));
}
