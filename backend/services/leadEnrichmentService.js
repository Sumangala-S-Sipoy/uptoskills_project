const dns = require("dns").promises;
const crypto = require("crypto");
const axios = require("axios");

// API Keys configuration matching project environment
const API_KEYS = {
  hunter: process.env.HUNTER_API_KEY,
  clearbit: process.env.CLEARBIT_API_KEY,
  apollo: process.env.APOLLO_API_KEY,
  pdl: process.env.PDL_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};

const COMMON_FREE_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "aol.com",
  "zoho.com",
  "yandex.com",
]);

/**
 * Verify DNS, MX, SPF, DMARC records for a domain using real network resolution
 */
async function verifyDomainAndEmail(domain, email) {
  const result = {
    domain,
    email,
    isFreeEmail: false,
    mxValid: false,
    mxRecords: [],
    spfRecord: null,
    dmarcRecord: null,
    mailProvider: null,
    status: "unverified",
  };

  if (!domain) return result;

  const normalizedDomain = domain.toLowerCase().trim();
  result.isFreeEmail = COMMON_FREE_DOMAINS.has(normalizedDomain);

  try {
    const [mxResults, txtResults, dmarcResults] = await Promise.allSettled([
      dns.resolveMx(normalizedDomain),
      dns.resolveTxt(normalizedDomain),
      dns.resolveTxt(`_dmarc.${normalizedDomain}`).catch(() => []),
    ]);

    if (mxResults.status === "fulfilled" && Array.isArray(mxResults.value) && mxResults.value.length > 0) {
      result.mxValid = true;
      result.mxRecords = mxResults.value.sort((a, b) => a.priority - b.priority);

      // Detect mail provider from MX hostnames
      const mxHosts = result.mxRecords.map((r) => r.exchange.toLowerCase()).join(" ");
      if (mxHosts.includes("google") || mxHosts.includes("googlemail") || mxHosts.includes("aspmx")) {
        result.mailProvider = "Google Workspace";
      } else if (mxHosts.includes("outlook") || mxHosts.includes("protection.outlook") || mxHosts.includes("office365")) {
        result.mailProvider = "Microsoft 365";
      } else if (mxHosts.includes("protonmail") || mxHosts.includes("proton")) {
        result.mailProvider = "ProtonMail";
      } else if (mxHosts.includes("zoho")) {
        result.mailProvider = "Zoho Mail";
      } else if (mxHosts.includes("mimecast")) {
        result.mailProvider = "Mimecast";
      } else if (mxHosts.includes("barracuda")) {
        result.mailProvider = "Barracuda";
      } else {
        result.mailProvider = "Custom Mail Exchanger";
      }
    }

    if (txtResults.status === "fulfilled" && Array.isArray(txtResults.value)) {
      const flattened = txtResults.value.map((entry) => (Array.isArray(entry) ? entry.join("") : entry));
      const spf = flattened.find((r) => typeof r === "string" && r.startsWith("v=spf1"));
      if (spf) {
        result.spfRecord = spf;
      }
    }

    if (dmarcResults.status === "fulfilled" && Array.isArray(dmarcResults.value)) {
      const flattened = dmarcResults.value.map((entry) => (Array.isArray(entry) ? entry.join("") : entry));
      const dmarc = flattened.find((r) => typeof r === "string" && r.startsWith("v=DMARC1"));
      if (dmarc) {
        result.dmarcRecord = dmarc;
      }
    }

    result.status = result.mxValid ? "verified" : "no_mail_exchanger";
  } catch (error) {
    result.status = "dns_error";
    result.error = error.message;
  }

  return result;
}

/**
 * Check Gravatar for real avatar and profile data
 */
