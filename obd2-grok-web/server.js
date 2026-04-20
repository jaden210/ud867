const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const GROK_API_KEY = process.env.GROK_API_KEY || "";
const GROK_API_BASE_URL = process.env.GROK_API_BASE_URL || "https://api.x.ai/v1";
const GROK_MODEL = process.env.GROK_MODEL || "grok-4.3";
const SEARCH_PROXY_BASE = "https://r.jina.ai/http://duckduckgo.com/html/?q=";
const OFFICIAL_SOURCE_HINTS = [
  "Factory service manual (OEM)",
  "Official OEM TSB / service bulletin",
  "Manufacturer wiring diagram documentation",
  "Official OBD-II PID and DTC references from SAE/OEM docs",
];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseLikelyDtc(telemetry = []) {
  const latest = telemetry?.[telemetry.length - 1];
  const dtcs = Array.isArray(latest?.dtcs) ? latest.dtcs : [];
  return dtcs.find((code) => typeof code === "string" && /^[PCBU][0-9A-F]{4}$/i.test(code)) || null;
}

function detectQueryTopic({ messages = [], telemetry = [] }) {
  const dtc = parseLikelyDtc(telemetry);
  if (dtc) {
    return { kind: "dtc", value: dtc.toUpperCase() };
  }

  const lastUserText =
    messages
      .slice()
      .reverse()
      .find((entry) => entry?.role === "user" && typeof entry?.content === "string")
      ?.content || "";

  const token = lastUserText.match(/\b([A-Z]{1,4}[0-9]{2,4}|misfire|stall|overheat|rough\s+idle|no\s+start)\b/i);
  if (token) {
    return { kind: "symptom", value: token[0].trim() };
  }
  return { kind: "general", value: "obd2 diagnostics" };
}

function decodeDuckDuckGoRedirect(url) {
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get("uddg");
    if (!uddg) {
      return url;
    }
    return decodeURIComponent(uddg);
  } catch (_error) {
    return url;
  }
}

function classifySource(link) {
  let host = "";
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch (_error) {
    return "unknown";
  }
  const forumKeywords = ["forum", "club", "nation", "reddit", "stackexchange", "thread", "groups"];
  if (forumKeywords.some((value) => host.includes(value))) {
    return "forum";
  }
  if (host.includes("toyota.com") || host.includes("ford.com") || host.includes("honda.com") || host.includes("gm.com") || host.includes("sae.org")) {
    return "official";
  }
  if (host.includes(".gov")) {
    return "official";
  }
  return "other";
}

function parseSearchResults(markdownText = "") {
  const lines = markdownText.split("\n");
  const results = [];
  for (const line of lines) {
    const match = line.match(/## \[(.+?)\]\((http[^)]+)\)/);
    if (!match) {
      continue;
    }
    const title = match[1].trim();
    const rawUrl = match[2].trim();
    const decodedUrl = decodeDuckDuckGoRedirect(rawUrl);
    results.push({
      title,
      url: decodedUrl,
      sourceType: classifySource(decodedUrl),
    });
  }
  return results;
}

async function fetchLookupResults(query) {
  const encoded = encodeURIComponent(query);
  const response = await fetch(`${SEARCH_PROXY_BASE}${encoded}`);
  if (!response.ok) {
    throw new Error(`Lookup search failed with ${response.status}`);
  }
  const body = await response.text();
  return parseSearchResults(body);
}

function pickLookupSource(results = []) {
  const official = results.find((entry) => entry.sourceType === "official");
  if (official) {
    return { source: "official-rag", candidate: official };
  }
  const forum = results.find((entry) => entry.sourceType === "forum");
  if (forum) {
    return { source: "community-fallback", candidate: forum };
  }
  const fallback = results[0];
  if (fallback) {
    return { source: "community-fallback", candidate: fallback };
  }
  return { source: "none", candidate: null };
}

function sourceDisclosureLine(lookupSource, lookupCandidate) {
  if (lookupSource === "official-rag" && lookupCandidate) {
    return `Source note: Official reference (${lookupCandidate.title}) - ${lookupCandidate.url}`;
  }
  if (lookupSource === "community-fallback" && lookupCandidate) {
    return `Source note: Third-party forum/community reference (${lookupCandidate.title}) - ${lookupCandidate.url}. Treat as less authoritative than OEM documentation.`;
  }
  return "Source note: No matched official/manual source found in lookup.";
}

function trimMessages(messages = []) {
  return messages
    .filter((entry) => entry && typeof entry.content === "string")
    .slice(-16)
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      content: entry.content.trim().slice(0, 800),
    }));
}

