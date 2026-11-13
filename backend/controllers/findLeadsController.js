const axios = require("axios");
const { findLeadsQueue } = require("../queues/findLeadsQueue");
const { redisClient } = require("../config/redis");
const { prisma } = require("../config/postgres");
const { recordActivity } = require("../services/leadActivityService");
const asyncHandler = require("../utils/asyncHandler");
const response = require("../utils/response");
const { AppError } = require("../middleware/errorHandler");

const SCRAPER_API_URL = (
  process.env.JOB_SCRAPER_URL ||
  process.env.SCRAPER_API_URL ||
  "http://localhost:8000"
).replace(/\/+$/, "");

// 1. POST /api/leads/find
const findLeads = asyncHandler(async (req, res) => {
  const { searchQuery, searchType = "all" } = req.body;
  if (!searchQuery) {
    throw new AppError("searchQuery is required", 400);
  }

  // Call FastAPI to start scraping
  let fastapiRes;
try {
  fastapiRes = await axios.post(
    `${SCRAPER_API_URL}/scrape`,
    { query: searchQuery, search_type: searchType, limit: 10 },
    { timeout: 60000 }
  );
} catch (error) {
  console.error("Scraper start failed:", error.message);
  throw new AppError(
    "Could not reach the scraper service. It may be waking up, please try again in a minute.",
    502
  );
}
  const fastapiJobId = fastapiRes.data.job_id;

  // Enqueue BullMQ job
  const job = await findLeadsQueue.add("poll-fastapi", {
    fastapiJobId,
  });

  return response.success(res, { jobId: job.id });
});

// 2. GET /api/leads/find/:jobId
const getFindLeadsStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await findLeadsQueue.getJob(jobId);

  if (!job) {
    throw new AppError("Job not found", 404);
  }

  const state = await job.getState();

  // States: waiting, active, completed, failed, delayed, etc.
  if (state === "completed") {
    // Fetch raw leads from redis
    const resultStr = await redisClient.get(`find-leads-result:${jobId}`);
    const leads = resultStr ? JSON.parse(resultStr) : [];
    return response.success(res, { status: "done", leads });
  } else if (state === "failed") {
    return response.success(res, { status: "error", error: job.failedReason });
  } else {
    // running or waiting
    return response.success(res, { status: "running" });
  }
});

// 3. POST /api/leads/find/:jobId/confirm
const confirmFindLeads = asyncHandler(async (req, res) => {
  const { selectedLeads } = req.body;
  if (!Array.isArray(selectedLeads)) {
    throw new AppError("selectedLeads must be an array", 400);
  }

  const results = { created: [], skipped: [] };

  for (const item of selectedLeads) {
    const hrContact = item["HR CONTACT"] || "";
    let parsedEmail = null;

    // Never save generic, inferred or missing emails
    const verification = String(item["VERIFICATION"] || "").toLowerCase();
    if (
      hrContact.includes("Inferred (unverified)") ||
      verification.includes("generic email") ||
      verification.includes("not disclosed")
    ) {
      results.skipped.push({
        item,
        reason: "generic, inferred or missing email, not used",
      });
      continue;
    }

    const emailMatch = hrContact.match(
      /Email:\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/i
    );
    if (emailMatch && emailMatch[1]) {
      parsedEmail = emailMatch[1].toLowerCase();
    } else if (hrContact.includes("@")) {
      // Fallback simple regex extraction if it wasn't prefixed with "Email: "
      const rawMatch = hrContact.match(
        /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/
      );
      if (rawMatch) {
        parsedEmail = rawMatch[0].toLowerCase();
      }
    }

    if (!parsedEmail) {
      results.skipped.push({
        item,
        reason: "No parseable email address in HR CONTACT",
      });
      continue;
    }

    // Map fields
    const companyName = item["COMPANY"] || null;
    const jobTitle = item["JOB TITLE"] || null;
    const location = item["AREA / LOCATION"] || null;
    const score = item["SCORE"] || 0;

    // Construct name as "HR — {COMPANY}"
    const leadName = companyName
      ? `HR \u2014 ${companyName}`
      : "HR \u2014 Unknown Company";

    const engagement = {
      salary: item["SALARY"],
      verification: item["VERIFICATION"],
      jobUrl: item["JOB URL"],
      fullDescription: item["FULL DESCRIPTION"],
      originalSource: item["SOURCE"],
      discovered: item["DISCOVERED"],
    };

    // Dedup-on-email / create logic
    try {
      const existing = await prisma.lead.findUnique({
        where: { email: parsedEmail },
      });

      if (existing) {
        results.skipped.push({
          item,
          reason: "Lead with this email already exists",
        });
      } else {
        const lead = await prisma.lead.create({
          data: {
            name: leadName,
            email: parsedEmail,
            companyName: companyName,
            jobTitle: jobTitle,
            location: location,
            score: score,
            status: "new",
            source: "database_search",
            engagement: engagement,
            orgId: req.orgId,
            addedById: req.user.id,
          },
        });

        await recordActivity({
          leadId: lead.id,
          userId: req.user.id,
          orgId: req.orgId,
          type: "CREATED",
          title: `${req.user.name} created this lead via Find Leads`,
        });

        results.created.push(lead);
      }
    } catch (err) {
      results.skipped.push({
        item,
        reason: `DB Error: ${err.message}`,
      });
    }
  }

  return response.success(res, results);
});

module.exports = {
  findLeads,
  getFindLeadsStatus,
  confirmFindLeads,
};