async function getGravatarData(email) {
  if (!email) return null;
  const hash = crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  const avatarUrl = `https://www.gravatar.com/avatar/${hash}?d=404`;

  try {
    // Check if avatar image exists (returns 404 if not registered)
    const imgCheck = await axios.head(avatarUrl, { timeout: 3000 });
    const hasAvatar = imgCheck.status === 200;

    let profile = null;
    try {
      const profileRes = await axios.get(`https://en.gravatar.com/${hash}.json`, {
        timeout: 3000,
        headers: { "User-Agent": "SalesForge-Lead-Enricher/1.0" },
      });
      const entry = profileRes.data?.entry?.[0];
      if (entry) {
        profile = {
          displayName: entry.displayName || null,
          aboutMe: entry.aboutMe || null,
          currentLocation: entry.currentLocation || null,
          jobTitle: entry.jobTitle || null,
          company: entry.company || null,
          verifiedAccounts: entry.verifiedAccounts || [],
          profileUrl: entry.profileUrl || null,
        };
      }
    } catch (_) {
      // Gravatar profile JSON is optional; 404 is normal if user has avatar but no public profile
    }

    return {
      avatarUrl: hasAvatar ? `https://www.gravatar.com/avatar/${hash}?d=identicon` : null,
      hasGravatar: hasAvatar,
      profile,
    };
  } catch (_) {
    return {
      avatarUrl: null,
      hasGravatar: false,
      profile: null,
    };
  }
}

/**
 * Real Clearbit enrichment if key is configured
 */
async function fetchClearbitCompany(domain) {
  if (!API_KEYS.clearbit || !domain) {
    return { status: API_KEYS.clearbit ? "no_domain" : "unconfigured", data: null };
  }
  try {
    const res = await axios.get(`https://company.clearbit.com/v2/companies/find?domain=${domain}`, {
      headers: { Authorization: `Bearer ${API_KEYS.clearbit}` },
      timeout: 6000,
    });
    return { status: "success", data: res.data };
  } catch (error) {
    return {
      status: error.response?.status === 404 ? "not_found" : "error",
      error: error.message,
      data: null,
    };
  }
}

/**
 * Real Hunter.io enrichment if key is configured
 */
