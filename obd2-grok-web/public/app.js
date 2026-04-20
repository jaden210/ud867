const connectButton = document.querySelector("#connectBtn");
const startButton = document.querySelector("#startBtn");
const stopButton = document.querySelector("#stopBtn");
const quickActions = document.querySelector("#quickActions");
const connectionStatus = document.querySelector("#connectionStatus");
const connectionBadge = document.querySelector("#connectionBadge");
const connectionHint = document.querySelector("#connectionHint");
const scanModeValue = document.querySelector("#scanMode");
const liveStampValue = document.querySelector("#liveStamp");
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
const clearHistoryButton = document.querySelector("#clearChatBtn");

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
const CHAT_STORAGE_KEY = "obd2s-chat-history-v1";
const MAX_CHAT_MESSAGES = 50;

const QUICK_PROMPTS = [
  "Is it safe to drive this right now?",
  "Give me the top 3 checks with basic tools.",
  "Which part is most likely failing?",
  "Should I pull over now or can I make it home?",
];

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
};

boot();

function boot() {
  hydrateChatHistory();
  if (!state.messages.length) {
    recordMessage(
      "assistant",
      "OBD2S online. Connect scanner, start polling, ask what to do next."
    );
  }

  connectButton.addEventListener("click", onConnectClick);
  startButton.addEventListener("click", startPolling);
  stopButton.addEventListener("click", stopPolling);
  chatForm.addEventListener("submit", onChatSubmit);
  quickActions.addEventListener("click", onQuickActionClick);
  clearHistoryButton.addEventListener("click", onClearHistory);

  renderQuickActions();
  updateAdapterProfile(null);
  updateConnectionUi("disconnected");
  setScanMode("Idle");
  updateLiveStamp(null);

  if (!("serial" in navigator)) {
    state.useDemoMode = true;
    updateConnectionUi("demo");
    setScanMode("Demo mode");
    setStatus("Web Serial unavailable in this browser. Demo telemetry enabled.");
    updateAdapterProfile({
      adapterName: "Demo mode",
      baudRate: "--",
      protocolLabel: "simulation",
    });
    startButton.disabled = false;
  }
}

function renderQuickActions() {
  quickActions.innerHTML = "";
  QUICK_PROMPTS.forEach((prompt) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.dataset.prompt = prompt;
    button.textContent = prompt;
    quickActions.appendChild(button);
  });
}

async function onConnectClick() {
  if (state.useDemoMode) {
    setStatus("Demo mode ready. Start polling.");
    startButton.disabled = false;
    return;
  }

  try {
    updateConnectionUi("connecting");
    setScanMode("Connecting");
    const port = await navigator.serial.requestPort();
    const profile = await connectWithAutoDetect(port);
    state.port = port;
    state.connectionProfile = profile;
    state.readFailures = 0;

    updateAdapterProfile(profile);
    updateConnectionUi("connected");
    setScanMode("Connected");
    setStatus(`Connected: ${profile.baudRate} baud, ${profile.protocolLabel}.`);
    connectButton.disabled = true;
    startButton.disabled = false;
  } catch (error) {
    console.error(error);
    state.useDemoMode = true;
    updateConnectionUi("demo");
    setScanMode("Demo mode");
    setStatus("Scanner connect failed. Switched to demo telemetry.");
    updateAdapterProfile({
      adapterName: "Demo mode",
      baudRate: "--",
      protocolLabel: "simulation",
    });
    startButton.disabled = false;
  }
}

function startPolling() {
  if (state.pollTimer || state.isBusy) {
    return;
  }

  startButton.disabled = true;
  stopButton.disabled = false;
  updateConnectionUi(state.useDemoMode ? "demo" : "connected");
  setScanMode(state.useDemoMode ? "Demo polling" : "Live polling");
  setStatus(state.useDemoMode ? "Polling demo data..." : "Polling scanner...");

  pollOnce();
  state.pollTimer = setInterval(pollOnce, 1800);
  state.proactiveTimer = setInterval(() => {
    requestAssistantReply("", "Proactive check triggered by new telemetry.");
  }, 9000);
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
    setStatus("Read failed. Retaining previous frame.");
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
  const dtcs = parseDtcs(await sendAndRead("03"));

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
  return {
    timestamp: new Date().toISOString(),
    rpm: Math.round(850 + Math.sin(now * 1.8) * 200 + Math.random() * 70),
    speedKph: Math.max(0, Math.round(35 + Math.sin(now * 0.6) * 20 + Math.random() * 5)),
    coolantTempC: Math.round(89 + Math.sin(now * 0.25) * 7 + Math.random()),
    shortFuelTrimPct: Number((Math.sin(now * 1.4) * 4 + (Math.random() - 0.5) * 2).toFixed(1)),
    throttlePct: null,
    dtcs: Math.random() > 0.88 ? ["P0420"] : [],
  };
}

