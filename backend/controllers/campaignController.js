// Campaign management - marketing automation and email campaigns.
const { prisma } = require("../config/postgres");
const { AppError } = require("../middleware/errorHandler");
const asyncHandler = require("../utils/asyncHandler");
const response = require("../utils/response");
const { recordAudit } = require("../services/auditService");
const { invalidateCache } = require("../utils/cache");

// Campaigns are stored using the existing Workflow model with JSON metadata.
// This provides full campaign management without new schema.

const CAMPAIGN_STATUSES = ["draft", "scheduled", "running", "paused", "completed", "cancelled"];
const CAMPAIGN_TYPES = ["email", "sms", "social", "webhook", "multi_channel"];

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status, type } = req.query;
  const where = { orgId: req.orgId };
  // Workflow model has 'active' (Boolean), not 'status' (String)
  if (status) where.active = (status === "running");
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.workflow.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: Number(limit) }),
    prisma.workflow.count({ where }),
  ]);
  return response.paginated(res, items, total, page, limit);
});

const get = asyncHandler(async (req, res) => {
  const campaign = await prisma.workflow.findFirst({ where: { id: Number(req.params.id), orgId: req.orgId } });
  if (!campaign) throw new AppError("Campaign not found.", 404);
  return response.success(res, campaign);
});

const create = asyncHandler(async (req, res) => {
  const {
  name,
  description,
  subject,
  body,
  audience,
  steps,
  type = "email",
  status = "draft",
  segment,
  content,
  schedule,
  budget,
} = req.body;
  if (!name) throw new AppError("name is required.", 400);
  // WorkflowTrigger enum: use "SCHEDULED_TIME" as the default campaign trigger.
  // Store the campaign type inside the conditions JSON object.
  const campaign = await prisma.workflow.create({
    data: {
      orgId: req.orgId,
      userId: req.user.id,
      name, description: description || null,
      trigger: "SCHEDULED_TIME",
      conditions: {
  segment: segment || null,
  subject: subject || steps?.[0]?.subject || "",
  body: body || steps?.[0]?.body || "",
  audience: audience || "all",
  steps: steps || [
    {
      day: 0,
      subject: subject || "",
      body: body || "",
    },
  ],
  type,
  schedule: schedule || null,
  budget: budget || null,
},
      actions: content || [{ type: "SEND_EMAIL" }],
      active: status === "running",
    },
  });
  await recordAudit({ userId: req.user.id, orgId: req.orgId, action: "campaign.create", entityType: "Campaign", entityId: campaign.id, metadata: { name, type, status } });
  invalidateCache("/campaigns");
  return response.created(res, campaign);
});

const update = asyncHandler(async (req, res) => {
  const {
  name,
  description,
  subject,
  body,
  audience,
  steps,
  status,
  segment,
  content,
  budget,
  } = req.body;
  const campaign = await prisma.workflow.findFirst({ where: { id: Number(req.params.id), orgId: req.orgId } });
  if (!campaign) throw new AppError("Campaign not found.", 404);
  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (status !== undefined) data.active = status === "running";
  if (
  segment !== undefined ||
  budget !== undefined ||
  subject !== undefined ||
  body !== undefined ||
  audience !== undefined ||
  steps !== undefined
  ) {
  const existingConditions =
    (typeof campaign.conditions === "object" && campaign.conditions)
      ? campaign.conditions
      : {};
  if (segment !== undefined)
    existingConditions.segment = segment;
  if (budget !== undefined)
    existingConditions.budget = budget;
  if (subject !== undefined)
    existingConditions.subject = subject;
  if (body !== undefined)
  existingConditions.body = body;
  if (steps !== undefined)
  existingConditions.steps = steps;
  if (audience !== undefined)
    existingConditions.audience = audience;
  data.conditions = existingConditions;
  }
  if (content !== undefined) data.actions = content;
  await prisma.workflow.update({ where: { id: campaign.id }, data });
  invalidateCache("/campaigns");
  return response.success(res, { message: "Campaign updated." });
  });

const remove = asyncHandler(async (req, res) => {
  const result = await prisma.workflow.deleteMany({ where: { id: Number(req.params.id), orgId: req.orgId } });
  if (result.count === 0) throw new AppError("Campaign not found.", 404);
  invalidateCache("/campaigns");
  return response.success(res, { message: "Campaign deleted." });
});

