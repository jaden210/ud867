const connectButton = document.querySelector("#connectBtn");
const startButton = document.querySelector("#startBtn");
const stopButton = document.querySelector("#stopBtn");
const quickActions = document.querySelector("#quickActions");
const connectionStatus = document.querySelector("#connectionStatus");
const connectionBadge = document.querySelector("#connectionBadge");
const scanMode = document.querySelector("#scanMode");
const liveStamp = document.querySelector("#liveStamp");
const adapterNameValue = document.querySelector("#adapterName");
const adapterBaudValue = document.querySelector("#adapterBaud");
const adapterProtocolValue = document.querySelector("#adapterProtocol");
const rpmValue = document.querySelector("#rpmValue");
const coolantValue = document.querySelector("#coolantValue");
const speedValue = document.querySelector("#speedValue");
const fuelTrimValue = document.querySelector("#fuelTrimValue");
const dtcList = document.querySelector("#dtcList");
const chatLog = document.querySelector("#chatLog");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const messageTemplate = document.querySelector("#chatMessageTemplate");

const PID_COMMANDS = {
  rpm: "010C",
  speedKph: "010D",
  coolantTempC: "0105",
  shortFuelTrimPct: "0106",
};

const CANDIDATE_BAUD_RATES = [38400, 115200, 9600, 57600, 19200];
const ROBUST_SETTINGS = {
  commandTimeoutMs: 1500,
  maxReadFailuresBeforeReconnect: 3,
  reconnectBackoffMs: 800,
};

const state = {
  port: null,
  reader: null,
  writer: null,
  encoder: new TextEncoder(),
  pollTimer: null,
  proactiveTimer: null,
  messages: [],
  telemetryFrames: [],
  latestFrame: null,
  useDemoMode: false,
  isBusy: false,
  connectionProfile: null,
  readFailures: 0,
  autoRecovering: false,
  pollCount: 0,
};

const QUICK_PROMPTS = [
  "What should I inspect first given these readings?",
  "Translate this into plain language for a non-mechanic.",
  "Give me the safest next 3 checks before driving farther.",
  "If this is urgent, tell me exactly why and what to stop doing.",
];

boot();

function boot() {
  addMessage(
    "assistant",
    "Welcome to OBD2S. Same scanner roots, upgraded brains. Connect the cable, hit Start Polling, and I will turn raw PIDs into useful next moves."
  );
  connectButton.addEventListener("click", onConnectClick);
  startButton.addEventListener("click", startPolling);
  stopButton.addEventListener("click", stopPolling);
  chatForm.addEventListener("submit", onChatSubmit);
  quickActions.addEventListener("click", onQuickActionClick);
  updateAdapterProfile(null);
  updateConnectionUi("disconnected");
  renderQuickActions();

  if (!("serial" in navigator)) {
    state.useDemoMode = true;
    setStatus("Web Serial is unavailable. Running in demo telemetry mode.");
    updateAdapterProfile({
      adapterName: "Demo mode",
      baudRate: "--",
      protocolLabel: "simulation",
    });
    setScanMode("Demo mode");
    updateConnectionUi("warning");
    startButton.disabled = false;
  }
}

async function onConnectClick() {
  if (state.useDemoMode) {
    startButton.disabled = false;
    setStatus("Demo mode ready. Click Start Polling.");
    return;
  }

  try {
    updateConnectionUi("connecting");
    const port = await navigator.serial.requestPort();
    const profile = await connectWithAutoDetect(port);
    state.port = port;
    state.connectionProfile = profile;
    state.readFailures = 0;
    updateAdapterProfile(profile);
    setScanMode("Live scanner");
    updateConnectionUi("connected");
    setStatus(
      `Connected at ${profile.baudRate} baud (${profile.protocolLabel}). Press Start Polling.`
    );
    startButton.disabled = false;
    connectButton.disabled = true;
  } catch (error) {
    console.error(error);
    state.useDemoMode = true;
    startButton.disabled = false;
    updateAdapterProfile({
      adapterName: "Demo mode",
      baudRate: "--",
      protocolLabel: "simulation",
    });
    setScanMode("Demo mode");
    updateConnectionUi("warning");
    setStatus("Could not connect scanner. Falling back to demo mode.");
  }
}

async function initializeElm327() {
  const setup = [
    "ATZ",
    "ATE0",
    "ATL0",
    "ATS0",
    "ATH0",
    "ATCAF0",
    "ATST64",
    "ATSP0",
  ];
  for (const command of setup) {
    await sendAndRead(command);
  }
}

