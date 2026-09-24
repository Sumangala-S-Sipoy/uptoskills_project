const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");

const { prisma } = require("../config/postgres");
const auditService = require("../services/auditService");
const usageService = require("../services/usageService");
const webhookService = require("../services/webhookService");
const leadActivityService = require("../services/leadActivityService");

mock.method(auditService, "recordAudit", async () => {});
mock.method(usageService, "incrementUsage", async () => {});
mock.method(webhookService, "publish", async () => {});
mock.method(leadActivityService, "recordActivity", async () => {});

// Reassign Prisma properties with mock.fn
prisma.lead = {
  findFirst: mock.fn(async () => null),
  findUnique: mock.fn(async () => null),
  findMany: mock.fn(async () => []),
  update: mock.fn(async () => ({})),
  count: mock.fn(async () => 0),
};
prisma.emailEvent = {
  findMany: mock.fn(async () => []),
};

const leadEnrichmentService = require("../services/leadEnrichmentService");
const leadController = require("../controllers/leadController");
const { AppError } = require("../middleware/errorHandler");

const mockRes = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const res = {
    statusCode: 200,
    jsonData: null,
    promise,
  };
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (data) {
    this.jsonData = data;
    resolve(this);
    return this;
  };
  return res;
};

const mockNext = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const next = mock.fn((err) => {
    resolve(err);
  });
  next.promise = promise;
  return next;
};

test("Lead Enrichment Unit Tests", async (t) => {
  await t.test("verifyDomainAndEmail - identifies free email providers without errors", async () => {
    const res = await leadEnrichmentService.verifyDomainAndEmail("gmail.com", "test@gmail.com");
    assert.strictEqual(res.isFreeEmail, true);
    assert.strictEqual(res.domain, "gmail.com");
  });

  await t.test("enrichLeadRecord - extracts domain from email and avoids inventing false facts", async () => {
    const mockLead = {
      id: 101,
      email: "contact@salesforge.ai",
      name: "Jordan Lee",
      domain: null,
      companyName: null,
      jobTitle: null,
      location: null,
    };

    const result = await leadEnrichmentService.enrichLeadRecord(mockLead);

    assert.ok(result.enrichmentPayload, "Enrichment payload must exist");
    assert.strictEqual(result.enrichmentPayload.leadId, 101);
    assert.ok(result.enrichmentPayload.sources, "Must report data sources status");
    assert.ok(result.enrichmentPayload.verification, "Must include verification details");

    // In the absence of external API keys, status should indicate unconfigured or not found rather than fabricated data
    if (!leadEnrichmentService.API_KEYS.clearbit) {
      assert.strictEqual(result.enrichmentPayload.sources.clearbit.configured, false);
      assert.strictEqual(result.enrichmentPayload.sources.clearbit.status, "unconfigured");
    }
    if (!leadEnrichmentService.API_KEYS.hunter) {
      assert.strictEqual(result.enrichmentPayload.sources.hunter.configured, false);
    }
  });

  await t.test("enrichLeadRecord - throws error when lead has no email", async () => {
    await assert.rejects(
      async () => {
        await leadEnrichmentService.enrichLeadRecord({});
      },
      {
        message: "Lead with a valid email is required for enrichment.",
      }
    );
  });
});

test("Lead Enrichment Controller & Tenant Isolation", async (t) => {
  await t.test("enrichLead - throws 404 AppError if lead not found or belongs to another org", async () => {
    prisma.lead.findFirst.mock.mockImplementationOnce(async () => null);

    const req = {
      params: { id: "999" },
      orgId: 1,
      user: { id: 10, name: "Test User" },
    };
    const res = mockRes();
    const next = mockNext();

    await leadController.enrichLead(req, res, next);
    const err = await next.promise;

    assert.ok(err instanceof AppError);
    assert.strictEqual(err.statusCode, 404);
    assert.strictEqual(err.message, "Lead not found.");
  });

  await t.test("enrichLead - enriches lead, updates database with verified fields, and returns payload", async () => {
    const existingLead = {
      id: 42,
      orgId: 5,
      name: "Jane Doe",
      email: "jane@acmecorp.org",
      domain: null,
      companyName: null,
      jobTitle: null,
      scoreDetails: { initialScore: 10 },
      engagement: {},
    };

    prisma.lead.findFirst.mock.mockImplementationOnce(async ({ where }) => {
      assert.strictEqual(where.id, 42);
      assert.strictEqual(where.orgId, 5);
      return existingLead;
    });

    prisma.lead.update.mock.mockImplementationOnce(async ({ where, data }) => {
      assert.strictEqual(where.id, 42);
      assert.ok(data.scoreDetails.enrichment, "Must persist enrichment object in scoreDetails");
      return {
        ...existingLead,
        ...data,
      };
    });

    const req = {
      params: { id: "42" },
      orgId: 5,
      user: { id: 10, name: "Alex Admin" },
    };
    const res = mockRes();
    const next = mockNext();

    leadController.enrichLead(req, res, next);
    await Promise.race([res.promise, next.promise]);
    const responseData = res.jsonData;

    assert.ok(responseData, "Response data must be sent");
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.data.id, 42);
    assert.ok(responseData.data.enrichment, "Response must include enrichment data");
    assert.strictEqual(responseData.data.enrichment.leadId, 42);
    assert.strictEqual(responseData.data.enrichment.status, "completed");
  });

  await t.test("getLeadById - includes enrichment object in response", async () => {
    const enrichedLead = {
      id: 55,
      orgId: 3,
      name: "Sam Smith",
      email: "sam@example.com",
      scoreDetails: {
        enrichment: {
          status: "completed",
          verification: { emailDeliverability: "deliverable" },
        },
      },
      engagement: {},
    };

    prisma.lead.findFirst.mock.mockImplementationOnce(async () => enrichedLead);
    prisma.emailEvent.findMany.mock.mockImplementationOnce(async () => []);

    const req = {
      params: { id: "55" },
      orgId: 3,
      user: { id: 1, name: "Reader" },
    };
    const res = mockRes();
    const next = mockNext();

    leadController.getLeadById(req, res, next);
    await Promise.race([res.promise, next.promise]);
    const responseData = res.jsonData;

    assert.ok(responseData.success);
    assert.ok(responseData.data.enrichment);
    assert.strictEqual(responseData.data.enrichment.status, "completed");
    assert.strictEqual(responseData.data.enrichment.verification.emailDeliverability, "deliverable");
  });
});
