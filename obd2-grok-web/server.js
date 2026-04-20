const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const GROK_API_KEY = process.env.GROK_API_KEY || "";
const GROK_API_BASE_URL = process.env.GROK_API_BASE_URL || "https://api.x.ai/v1";
const GROK_MODEL = process.env.GROK_MODEL || "grok-4.3";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
    "I am running in local fallback mode because Grok credentials are not configured.",
    contextLine,
    userLine,
    "Actionable interpretation:",
    ...issues.map((issue, index) => `${index + 1}. ${issue}`),
    "Suggested next question: Do you want me to focus on live sensor trends or likely component-level root causes?",
  ]
    .filter(Boolean)
    .join("\n");
}

async function queryGrok({ messages, telemetry, eventContext }) {
  const telemetrySummary = summarizeTelemetry(telemetry);
  const safeMessages = trimMessages(messages);

  const systemPrompt = [
    "You are an automotive diagnostics copilot reading OBD-II telemetry from a live scanner.",
    "Return concise, practical guidance in plain English.",
    "Always include: (1) interpretation, (2) likely causes, (3) immediate safe next checks.",
    "End with one proactive follow-up question that moves diagnosis forward.",
    "If data is incomplete, say exactly what PID or observation is missing.",
    "Never invent trouble codes that are not present.",
  ].join(" ");

  const contextPrompt = [
    `Telemetry summary:\n${telemetrySummary}`,
    eventContext ? `Trigger event: ${eventContext}` : "",
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
  });
});

app.post("/api/chat", async (req, res) => {
  const { messages = [], telemetry = [], eventContext = "" } = req.body || {};

  try {
    if (!Array.isArray(messages) || !Array.isArray(telemetry)) {
      return res.status(400).json({ error: "messages and telemetry must be arrays" });
    }

    if (!GROK_API_KEY) {
      return res.json({
        source: "fallback",
        model: GROK_MODEL,
        reply: createFallbackReply({ messages, telemetry, eventContext }),
      });
    }

    const reply = await queryGrok({ messages, telemetry, eventContext });
    return res.json({ source: "grok", model: GROK_MODEL, reply });
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