async function readPid(command, decoder) {
  return decoder(await sendAndRead(command));
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
  if (index < 0) {
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
  if (start < 0) {
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
      const protocolLabel = parseProtocolLabel(await sendAndRead("ATDP"));
      return { baudRate, protocolLabel, adapterName };
    } catch (error) {
      lastError = error;
      await closeCurrentStreams(port);
      await wait(connectionRetryJitterMs());
    }
  }
  throw new Error(
    `Could not initialize scanner on common baud rates. Last error: ${lastError?.message || "unknown"}`
  );
}

async function initializeElm327() {
  const setup = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATCAF0", "ATST64", "ATSP0"];
  for (const command of setup) {
    await sendAndRead(command);
  }
}

async function readAdapterIdentity() {
  const firstProbe = normalizeAdapterReply(await sendAndRead("ATI"));
  const secondProbe = normalizeAdapterReply(await sendAndRead("ATI"));
  if (!firstProbe || firstProbe !== secondProbe) {
    throw new Error("Adapter did not return stable identity reply.");
  }
  return normalizeAdapterReply(await sendAndRead("AT@1")) || firstProbe;
}

function normalizeAdapterReply(value) {
  return (value || "").replace(/\s+/g, " ").replace(/OK/gi, "").trim().toUpperCase();
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
  } catch (_error) {
    // Ignore cleanup errors.
  }

  try {
    if (state.writer) {
      state.writer.releaseLock();
      state.writer = null;
    }
  } catch (_error) {
    // Ignore cleanup errors.
  }

  try {
    if (port.readable || port.writable) {
      await port.close();
    }
  } catch (_error) {
    // Ignore cleanup errors.
  }
}

function parseProtocolLabel(response) {
  return (response || "auto").replace(/^AUTO[, ]*/i, "").replace(/^A\d+\s*/i, "").trim() || "auto";
}

async function attemptAutoRecover() {
  if (state.autoRecovering || !state.port) {
    return;
  }

  state.autoRecovering = true;
  updateConnectionUi("recovering");
  setScanMode("Recovering");
  setStatus("Scanner link unstable. Attempting automatic reconnect...");

  try {
    await closeCurrentStreams(state.port);
    await wait(ROBUST_SETTINGS.reconnectBackoffMs);
    const profile = await connectWithAutoDetect(state.port);
    state.connectionProfile = profile;
    state.readFailures = 0;
    updateAdapterProfile(profile);
    updateConnectionUi("connected");
    setScanMode("Connected");
    setStatus(`Reconnected at ${profile.baudRate} baud.`);
  } catch (error) {
    console.error(error);
    updateConnectionUi("warning");
    setScanMode("Needs reconnect");
    setStatus("Auto-recovery failed. Reconnect scanner manually.");
    stopPolling();
  } finally {
    state.autoRecovering = false;
  }
}

async function onChatSubmit(event) {
  event.preventDefault();
  const prompt = chatInput.value.trim();
  if (!prompt) {
    return;
  }
  chatInput.value = "";
  await requestAssistantReply(prompt, "Driver asked a direct question.");
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
  await requestAssistantReply(prompt, "Driver selected a quick prompt.");
}

