// Background jobs. All time-based work runs in a single scheduler with safety guards
// so a slow iteration never overlaps the next one.
const cron = require("node-cron");
const { prisma } = require("../config/postgres");
const { sendEmail } = require("../utils/sendEmail");
const { createInAppNotification } = require("../services/notificationService");
const { recordAudit } = require("../services/auditService");
const logger = require("../utils/logger");

let running = false;

const tasks = {
  // Every minute: nudge new leads that haven't been contacted.
  async followupNewLeads() {
    const leads = await prisma.lead.findMany({
      where: { status: "new", followupSent: false, createdAt: { lt: new Date(Date.now() - 60_000) } },
      take: 50,
      include: { addedBy: true },
    });
    for (const lead of leads) {
      try {
        await createInAppNotification({
          userId: lead.addedById,
          orgId: lead.orgId,
          type: "LEAD_FOLLOWUP",
          category: "lead",
          message: `Don't forget to follow up with ${lead.name}.`,
          link: `/app/leads/${lead.id}`,
          metadata: { leadId: lead.id },
        });
        await prisma.lead.update({ where: { id: lead.id }, data: { followupSent: true } });
      } catch (e) {
        logger.error("job.followup.error", { leadId: lead.id, err: e.message });
      }
    }
    if (leads.length) logger.info("job.followup", { count: leads.length });
  },
  async processSequenceEnrollments() {
  const now = new Date();

  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: {
      status: "ACTIVE",
      nextRunAt: {
        lte: now,
      },
    },
    take: 50,
  });

  for (const enrollment of enrollments) {
    try {

      const stopEvent = await prisma.emailEvent.findFirst({
        where: {
          recipient: enrollment.email,
          type: { in: ["BOUNCED", "REPLIED"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (stopEvent) {
        const stopStatus = stopEvent.type === "BOUNCED" ? "BOUNCED" : "REPLIED";

        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: stopStatus,
            nextRunAt: null,
          },
        });

        logger.info("job.sequence.stopped", {
          enrollmentId: enrollment.id,
          email: enrollment.email,
          reason: stopEvent.type,
        });

        continue;
      }
      const steps = enrollment.steps;

      if (!Array.isArray(steps) || steps.length === 0) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: "COMPLETED" },
        });
        continue;
      }

      const currentStep = steps[enrollment.currentStep];

      if (!currentStep) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: "COMPLETED" },
        });
        continue;
      }

      // Replace {{first_name}} with the lead's first name
      let firstName = "there";

if (enrollment.leadId) {
  const lead = await prisma.lead.findUnique({
    where: { id: enrollment.leadId },
    select: { name: true },
  });

  if (lead?.name) {
    firstName = lead.name.split(" ")[0];
  }
}

      const body = currentStep.body.replace(
        /{{first_name}}/gi,
        firstName
      );

      await sendEmail({
        to: enrollment.email,
        subject: currentStep.subject,
        html: body,
      });

      const nextStepIndex = enrollment.currentStep + 1;
      const nextStep = steps[nextStepIndex];

      if (!nextStep) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: "COMPLETED",
            currentStep: nextStepIndex,
            nextRunAt: null,
          },
        });
      } else {
        const nextRunAt = new Date(
          enrollment.startedAt.getTime() +
          nextStep.day * 24 * 60 * 60 * 1000
        );

        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: {
            currentStep: nextStepIndex,
            nextRunAt,
          },
        });
      }

      logger.info("job.sequence.email_sent", {
        enrollmentId: enrollment.id,
        email: enrollment.email,
        step: enrollment.currentStep,
      });

    } catch (e) {
      logger.error("job.sequence.error", {
        enrollmentId: enrollment.id,
        err: e.message,
      });
    }
  }

  if (enrollments.length) {
    logger.info("job.sequence", {
      count: enrollments.length,
    });
  }
},
  // Daily at 02:00: log a snapshot of platform metrics.
  async dailySnapshot() {
    const [users, orgs, leads, deals, activeSubs] = await Promise.all([
      prisma.user.count(),
      prisma.organization.count(),
      prisma.lead.count(),
      prisma.deal.count(),
      prisma.organization.count({ where: { plan: { in: ["STARTER", "PRO", "ENTERPRISE"] } } }),
    ]);
    await recordAudit({
      action: "system.daily_snapshot",
      entityType: "System",
      metadata: { users, orgs, leads, deals, activeSubs, date: new Date().toISOString() },
    });
    logger.info("job.snapshot", { users, orgs, leads, deals, activeSubs });
  },
};

const run = async () => {
  if (running) return;
  running = true;
  try {
    await tasks.followupNewLeads();
    await tasks.processSequenceEnrollments();
  } catch (e) {
    logger.error("job.tick.error", { err: e.message });
  } finally {
    running = false;
  }
};

const start = () => {
  if (process.env.DISABLE_CRON === "true") return;
  cron.schedule("* * * * *", run);
  cron.schedule("0 2 * * *", tasks.dailySnapshot);
  logger.info("jobs.scheduled");
};

module.exports = { start, tasks };

