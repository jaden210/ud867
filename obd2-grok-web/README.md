# OBD-II + Grok 4.3 Proactive Diagnostics Web App

This is a complete web app that connects to an OBD-II scanner, reads live engine data, and uses Grok 4.3 to interpret issues through a proactive diagnostics chat.

## What it does

- Connects to ELM327-compatible scanners through the browser Web Serial API
- Uses a robust adapter profile tailored for clone ELM327/INPA-style cables (including Taotao B07L498NGZ-like units):
  - baud auto-detection across common rates
  - noise-tolerant ELM response sanitization (`SEARCHING...`, `BUS INIT`, CAN noise)
  - auto-recovery and reconnect after repeated read failures
- Polls key PIDs continuously:
  - `010C` Engine RPM
  - `010D` Vehicle speed
  - `0105` Coolant temperature
  - `0111` Throttle position
  - `03` Stored DTC trouble codes
- Shows a live telemetry dashboard in the browser
- Pushes telemetry snapshots + chat context to a Node.js API
- Uses Grok 4.3 (`/chat/completions`) for interpretation
- Generates proactive assistant prompts based on risk signals and polling events
- Falls back to local rule-based diagnostics if no API key is configured

## Project structure

```txt
obd2-grok-web/
  server.js
  .env.example
  package.json
  public/
    index.html
    styles.css
    app.js
```

## Setup

```bash
cd /workspace/obd2-grok-web
npm install
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
GROK_API_KEY=replace_with_real_key
GROK_API_BASE_URL=https://api.x.ai/v1
GROK_MODEL=grok-4.3
```

## Run

```bash
npm run dev
```

Open: `http://localhost:3000`

## API endpoints

- `GET /api/health`  
  Returns service status and whether Grok credentials are configured.

- `POST /api/chat`  
  Accepts:
  - `messages`: chat history array (`role`, `content`)
  - `telemetry`: recent frame list
  - `eventContext`: optional proactive trigger text

## Browser notes

- Web Serial is available in Chromium-based browsers.
- If Web Serial is unavailable (or scanner read fails), the app switches to a realistic demo telemetry mode so the proactive chat can still be used.
- For Taotao/clone adapters, keep ignition in ON or engine RUN during initial connect so protocol auto-detect can complete reliably.
- Use this for diagnostics support only; follow proper safety procedures when working around a running vehicle.