async function fetchHunterEmail(email) {
  if (!API_KEYS.hunter || !email) {
    return { status: API_KEYS.hunter ? "no_email" : "unconfigured", data: null };
  }
  try {
    const res = await axios.get(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${API_KEYS.hunter}`, {
      timeout: 6000,
    });
    return { status: "success", data: res.data?.data };
  } catch (error) {
    return {
      status: error.response?.status === 404 ? "not_found" : "error",
      error: error.message,
      data: null,
    };
  }
}

/**
 * Real PeopleDataLabs person enrichment if key is configured
 */
async function fetchPdlPerson(email, name) {
  if (!API_KEYS.pdl) {
    return { status: "unconfigured", data: null };
  }
  try {
    const res = await axios.post(
      "https://api.peopledatalabs.com/v5/person/enrich",
      { email: email || undefined, name: name || undefined },
      {
        headers: { "X-Api-Key": API_KEYS.pdl, "Content-Type": "application/json" },
        timeout: 6000,
      }
    );
    return { status: "success", data: res.data?.data };
  } catch (error) {
    return {
      status: error.response?.status === 404 ? "not_found" : "error",
      error: error.message,
      data: null,
    };
  }
}

/**
 * Generate evidence-based AI insights strictly using verified data
 */
async function generateEvidenceAiInsights({ lead, dnsData, gravatarData, clearbitData, hunterData, pdlData }) {
  if (!API_KEYS.gemini) {
    return {
      status: "unconfigured",
      insights: null,
    };
  }

  // Construct factual context strictly from real evidence
  const evidence = {
    leadName: lead.name,
    email: lead.email,
    company: lead.companyName || clearbitData.data?.name || (dnsData.isFreeEmail ? null : lead.domain),
    jobTitle: lead.jobTitle || pdlData.data?.job_title || gravatarData?.profile?.jobTitle || null,
    domain: lead.domain,
    isCorporateEmail: !dnsData.isFreeEmail,
    mailHost: dnsData.mailProvider,
    mxValid: dnsData.mxValid,
    spfConfigured: Boolean(dnsData.spfRecord),
    dmarcConfigured: Boolean(dnsData.dmarcRecord),
  };

  if (clearbitData.data) {
    evidence.companyOverview = {
      name: clearbitData.data.name,
      legalName: clearbitData.data.legalName,
      industry: clearbitData.data.category?.industry || clearbitData.data.category?.sector,
      employeeCount: clearbitData.data.metrics?.employees,
      location: clearbitData.data.location,
      description: clearbitData.data.description,
    };
  }

  if (pdlData.data) {
    evidence.personDetails = {
      headline: pdlData.data.job_title,
      company: pdlData.data.job_company_name,
      skills: pdlData.data.skills?.slice(0, 10),
      location: pdlData.data.location_name,
    };
  }

  if (hunterData.data) {
    evidence.emailDeliverability = {
      score: hunterData.data.score,
      status: hunterData.data.status,
      deliverable: hunterData.data.result,
    };
  }

  const prompt = `
You are a B2B sales intelligence research assistant.
Analyze ONLY the supplied real enrichment evidence.

Strict Rules:
- Never invent facts, company names, revenue numbers, or job positions.
- If information is not in the evidence, state that it is unavailable.
- Do not assume tech stack or budget unless explicitly mentioned.
- Opportunity score must be an integer between 0 and 100 based strictly on verified signal strength (e.g. corporate vs personal email, mail deliverability, verified role/domain).

Return ONLY valid JSON matching this schema:
{
  "summary": "1-2 sentence factual summary based strictly on the provided evidence",
  "opportunityScore": 75,
  "scoreFactors": ["Factor 1 based on real data", "Factor 2 based on real data"],
  "salesInsights": ["Insight 1 grounded in real data", "Insight 2 grounded in real data"],
  "suggestedActions": [
    { "action": "Action Name", "description": "Specific action referencing real attributes" }
  ],
  "personalizedIcebreaker": "A 1-2 sentence personalized message opener referencing strictly verified attributes"
}

Evidence:
${JSON.stringify(evidence, null, 2)}
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEYS.gemini}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    const res = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { status: "empty_response", insights: null };
    }

    const parsed = JSON.parse(text);
    return { status: "success", insights: parsed };
  } catch (error) {
    console.error("[Enrichment:Gemini] AI insights error:", error.message);
    return { status: "error", error: error.message, insights: null };
  }
}

/**
 * Main Lead Enrichment Orchestrator
 * Strictly consumes real sources, never fabricates data, returns complete enrichment payload
 */