const launch = asyncHandler(async (req, res) => {
  const campaign = await prisma.workflow.findFirst({
    where: {
      id: Number(req.params.id),
      orgId: req.orgId,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found.", 404);
  }

  if (campaign.conditions?.status === "running") {
  throw new AppError("Campaign is already running.", 400);
}

  const conditions =
    typeof campaign.conditions === "object" && campaign.conditions
      ? campaign.conditions
      : {};

  const subject = conditions.subject || "";
  const body = conditions.body || "";
  const audience = conditions.audience || "all";

  const campaignSteps = Array.isArray(conditions.steps)
  ? conditions.steps
  : [
      {
        day: 0,
        subject,
        body,
      },
    ];




  if (!subject) {
    throw new AppError("Campaign subject is required.", 400);
  }

  if (!body) {
    throw new AppError("Campaign email body is required.", 400);
  }

  // Get leads for this campaign
  let leads;

  if (audience === "all") {
    leads = await prisma.lead.findMany({
  where: {
    orgId: req.orgId,
  },
  select: {
    id: true,
    name: true,
    email: true,
  },
});
  } else {
    throw new AppError(
      "Only the 'all' audience is currently supported.",
      400
    );
  }

  if (leads.length === 0) {
    throw new AppError("No leads with email addresses found.", 400);
  }
  const sequence = await prisma.sequence.create({
  data: {
    orgId: req.orgId,
    userId: req.user.id,
    name: `Campaign: ${campaign.name}`,
    description: campaign.description || null,
    status: "ACTIVE",
    steps: campaignSteps,
  },
});

  // Create an enrollment for each lead
  for (const lead of leads) {
  await prisma.sequenceEnrollment.create({
    data: {
      sequenceId: sequence.id,
      leadId: lead.id,
      email: lead.email,
      status: "ACTIVE",
      currentStep: 0,
      steps: campaignSteps,
      nextRunAt: new Date(),
    },
  });
}

  await prisma.workflow.update({
  where: { id: campaign.id },
  data: {
    active: true,
    conditions: {
      ...conditions,
      status: "running",
    },
    runCount: { increment: 1 },
    lastRunAt: new Date(),
  },
});

  invalidateCache("/campaigns");

  return response.success(res, {
    message: "Campaign launched.",
    enrolled: leads.length,
  });
});

const pause = asyncHandler(async (req, res) => {
  const campaign = await prisma.workflow.findFirst({
    where: {
      id: Number(req.params.id),
      orgId: req.orgId,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found.", 404);
  }

  const sequence = await prisma.sequence.findFirst({
    where: {
      orgId: req.orgId,
      name: `Campaign: ${campaign.name}`,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  await prisma.workflow.update({
    where: {
      id: campaign.id,
    },
    data: {
  active: false,
  conditions: {
    ...(typeof campaign.conditions === "object" && campaign.conditions
      ? campaign.conditions
      : {}),
    status: "paused",
  },
},
  });

  if (sequence) {
    await prisma.sequenceEnrollment.updateMany({
      where: {
        sequenceId: sequence.id,
        status: "ACTIVE",
      },
      data: {
        status: "PAUSED",
      },
    });

    await prisma.sequence.update({
      where: {
        id: sequence.id,
      },
      data: {
        status: "PAUSED",
      },
    });
  }

  invalidateCache("/campaigns");

  return response.success(res, {
    message: "Campaign paused.",
  });
});

const resume = asyncHandler(async (req, res) => {
  const campaign = await prisma.workflow.findFirst({
    where: {
      id: Number(req.params.id),
      orgId: req.orgId,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found.", 404);
  }

  const sequence = await prisma.sequence.findFirst({
    where: {
      orgId: req.orgId,
      name: `Campaign: ${campaign.name}`,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

 await prisma.workflow.update({
  where: {
    id: campaign.id,
  },
  data: {
    active: true,
    conditions: {
      ...(typeof campaign.conditions === "object" && campaign.conditions
        ? campaign.conditions
        : {}),
      status: "running",
    },
  },
});

  if (sequence) {
    await prisma.sequenceEnrollment.updateMany({
      where: {
        sequenceId: sequence.id,
        status: "PAUSED",
      },
      data: {
        status: "ACTIVE",
      },
    });

    await prisma.sequence.update({
      where: {
        id: sequence.id,
      },
      data: {
        status: "ACTIVE",
      },
    });
  }

  invalidateCache("/campaigns");

  return response.success(res, {
    message: "Campaign resumed.",
  });
});

const stop = asyncHandler(async (req, res) => {
  const campaign = await prisma.workflow.findFirst({
    where: {
      id: Number(req.params.id),
      orgId: req.orgId,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found.", 404);
  }

  const sequence = await prisma.sequence.findFirst({
    where: {
      orgId: req.orgId,
      name: `Campaign: ${campaign.name}`,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  await prisma.workflow.update({
    where: {
      id: campaign.id,
    },
    data: {
      active: false,
      conditions: {
        ...(typeof campaign.conditions === "object" && campaign.conditions
          ? campaign.conditions
          : {}),
        status: "cancelled",
      },
    },
  });

  if (sequence) {
    await prisma.sequenceEnrollment.updateMany({
      where: {
        sequenceId: sequence.id,
        status: {
          in: ["ACTIVE", "PAUSED"],
        },
      },
      data: {
        status: "STOPPED",
      },
    });

    await prisma.sequence.update({
      where: {
        id: sequence.id,
      },
      data: {
        status: "ARCHIVED",
      },
    });
  }

  invalidateCache("/campaigns");

  return response.success(res, {
    message: "Campaign stopped.",
  });
});

const metrics = asyncHandler(async (req, res) => {
  const campaigns = await prisma.workflow.findMany({
    where: { orgId: req.orgId },
    select: {
      id: true,
      active: true,
      conditions: true,
      runCount: true,
      lastRunAt: true,
      trigger: true,
    },
  });

  let running = 0;
  let paused = 0;
  let totalRuns = 0;

  for (const c of campaigns) {
    const status =
      typeof c.conditions === "object" && c.conditions
        ? c.conditions.status
        : null;

    if (status === "running") running++;
    if (status === "paused") paused++;

    totalRuns += c.runCount || 0;
  }

  return response.success(res, {
    total: campaigns.length,
    running,
    paused,
    totalRuns,
  });
});
const optimization = asyncHandler(async (req, res) => {
  const campaigns = await prisma.workflow.findMany({
    where: { orgId: req.orgId },
    select: {
      id: true,
      name: true,
      conditions: true,
    },
  });

  const sequences = await prisma.sequence.findMany({
    where: { orgId: req.orgId },
    select: {
      id: true,
      name: true,
      steps: true,
    },
  });

  const sequenceByName = new Map(
    sequences.map((sequence) => [sequence.name, sequence])
  );

  const results = [];

  for (const campaign of campaigns) {
    const sequence = sequenceByName.get(`Campaign: ${campaign.name}`);

    if (!sequence) {
      continue;
    }

    const sentEvents = await prisma.emailEvent.findMany({
      where: {
        orgId: req.orgId,
        type: "SENT",
        metadata: {
          path: ["sequenceId"],
          equals: sequence.id,
        },
      },
      select: {
        id: true,
        messageId: true,
        subject: true,
        metadata: true,
      },
    });

    if (sentEvents.length === 0) {
      results.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        sequenceId: sequence.id,
        sent: 0,
        opened: 0,
        clicked: 0,
        replied: 0,
        openRate: 0,
        clickRate: 0,
        replyRate: 0,
        recommendations: ["No attributed email data yet."],
      });
      continue;
    }

    const messageIds = sentEvents
      .map((event) => event.messageId)
      .filter(Boolean);

    const engagementEvents = await prisma.emailEvent.findMany({
      where: {
        orgId: req.orgId,
        messageId: { in: messageIds },
        type: {
          in: ["OPENED", "CLICKED", "REPLIED"],
        },
      },
      select: {
        messageId: true,
        type: true,
        metadata: true,
      },
    });

    const uniqueByType = (type) =>
      new Set(
        engagementEvents
          .filter((event) => event.type === type && event.messageId)
          .map((event) => event.messageId)
      ).size;

    const opened = uniqueByType("OPENED");
    const clicked = uniqueByType("CLICKED");
    const replied = uniqueByType("REPLIED");

    const sent = sentEvents.length;

    const openRate = Math.round((opened / sent) * 100);
    const clickRate = Math.round((clicked / sent) * 100);
    const replyRate = Math.round((replied / sent) * 100);

    const recommendations = [];

    if (openRate < 20) {
      recommendations.push(
        "Test stronger or more personalized subject lines."
      );
    }

    if (openRate >= 20 && clickRate < 5) {
      recommendations.push(
        "Improve email body relevance and strengthen the call to action."
      );
    }

    if (clickRate >= 5 && replyRate < 3) {
      recommendations.push(
        "Add a clearer conversational CTA to encourage replies."
      );
    }

    if (replyRate >= 3) {
      recommendations.push(
        "This campaign is generating replies; consider expanding its audience."
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        "Continue monitoring performance and test one variable at a time."
      );
    }

    results.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      sequenceId: sequence.id,
      sent,
      opened,
      clicked,
      replied,
      openRate,
      clickRate,
      replyRate,
      recommendations,
    });
  }

  return response.success(res, {
    campaigns: results,
    generatedAt: new Date(),
  });
});
module.exports = {
  list,
  get,
  create,
  update,
  remove,
  launch,
  pause,
  resume,
  stop,
  metrics,
  optimization,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES
};