function startPolling() {
  if (state.pollTimer || state.isBusy) {
    return;
  }

  stopButton.disabled = false;
  startButton.disabled = true;
  setScanMode(state.useDemoMode ? "Demo polling" : "Live polling");
  updateConnectionUi("connected");
  setStatus(state.useDemoMode ? "Polling demo data..." : "Polling scanner...");

  pollOnce();
  state.pollTimer = setInterval(pollOnce, 1800);
  state.proactiveTimer = setInterval(
    () => requestAssistantReply("", "Proactive check triggered by new frames."),
    9000
  );
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.proactiveTimer) {
    clearInterval(state.proactiveTimer);
    state.proactiveTimer = null;
  }

  startButton.disabled = false;
  stopButton.disabled = true;
  setScanMode(state.useDemoMode ? "Demo idle" : "Connected idle");
  setStatus("Polling stopped.");
}

async function pollOnce() {
  if (state.isBusy) {
    return;
  }
  state.isBusy = true;

  try {
    const frame = state.useDemoMode ? demoFrame() : await liveFrame();
    state.readFailures = 0;
    state.pollCount += 1;
    state.latestFrame = frame;
    state.telemetryFrames.push(frame);
    if (state.telemetryFrames.length > 40) {
      state.telemetryFrames.shift();
    }
    renderFrame(frame);
    updateLiveStamp(frame.timestamp);
  } catch (error) {
    console.error(error);
    state.readFailures += 1;
    updateConnectionUi("warning");
    setStatus("Read failed. Keeping last known values.");
    if (!state.useDemoMode && state.readFailures >= ROBUST_SETTINGS.maxReadFailuresBeforeReconnect) {
      await attemptAutoRecover();
    }
  } finally {
    state.isBusy = false;
  }
}

async function liveFrame() {
  const rpm = await readPid(PID_COMMANDS.rpm, decodeRpm);
  const speedKph = await readPid(PID_COMMANDS.speedKph, decodeSpeed);
  const coolantTempC = await readPid(PID_COMMANDS.coolantTempC, decodeCoolant);
  const shortFuelTrimPct = await readPid(PID_COMMANDS.shortFuelTrimPct, decodeFuelTrim);

  const dtcResponse = await sendAndRead("03");
  const dtcs = parseDtcs(dtcResponse);

  return {
    timestamp: new Date().toISOString(),
    rpm,
    speedKph,
    coolantTempC,
    shortFuelTrimPct,
    throttlePct: null,
    dtcs,
  };
}

function demoFrame() {
  const now = Date.now() / 1000;
  const rpm = Math.round(850 + Math.sin(now * 1.8) * 200 + Math.random() * 70);
  const speedKph = Math.max(0, Math.round(35 + Math.sin(now * 0.6) * 20 + Math.random() * 5));
  const coolantTempC = Math.round(89 + Math.sin(now * 0.25) * 7 + Math.random());
  const shortFuelTrimPct = Number((Math.sin(now * 1.4) * 4 + (Math.random() - 0.5) * 2).toFixed(1));
  const dtcs = Math.random() > 0.88 ? ["P0420"] : [];

  return {
    timestamp: new Date().toISOString(),
    rpm,
    speedKph,
    coolantTempC,
    shortFuelTrimPct,
    throttlePct: null,
    dtcs,
  };
}

async function readPid(command, decoder) {
  const response = await sendAndRead(command);
  return decoder(response);
}

async function sendAndRead(command) {
  await sendElmCommand(command);
  return readElmResponse(ROBUST_SETTINGS.commandTimeoutMs);
}

async function sendElmCommand(command) {
  if (!state.writer) {
    throw new Error("Scanner writer not available.");
  }
  await state.writer.write(state.encoder.encode(`${command}\r`));
}

async function readElmResponse(timeoutMs) {
  if (!state.reader) {
    throw new Error("Scanner reader not available.");
  }

  let text = "";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value, done } = await state.reader.read();
    if (done) {
      break;
    }
    text += value;
    if (text.includes(">")) {
      break;
    }
  }
  return sanitizeElmResponse(text);
}

function decodeRpm(response) {
  const bytes = extractPidData(response, "41 0C", 2);
  return bytes ? Math.round((bytes[0] * 256 + bytes[1]) / 4) : null;
}

function decodeSpeed(response) {
  const bytes = extractPidData(response, "41 0D", 1);
  return bytes ? bytes[0] : null;
}

function decodeCoolant(response) {
  const bytes = extractPidData(response, "41 05", 1);
  return bytes ? bytes[0] - 40 : null;
}

function decodeFuelTrim(response) {
  const bytes = extractPidData(response, "41 06", 1);
  return bytes ? Number((((bytes[0] - 128) * 100) / 128).toFixed(1)) : null;
}

