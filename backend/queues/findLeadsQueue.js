const { Queue, Worker } = require("bullmq");
const { bullmqConnection, redisClient } = require("../config/redis");
const axios = require("axios");

const queueName = "find-leads-queue";
const SCRAPER_API_URL = process.env.SCRAPER_API_URL || "http://localhost:8001";

const findLeadsQueue = new Queue(queueName, { connection: bullmqConnection });

const worker = new Worker(
  queueName,
  async (job) => {
    const { fastapiJobId } = job.data;

    while (true) {
      const response = await axios.get(`${SCRAPER_API_URL}/scrape/${fastapiJobId}`);
      const data = response.data;

      if (data.status === "done") {
        const leads = data.results || data.leads || [];
        await redisClient.set(
          `find-leads-result:${job.id}`,
          JSON.stringify(leads),
          { EX: 3600 } // Keep for 1 hour
        );
        return { status: "done", count: leads.length };
      } else if (data.status === "error") {
        throw new Error(data.error || "FastAPI scraping failed");
      }

      // Still running, wait 5 seconds before the next check
      await new Promise((resolve) => setTimeout(resolve, 5000));
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