function summarizeTelemetry(telemetry = []) {
  const recent = telemetry.slice(-8);
  if (!recent.length) {
    return "No OBD-II telemetry frames available yet.";
  }

  const latest = recent[recent.length - 1];
  const avg = (field) => {
    const values = recent
      .map((frame) => frame[field])
      .filter((value) => Number.isFinite(value));
    if (!values.length) {
      return null;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return [
    `Latest frame: rpm=${latest.rpm ?? "n/a"}, speedKph=${latest.speedKph ?? "n/a"}, coolantTempC=${latest.coolantTempC ?? "n/a"}, throttlePct=${latest.throttlePct ?? "n/a"}.`,
    `Recent averages: rpm=${Math.round(avg("rpm") ?? 0)}, speedKph=${Math.round(avg("speedKph") ?? 0)}, coolantTempC=${Math.round(avg("coolantTempC") ?? 0)}, throttlePct=${Math.round(avg("throttlePct") ?? 0)}.`,
    `Current DTCs: ${Array.isArray(latest.dtcs) && latest.dtcs.length ? latest.dtcs.join(", ") : "none detected"}.`,
  ].join("\n");
}

function createFallbackReply({ messages, telemetry, eventContext }) {
  const latest = telemetry?.[telemetry.length - 1] || {};
  const issues = [];

  if (Number.isFinite(latest.coolantTempC) && latest.coolantTempC >= 105) {
    issues.push(
      "Coolant temperature is elevated. Reduce load, verify radiator fan operation, and check coolant level once the engine is cool."
    );
  }

  if (Number.isFinite(latest.rpm) && latest.rpm > 3000 && (latest.speedKph ?? 0) < 5) {
    issues.push("RPM is high while vehicle speed is low. Inspect for throttle or idle control issues.");
  }

  if (Array.isArray(latest.dtcs) && latest.dtcs.length) {
    issues.push(`Trouble codes found: ${latest.dtcs.join(", ")}. Prioritize fixing stored DTCs first.`);
  }

  if (!issues.length) {
    issues.push("No immediate fault pattern detected in the recent frames. Continue monitoring under varied load.");
  }

  const lastUserPrompt = messages?.[messages.length - 1]?.content;
  const contextLine = eventContext ? `Event context: ${eventContext}` : "";
  const userLine = lastUserPrompt ? `Driver question: ${lastUserPrompt}` : "";

  return [
    "OBD2S fallback mode active (no live model/manual lookup).",
    contextLine,
    userLine,
    "Quick take:",
    ...issues.map((issue, index) => `${index + 1}) ${issue}`),
    "Source note: fallback output is local heuristic logic, not a retrieved manual excerpt.",
    "Next: Want quick checks or deeper explanation?",
  ]
    .filter(Boolean)
    .join("\n");
}

async function queryGrok({ messages, telemetry, eventContext, sourceContext }) {
  const telemetrySummary = summarizeTelemetry(telemetry);
  const safeMessages = trimMessages(messages);

  const systemPrompt = [
    "You are OBD2S Copilot, an automotive diagnostics assistant reading OBD-II telemetry from a live scanner.",
    "Default to short punchy responses. Keep it practical, concise, and friendly with a lightly playful tone about being the upgraded 'S' model.",
    "Never be silly at the expense of clarity or safety.",
    "Only provide longer explanations when the user explicitly asks for details or safety requires it.",
    "Always include: (1) interpretation, (2) likely causes, (3) immediate safe next checks.",
    "Include source transparency in every answer.",
    "Source policy: first rely on official documentation such as OEM service manuals/TSBs/wiring docs/SAE-style specs.",
    "If official documentation is unavailable, you may use forum/community info but you must explicitly label it as third-party and less authoritative.",
    "Never present forum info as official.",
    "End with one proactive follow-up question that moves diagnosis forward.",
    "If data is incomplete, say exactly what PID or observation is missing.",
    "Never invent trouble codes that are not present.",
    "Use this compact structure:",
    "1) Quick take",
    "2) Likely causes",
    "3) Do now",
    "4) Source note (Official or Third-party forum)",
    "5) Next question",
  ].join(" ");

  const contextPrompt = [
    `Telemetry summary:\n${telemetrySummary}`,
    eventContext ? `Trigger event: ${eventContext}` : "",
    sourceContext ? `Lookup source context:\n${sourceContext}` : "",
    `Official source preference list: ${OFFICIAL_SOURCE_HINTS.join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const conversation = [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextPrompt },
    ...safeMessages,
  ];

  const response = await fetch(`${GROK_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: conversation,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error("Grok API returned an empty response.");
  }

  return reply;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: GROK_MODEL,
    grokConfigured: Boolean(GROK_API_KEY),
    responseStyle: "short-punchy-default",
    sourcePolicy: "official-first-then-forum-with-disclosure",
  });
});