function extractPidData(response, prefix, count) {
  if (!response || response.includes("NO DATA")) {
    return null;
  }
  const tokens = response.split(/\s+/).filter((token) => /^[0-9A-F]{2}$/.test(token));
  const [mode, pid] = prefix.split(" ");
  const index = tokens.findIndex((token, idx) => token === mode && tokens[idx + 1] === pid);
  if (index === -1) {
    return null;
  }
  const bytes = tokens.slice(index + 2, index + 2 + count).map((token) => Number.parseInt(token, 16));
  return bytes.length === count ? bytes : null;
}

function parseDtcs(response) {
  if (!response || response.includes("NO DATA")) {
    return [];
  }

  const tokens = response.split(/\s+/).filter((token) => /^[0-9A-F]{2}$/.test(token));
  const start = tokens.findIndex((token) => token === "43");
  if (start === -1) {
    return [];
  }

  const dtcBytes = tokens.slice(start + 1);
  const codes = [];
  for (let i = 0; i < dtcBytes.length; i += 2) {
    const a = Number.parseInt(dtcBytes[i] || "00", 16);
    const b = Number.parseInt(dtcBytes[i + 1] || "00", 16);
    if (!a && !b) {
      continue;
    }
    const family = ["P", "C", "B", "U"][(a & 0xc0) >> 6];
    const d1 = ((a & 0x30) >> 4).toString(16).toUpperCase();
    const d2 = (a & 0x0f).toString(16).toUpperCase();
    const d3 = ((b & 0xf0) >> 4).toString(16).toUpperCase();
    const d4 = (b & 0x0f).toString(16).toUpperCase();
    codes.push(`${family}${d1}${d2}${d3}${d4}`);
  }
  return codes;
}

async function connectWithAutoDetect(port) {
  let lastError;
  for (const baudRate of CANDIDATE_BAUD_RATES) {
    try {
      await openPortStreams(port, baudRate);
      await initializeElm327();
      const adapterName = await readAdapterIdentity();
      const protocolResponse = await sendAndRead("ATDP");
      const protocolLabel = parseProtocolLabel(protocolResponse);
      return { baudRate, protocolLabel, adapterName };
    } catch (error) {
      lastError = error;
      await closeCurrentStreams(port);
      await wait(connectionRetryJitterMs());
    }
  }
  throw new Error(`Could not initialize scanner on common baud rates. Last error: ${lastError?.message || "unknown"}`);
}

async function readAdapterIdentity() {
  const firstProbe = normalizeAdapterReply(await sendAndRead("ATI"));
  const secondProbe = normalizeAdapterReply(await sendAndRead("ATI"));
  if (!firstProbe || firstProbe !== secondProbe) {
    throw new Error("Adapter did not return a stable identity reply.");
  }

  const labelProbe = normalizeAdapterReply(await sendAndRead("AT@1"));
  return labelProbe || firstProbe;
}

function normalizeAdapterReply(value) {
  if (!value) {
    return "";
  }
  return value
    .replace(/\s+/g, " ")
    .replace(/OK/gi, "")
    .trim()
    .toUpperCase();
}