async function enrichLeadRecord(lead) {
  if (!lead || !lead.email) {
    throw new Error("Lead with a valid email is required for enrichment.");
  }

  const email = lead.email.toLowerCase().trim();
  let domain = lead.domain ? lead.domain.toLowerCase().trim() : null;

  // Extract domain from email if not already present
  if (!domain && email.includes("@")) {
    domain = email.split("@")[1]?.trim();
  }

  // 1. Concurrently run real network and provider lookups
  const [dnsData, gravatarData, clearbitRes, hunterRes, pdlRes] = await Promise.all([
    verifyDomainAndEmail(domain, email),
    getGravatarData(email),
    fetchClearbitCompany(domain),
    fetchHunterEmail(email),
    fetchPdlPerson(email, lead.name),
  ]);

  // 2. Synthesize AI insights strictly from real data
  const aiResult = await generateEvidenceAiInsights({
    lead,
    dnsData,
    gravatarData,
    clearbitData: clearbitRes,
    hunterData: hunterRes,
    pdlData: pdlRes,
  });

  // 3. Determine fields that can be safely updated on the Lead model
  // Only persist real, verified data where current lead fields are null or empty
  const fieldUpdates = {};

  if (!lead.domain && domain && !dnsData.isFreeEmail) {
    fieldUpdates.domain = domain;
  }

  if (!lead.companyName) {
    if (clearbitRes.data?.name) {
      fieldUpdates.companyName = clearbitRes.data.name;
    } else if (pdlRes.data?.job_company_name) {
      fieldUpdates.companyName = pdlRes.data.job_company_name;
    } else if (gravatarData?.profile?.company) {
      fieldUpdates.companyName = gravatarData.profile.company;
    } else if (domain && !dnsData.isFreeEmail) {
      // Derive readable company name from clean domain if no provider exists
      const cleanName = domain.split(".")[0];
      if (cleanName && cleanName.length > 1) {
        fieldUpdates.companyName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      }
    }
  }

  if (!lead.jobTitle) {
    if (pdlRes.data?.job_title) {
      fieldUpdates.jobTitle = pdlRes.data.job_title;
    } else if (gravatarData?.profile?.jobTitle) {
      fieldUpdates.jobTitle = gravatarData.profile.jobTitle;
    }
  }

  if (!lead.location) {
    if (pdlRes.data?.location_name) {
      fieldUpdates.location = pdlRes.data.location_name;
    } else if (gravatarData?.profile?.currentLocation) {
      fieldUpdates.location = gravatarData.profile.currentLocation;
    } else if (clearbitRes.data?.geo?.city && clearbitRes.data?.geo?.country) {
      fieldUpdates.location = `${clearbitRes.data.geo.city}, ${clearbitRes.data.geo.country}`;
    }
  }

  if (!lead.companyLocation && clearbitRes.data?.location) {
    fieldUpdates.companyLocation = clearbitRes.data.location;
  }

  if (!lead.industry && clearbitRes.data?.category?.industry) {
    fieldUpdates.industry = clearbitRes.data.category.industry;
  }

  if (!lead.companySize && clearbitRes.data?.metrics?.employees) {
    fieldUpdates.companySize = String(clearbitRes.data.metrics.employees);
  }

  if (!lead.skills && pdlRes.data?.skills?.length) {
    fieldUpdates.skills = pdlRes.data.skills.slice(0, 8).join(", ");
  }

  // 4. Build comprehensive enrichment payload
  const enrichmentPayload = {
    enrichedAt: new Date().toISOString(),
    status: "completed",
    leadId: lead.id,
    sources: {
      dns: {
        status: dnsData.status,
        configured: true,
        mailProvider: dnsData.mailProvider,
        mxRecordsCount: dnsData.mxRecords.length,
        spfConfigured: Boolean(dnsData.spfRecord),
        dmarcConfigured: Boolean(dnsData.dmarcRecord),
        isFreeEmail: dnsData.isFreeEmail,
      },
      gravatar: {
        status: gravatarData.hasGravatar ? "found" : "not_found",
        configured: true,
        hasAvatar: gravatarData.hasGravatar,
        avatarUrl: gravatarData.avatarUrl,
        hasProfile: Boolean(gravatarData.profile),
      },
      clearbit: {
        status: clearbitRes.status,
        configured: Boolean(API_KEYS.clearbit),
      },
      hunter: {
        status: hunterRes.status,
        configured: Boolean(API_KEYS.hunter),
      },
      pdl: {
        status: pdlRes.status,
        configured: Boolean(API_KEYS.pdl),
      },
      geminiAi: {
        status: aiResult.status,
        configured: Boolean(API_KEYS.gemini),
      },
    },
    verification: {
      emailDeliverability: dnsData.mxValid ? "deliverable" : "unknown",
      mailProvider: dnsData.mailProvider,
      isCorporateDomain: !dnsData.isFreeEmail,
      mxRecords: dnsData.mxRecords,
      spf: dnsData.spfRecord,
      dmarc: dnsData.dmarcRecord,
      hunterVerification: hunterRes.data || null,
    },
    companyIntel: clearbitRes.data || null,
    personIntel: {
      gravatar: gravatarData.profile || null,
      avatarUrl: gravatarData.avatarUrl,
      pdl: pdlRes.data || null,
    },
    aiInsights: aiResult.insights || null,
    appliedFields: Object.keys(fieldUpdates),
  };

  return {
    fieldUpdates,
    enrichmentPayload,
  };
}

module.exports = {
  enrichLeadRecord,
  verifyDomainAndEmail,
  getGravatarData,
  API_KEYS,
};
