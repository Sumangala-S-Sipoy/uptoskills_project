const { Queue, Worker } = require("bullmq");
const { bullmqConnection, redisClient } = require("../config/redis");
const axios = require("axios");

const queueName = "find-leads-queue";
const SCRAPER_API_URL =
  process.env.JOB_SCRAPER_URL || process.env.SCRAPER_API_URL || "http://localhost:8001";
const MAX_WAIT_MS = 10 * 60 * 1000; // stop waiting after 10 minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findLeadsQueue = new Queue(queueName, { connection: bullmqConnection });

const worker = new Worker(
  queueName,
  async (job) => {
    const { fastapiJobId } = job.data;
    const startedAt = Date.now();

    while (true) {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error("Scraping took too long. Try a smaller search.");
      }

      let data;
      try {
        const response = await axios.get(
          `${SCRAPER_API_URL}/scrape/${fastapiJobId}`,
          { timeout: 30000 }
        );
        data = response.data;
      } catch (err) {
        if (err.response && err.response.status === 404) {
          throw new Error("The scraper lost this job (it may have restarted). Please search again.");
        }
        await sleep(5000);
        continue;
      }

      if (data.status === "done") {
        const leads = data.results || [];
        await redisClient.set(
          `find-leads-result:${job.id}`,
          JSON.stringify(leads),
          { EX: 3600 }
        );
        return { status: "done", count: leads.length };
      }
      if (data.status === "error") {
        throw new Error(data.error || "Scraper failed");
      }
      await sleep(5000);
    }
  },
  { connection: bullmqConnection }
);

worker.on("failed", (job, err) => {
  console.error(`FindLeads Job ${job.id} failed with error:`, err);
});

module.exports = {
  findLeadsQueue,
};