function sanitizeElmResponse(text) {
  return text
    .replace(/>/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\?/g, " ")
    .replace(/SEARCHING\.\.\./gi, " ")
    .replace(/STOPPED/gi, " ")
    .replace(/BUS INIT: ?ERROR/gi, " ")
    .replace(/CAN ERROR/gi, " ")
    .replace(/BUFFER FULL/gi, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

async function openPortStreams(port, baudRate) {
  await port.open({ baudRate });
  state.writer = port.writable.getWriter();
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable).catch(() => {});
  state.reader = decoder.readable.getReader();
}

async function closeCurrentStreams(port) {
  try {
    if (state.reader) {
      await state.reader.cancel();
      state.reader.releaseLock();
      state.reader = null;
    }
  } catch (_err) {
    // ignored: close path cleanup
  }

  try {
    if (state.writer) {
      state.writer.releaseLock();
      state.writer = null;
    }
  } catch (_err) {
    // ignored: close path cleanup
  }

  try {
    if (port.readable || port.writable) {
      await port.close();
    }
  } catch (_err) {
    // ignored: close path cleanup
  }
}

function parseProtocolLabel(response) {
  if (!response) {
    return "auto";
  }
  const cleaned = response
    .replace(/^AUTO[, ]*/i, "")
    .replace(/^A\d+\s*/i, "")
    .trim();
  return cleaned || "auto";
}

async function attemptAutoRecover() {
  if (state.autoRecovering || !state.port) {
    return;
  }
  state.autoRecovering = true;
  updateConnectionUi("connecting");
  setStatus("Scanner read unstable. Attempting automatic reconnection...");
  try {
    const preferredBaud = state.connectionProfile?.baudRate;
    await closeCurrentStreams(state.port);
    await wait(ROBUST_SETTINGS.reconnectBackoffMs);
    const profile = await connectWithAutoDetect(state.port, preferredBaud);
    state.connectionProfile = profile;
    state.readFailures = 0;
    updateAdapterProfile(profile);
    updateConnectionUi("connected");
    setStatus(`Reconnected successfully at ${profile.baudRate} baud.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("warning");
    setStatus("Auto-recovery failed. Reconnect scanner manually.");
    stopPolling();
  } finally {
    state.autoRecovering = false;
  }
}

function updateAdapterProfile(profile) {
  if (!adapterNameValue || !adapterBaudValue || !adapterProtocolValue) {
    return;
  }

  if (!profile) {
    adapterNameValue.textContent = "Unknown";
    adapterBaudValue.textContent = "--";
    adapterProtocolValue.textContent = "--";
    return;
  }

  adapterNameValue.textContent = profile.adapterName || "Unknown";
  adapterBaudValue.textContent = String(profile.baudRate ?? "--");
  adapterProtocolValue.textContent = profile.protocolLabel || "auto";
}

function renderQuickActions() {
  quickActions.innerHTML = "";
  QUICK_PROMPTS.forEach((prompt) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-action";
    button.textContent = prompt;
    button.dataset.prompt = prompt;
    quickActions.appendChild(button);
  });
}

async function onQuickActionClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const prompt = target.dataset.prompt;
  if (!prompt) {
    return;
  }
  addMessage("user", prompt);
  await requestAssistantReply(prompt, "Driver selected a quick action prompt.");
}

function updateConnectionUi(status) {
  if (!connectionBadge) {
    return;
  }
  connectionBadge.className = `badge ${status}`;
  if (status === "connected") {
    connectionBadge.textContent = "CONNECTED";
  } else if (status === "connecting") {
    connectionBadge.textContent = "CONNECTING";
  } else if (status === "warning") {
    connectionBadge.textContent = "ATTENTION";
  } else {
    connectionBadge.textContent = "DISCONNECTED";
  }
}

function setScanMode(text) {
  if (scanMode) {
    scanMode.textContent = text;
  }
}

function updateLiveStamp(timestamp) {
  if (!liveStamp) {
    return;
  }
  liveStamp.textContent = new Date(timestamp).toLocaleTimeString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectionRetryJitterMs() {
  return 180 + Math.floor(Math.random() * 220);
}

function renderFrame(frame) {
  rpmValue.textContent = valueWithUnit(frame.rpm, "rpm");
  coolantValue.textContent = valueWithUnit(frame.coolantTempC, "C");
  speedValue.textContent = valueWithUnit(frame.speedKph, "km/h");
  fuelTrimValue.textContent = valueWithUnit(frame.shortFuelTrimPct, "%");

  if (!frame.dtcs.length) {
    dtcList.innerHTML = "<li>No codes detected.</li>";
  } else {
    dtcList.innerHTML = frame.dtcs.map((code) => `<li>${code}</li>`).join("");
  }
}

function valueWithUnit(value, unit) {
  return Number.isFinite(value) ? `${value} ${unit}` : "--";
}

async function onChatSubmit(event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  chatInput.value = "";
  addMessage("user", text);
  await requestAssistantReply(text, "User asked a direct question.");
}

async function requestAssistantReply(userMessage, eventContext) {
  if (!state.latestFrame) {
    return;
  }

  if (userMessage) {
    state.messages.push({ role: "user", content: userMessage });
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        telemetry: state.telemetryFrames,
        eventContext,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const prefix =
      payload.source === "grok" ? "[Grok 4.3]" : payload.source === "fallback-error" ? "[Fallback after Grok error]" : "[Fallback]";
    const reply = `${prefix} ${payload.reply}`;
    state.messages.push({ role: "assistant", content: reply });
    addMessage("assistant", reply);
    setStatus(
      payload.source === "grok"
        ? "Live Grok interpretation active."
        : "Fallback interpretation active. Set GROK_API_KEY for Grok responses."
    );
  } catch (error) {
    console.error(error);
    addMessage("assistant", "I could not reach the server. Check connectivity and try again.");
  }
}

function addMessage(role, content) {
  const messageNode = messageTemplate.content.firstElementChild.cloneNode(true);
  messageNode.classList.add(role);
  messageNode.querySelector(".chat-role").textContent =
    role === "user" ? "Driver" : "OBD2S Copilot";
  messageNode.querySelector(".chat-content").textContent = content;
  chatLog.appendChild(messageNode);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text) {
  connectionStatus.textContent = text;
}
