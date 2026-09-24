// Outgoing webhook dispatcher + incoming endpoint.
// Replaces the half-implemented webhookRoutes.js that depended on node-fetch.
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const response = require("../utils/response");
const { AppError } = require("../middleware/errorHandler");
const { prisma } = require("../config/postgres");

const verifySignature = (payload, signature, secret) => {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
};

const incoming = asyncHandler(async (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  const secret = process.env.WEBHOOK_INCOMING_SECRET;
  if (!signature || !secret) throw new AppError("Missing signature header.", 401);

  const raw = JSON.stringify(req.body);
  if (!verifySignature(raw, signature, secret)) {
    throw new AppError("Invalid signature.", 401);
  }

  const { event, data } = req.body;

  if (event === "EMAIL_REPLIED") {
  const {
    orgId,
    recipient,
    subject,
    messageId,
    body,
    leadId,
  } = data || {};

  if (!recipient || !body) {
    throw new AppError(
      "EMAIL_REPLIED requires recipient and body.",
      400
    );
  }

  const replyEvent = await prisma.emailEvent.create({
    data: {
      orgId: orgId || null,
      type: "REPLIED",
      recipient,
      subject: subject || null,
      messageId: messageId || null,
      metadata: {
        body,
        leadId: leadId || null,
        source: "incoming_webhook",
      },
    },
  });

  try {
    const { analyzeEmailReply } = require("../services/aiEmailService");

    let leadName = "";
    let company = "";
    let jobTitle = "";

    if (leadId) {
      const lead = await prisma.lead.findUnique({
        where: { id: Number(leadId) },
        select: {
          name: true,
          companyName: true,
          jobTitle: true,
        },
      });

      if (lead) {
        leadName = lead.name || "";
        company = lead.companyName || "";
        jobTitle = lead.jobTitle || "";
      }
    }

    const analysis = await analyzeEmailReply({
      replyBody: body,
      leadName,
      company,
      jobTitle,
    });

    await prisma.emailEvent.update({
      where: { id: replyEvent.id },
      data: {
        metadata: {
          body,
          leadId: leadId || null,
          source: "incoming_webhook",
          replyIntelligence: analysis,
        },
      },
    });
  } catch (error) {
    console.error("Reply intelligence failed:", error.message);
  }
}

  return response.success(res, {
    received: true,
    event,
    at: new Date().toISOString(),
  });
});

module.exports = { incoming };