app.post("/api/chat", async (req, res) => {
  const { messages = [], telemetry = [], eventContext = "" } = req.body || {};

  try {
    if (!Array.isArray(messages) || !Array.isArray(telemetry)) {
      return res.status(400).json({ error: "messages and telemetry must be arrays" });
    }

    const topic = detectQueryTopic({ messages, telemetry });
    const searchQuery =
      topic.kind === "dtc"
        ? `${topic.value} OEM service manual TSB`
        : `${topic.value} OEM service manual diagnostic`;

    let lookup = { source: "none", candidate: null };
    try {
      const searchResults = await fetchLookupResults(searchQuery);
      lookup = pickLookupSource(searchResults);
    } catch (_error) {
      lookup = { source: "none", candidate: null };
    }

    const sourceContext = lookup.candidate
      ? `Selected source type: ${lookup.source === "official-rag" ? "official" : "third-party forum"}\nTitle: ${lookup.candidate.title}\nURL: ${lookup.candidate.url}`
      : "No lookup source found.";

    if (!GROK_API_KEY) {
      const disclosure = sourceDisclosureLine(lookup.source, lookup.candidate);
      return res.json({
        source: lookup.source === "official-rag" ? "official-rag" : lookup.source === "community-fallback" ? "community-fallback" : "fallback",
        model: GROK_MODEL,
        reply: `${createFallbackReply({ messages, telemetry, eventContext })}\n${disclosure}`,
        lookupSource: lookup.candidate,
      });
    }

    const reply = await queryGrok({ messages, telemetry, eventContext, sourceContext });
    const disclosure = sourceDisclosureLine(lookup.source, lookup.candidate);
    return res.json({
      source: lookup.source === "official-rag" ? "official-rag" : lookup.source === "community-fallback" ? "community-fallback" : "grok",
      model: GROK_MODEL,
      reply: `${reply}\n${disclosure}`,
      lookupSource: lookup.candidate,
    });
  } catch (error) {
    const fallbackReply = createFallbackReply({ messages, telemetry, eventContext });
    return res.status(200).json({
      source: "fallback-error",
      model: GROK_MODEL,
      reply: fallbackReply,
      error: error.message,
    });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`OBD2 Grok web app listening on http://localhost:${PORT}`);
});