async function requestAssistantReply(userMessage, eventContext) {
  if (userMessage) {
    recordMessage("user", userMessage);
  }

  if (!state.latestFrame) {
    recordMessage("assistant", "Need one live frame first. Press Start Polling.");
    return;
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
    const policyPrefix =
      payload.source === "official-rag"
        ? "[Official]"
        : payload.source === "community-fallback"
          ? "[Forum]"
          : payload.source === "grok"
            ? "[Grok]"
            : "[Fallback]";
    recordMessage("assistant", `${policyPrefix} ${payload.reply}`);

    if (payload.source === "official-rag") {
      setStatus("Using official guidance.");
    } else if (payload.source === "community-fallback") {
      setStatus("Using third-party forum guidance with disclosure.");
    } else {
      setStatus("No matched source found. Reply limited to model/fallback guidance.");
    }
  } catch (error) {
    console.error(error);
    recordMessage("assistant", "I could not reach the server. Check connectivity and retry.");
  }
}

function renderFrame(frame) {
  rpmValue.textContent = valueWithUnit(frame.rpm, "rpm");
  coolantValue.textContent = valueWithUnit(frame.coolantTempC, "C");
  speedValue.textContent = valueWithUnit(frame.speedKph, "km/h");
  fuelTrimValue.textContent = valueWithUnit(frame.shortFuelTrimPct, "%");
  dtcList.innerHTML = frame.dtcs.length
    ? frame.dtcs.map((code) => `<li>${code}</li>`).join("")
    : "<li>No codes detected.</li>";
}

function valueWithUnit(value, unit) {
  return Number.isFinite(value) ? `${value} ${unit}` : "--";
}

function updateAdapterProfile(profile) {
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

function updateConnectionUi(status) {
  connectionBadge.className = "status-badge offline";
  if (status === "connected") {
    connectionBadge.className = "status-badge online";
    connectionBadge.textContent = "Connected";
    connectionHint.textContent = "Scanner link established. Start polling.";
  } else if (status === "connecting") {
    connectionBadge.className = "status-badge recovering";
    connectionBadge.textContent = "Connecting";
    connectionHint.textContent = "Negotiating adapter and protocol...";
  } else if (status === "recovering" || status === "warning") {
    connectionBadge.className = "status-badge recovering";
    connectionBadge.textContent = "Recovering";
    connectionHint.textContent = "Trying to restore scanner connection.";
  } else if (status === "demo") {
    connectionBadge.className = "status-badge recovering";
    connectionBadge.textContent = "Demo";
    connectionHint.textContent = "Demo telemetry active (no scanner).";
  } else {
    connectionBadge.textContent = "Disconnected";
    connectionHint.textContent = "Plug cable in, then press Connect Scanner.";
  }
}

function setScanMode(text) {
  scanModeValue.textContent = text;
}

function updateLiveStamp(timestamp) {
  liveStampValue.textContent = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : "--:--:--";
}

function setStatus(text) {
  connectionStatus.textContent = text;
}

function recordMessage(role, content) {
  const safeEntry = { role, content: String(content).trim() };
  state.messages.push(safeEntry);
  if (state.messages.length > MAX_CHAT_MESSAGES) {
    state.messages = state.messages.slice(-MAX_CHAT_MESSAGES);
  }
  renderChatMessage(safeEntry);
  persistChatHistory();
}

function renderChatMessage(entry) {
  const node = messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(entry.role);
  node.querySelector(".chat-role").textContent =
    entry.role === "user" ? "Driver" : "OBD2S Copilot";
  node.querySelector(".chat-content").textContent = entry.content;
  chatLog.appendChild(node);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function hydrateChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }

    state.messages = parsed
      .filter((entry) => {
        return (
          entry &&
          typeof entry.content === "string" &&
          (entry.role === "user" || entry.role === "assistant")
        );
      })
      .slice(-MAX_CHAT_MESSAGES);

    state.messages.forEach((entry) => renderChatMessage(entry));
    if (state.messages.length) {
      setStatus("Restored previous OBD2S chat history.");
    }
  } catch (_error) {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }
}

function persistChatHistory() {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.messages));
  } catch (_error) {
    // Ignore private-mode or quota failures.
  }
}

function onClearHistory() {
  state.messages = [];
  chatLog.innerHTML = "";
  localStorage.removeItem(CHAT_STORAGE_KEY);
  recordMessage("assistant", "History cleared. Fresh OBD2S session started.");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectionRetryJitterMs() {
  return 180 + Math.floor(Math.random() * 220);
}
