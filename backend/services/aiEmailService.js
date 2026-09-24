const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");


const TIMEOUT = process.env.AI_TIMEOUT || 5000;

const axiosInstance = axios.create({
  timeout: TIMEOUT,
});


/*
  Outreach message generation
 */
exports.generateOutreachMessage = async ({ name, company, purpose }) => {
  try {
    const payload = {
      type: "outreach",
      prompt: `Write a short professional outreach message.
Name: ${name}
Company: ${company}
Purpose: ${purpose}`,
    };

    const response = await axiosInstance.post(AI_URL, payload);

    return {
      output: response.data.output || response.data,
    };
  } catch (error) {
    console.error("AI Outreach error:", error.message);
    throw new Error("AI outreach service unavailable");
  }
};

/*
 AI-powered campaign personalization
 */
exports.personalizeCampaignEmail = async ({
  name,
  company,
  jobTitle,
  industry,
  location,
  originalBody,
}) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const ai = new GoogleGenAI({ apiKey });

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const prompt = `Personalize the following B2B campaign email for the lead.

Lead:
Name: ${name || ""}
Company: ${company || ""}
Job Title: ${jobTitle || ""}
Industry: ${industry || ""}
Location: ${location || ""}

Original email:
${originalBody}

Rules:
- Keep the original purpose and meaning.
- Make the email sound natural and professional.
- Use only information provided about the lead.
- Do not invent facts.
- Keep approximately the same length as the original.
- Do not add a subject line.
- Return only the email body.`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const output = response.text?.trim();

    if (!output) {
      throw new Error("Gemini returned an empty response");
    }

    return { output };
  } catch (error) {
    console.error(
      "AI Campaign Personalization error:",
      error.message
    );

    throw new Error("AI campaign personalization service unavailable");
  }
};
/*
 AI-powered campaign email generation
 */
exports.generateCampaignEmail = async ({
  name,
  company,
  jobTitle,
  industry,
  location,
  purpose,
  context,
  tone = "professional",
}) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const prompt = `Generate a professional B2B sales email for the following lead.

Lead:
Name: ${name || ""}
Company: ${company || ""}
Job Title: ${jobTitle || ""}
Industry: ${industry || ""}
Location: ${location || ""}

Campaign purpose:
${purpose || ""}

Additional context:
${context || ""}

Tone:
${tone}

Rules:
- Use only the information provided.
- Do not invent facts about the lead or company.
- Keep the email concise and natural.
- Do not use generic exaggerated claims.
- Return ONLY valid JSON.
- Do not use markdown code fences.

Return exactly:
{
  "subject": "",
  "body": ""
}`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = response.text?.trim();

    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleaned);

    if (!result.subject || !result.body) {
      throw new Error("Gemini returned incomplete email data");
    }

    return {
      subject: result.subject,
      body: result.body,
    };
  } catch (error) {
    console.error(
      "AI Campaign Email Generation error:",
      error.message
    );

    throw new Error("AI campaign email generation service unavailable");
  }
};

/*
 Content summarization
 */
exports.summarizeContent = async (text) => {
  try {
    const payload = {
      type: "summarize",
      prompt: `Summarize the following text:\n${text}`,
    };

    const response = await axiosInstance.post(AI_URL, payload);

    return {
      output: response.data.output || response.data,
    };
  } catch (error) {
    console.error("AI Summary error:", error.message);
    throw new Error("AI summarization service unavailable");
  }
};
/*
 AI-powered reply intelligence
 */
exports.analyzeEmailReply = async ({
  replyBody,
  leadName,
  company,
  jobTitle,
}) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const prompt = `Analyze this incoming B2B sales email reply.

Lead:
Name: ${leadName || ""}
Company: ${company || ""}
Job Title: ${jobTitle || ""}

Reply:
${replyBody}

Return ONLY valid JSON with exactly these fields:
{
  "intent": "INTERESTED|MEETING_REQUEST|QUESTION|NOT_INTERESTED|OUT_OF_OFFICE|OTHER",
  "sentiment": "POSITIVE|NEUTRAL|NEGATIVE",
  "summary": "short summary of what the lead said",
  "suggestedAction": "short recommended next action",
  "suggestedReply": "short professional reply"
}

Rules:
- Classify only from the supplied reply.
- Do not invent facts.
- If the lead asks for a meeting, use MEETING_REQUEST.
- If the lead shows buying interest without explicitly requesting a meeting, use INTERESTED.
- If the lead asks for information or clarification, use QUESTION.
- If the lead clearly declines, use NOT_INTERESTED.
- If it is an automatic absence message, use OUT_OF_OFFICE.
- Keep summary and suggestedAction concise.
- Keep suggestedReply professional and natural.`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = response.text?.trim();

    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleaned);

    return {
      intent: result.intent,
      sentiment: result.sentiment,
      summary: result.summary,
      suggestedAction: result.suggestedAction,
      suggestedReply: result.suggestedReply,
    };
  } catch (error) {
    console.error("AI Reply Intelligence error:", error.message);
    throw new Error("AI reply intelligence service unavailable");
  }
};
