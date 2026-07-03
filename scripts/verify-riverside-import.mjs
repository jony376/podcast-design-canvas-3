// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves issue #178 end to end:
// generate three local WebM speaker tracks, serve them over a maintainer-owned
// http://127.0.0.1 track server, build a Riverside-style share link that encodes
// those track URLs, paste it into the real import field, confirm Host / Guest 1 /
// Guest 2 buckets populate with playable blob-backed media, the composed preview
// renders all three tracks across Split / Stack / Spotlight, export produces a
// genuinely playable video, and an unsupported link shows a visible error without
// wiping the imported setup.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run Riverside import verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      child.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}

async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 7) return;
      await sleep(100 * (i + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP " + r.status);
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw last;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

function buildRiversideLink(tracks) {
  const payload = { tracks };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return "https://riverside.fm/studio/share/local-sync#pdc-synced-tracks=" + encoded;
}

function startTrackServer(trackDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = urlPath.replace(/^\/+/, "");
      const full = path.join(trackDir, rel);
      if (!full.startsWith(trackDir)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(full, (err, data) => {
        if (err) {
          res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": "video/webm" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

const generateVideosExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#ffffff";
      ctx.font = "26px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(name.slice(0, 20), 160, 72);
      ctx.fillText("frame " + i, 160, 112);
      await sleep(45);
    }
    await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  const host = await makeVideo("host.webm", "#b91c1c");
  const guest1 = await makeVideo("guest1.webm", "#047857");
  const guest2 = await makeVideo("guest2.webm", "#2563eb");
  return {
    host: await fileToBase64(host),
    guest1: await fileToBase64(guest1),
    guest2: await fileToBase64(guest2),
  };
})()
`;

function browserExpression(riversideLink) {
  return `
(async () => {
  const RIVERSIDE_LINK = ${JSON.stringify(riversideLink)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  await waitFor(() => window.PDC && window.PDC.riverside && document.querySelector("#riverside-link"), "Riverside import controls should exist");

  function regionAvgColor(xStartPct, yStartPct, xEndPct, yEndPct) {
    const c = document.getElementById("stage-canvas");
    const w = c.width;
    const h = c.height;
    const data = c.getContext("2d").getImageData(0, 0, w, h).data;
    const x0 = Math.floor(xStartPct / 100 * w);
    const x1 = Math.floor(xEndPct / 100 * w);
    const y0 = Math.floor(yStartPct / 100 * h);
    const y1 = Math.floor(yEndPct / 100 * h);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; n++;
      }
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  function dominantChannel(color) {
    if (color.r > color.g + 25 && color.r > color.b + 25) return "red";
    if (color.g > color.r + 25 && color.g > color.b + 25) return "green";
    if (color.b > color.r + 25 && color.b > color.g + 25) return "blue";
    return "mixed";
  }

  function assertRegionColor(label, x0, y0, x1, y1, expected) {
    const color = regionAvgColor(x0, y0, x1, y1);
    const dom = dominantChannel(color);
    assert(dom === expected, label + ": expected " + expected + "-dominant pixels, got " + dom);
    return color;
  }

  function canvasLitPct() {
    const c = document.getElementById("stage-canvas");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    }
    return Math.round((lit / (data.length / 4)) * 100);
  }

  function assertCanvasVisible(label) {
    const pct = canvasLitPct();
    assert(pct >= 5, label + ": composed canvas should show nonblank pixels (" + pct + "%)");
    return pct;
  }

  function assertStackRowsVisible() {
    const rects = window.PDC.presets.getPreset("stack").layout(3);
    const rowColors = rects.map((rect) => {
      const pad = Math.min(4, rect.h * 0.15);
      const color = regionAvgColor(rect.x + 2, rect.y + pad, rect.x + rect.w - 2, rect.y + rect.h - pad);
      return dominantChannel(color);
    });
    assert(rowColors[0] === "red", "stack row 1 should show the host feed");
    assert(rowColors[1] === "green", "stack row 2 should show Guest 1 feed");
    assert(rowColors[2] === "blue", "stack row 3 should show Guest 2 feed");
    return rowColors;
  }

  async function clickPreset(id) {
    document.querySelector('button[data-preset="' + id + '"]').click();
    await sleep(500);
  }

  typeInto(document.querySelector("#riverside-link"), RIVERSIDE_LINK);
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => document.querySelectorAll(".bucket.filled").length === 3, "Riverside import should fill Host, Guest 1, and Guest 2");
  await waitFor(() => !document.querySelector("#export").disabled, "export should be enabled after Riverside import");

  const hostStatus = document.querySelector('[data-status="host"]');
  const guest1Status = document.querySelector('[data-status="guest1"]');
  const guest2Status = document.querySelector('[data-status="guest2"]');
  assert(hostStatus.textContent === "host.webm", "host bucket should show imported filename");
  assert(guest1Status.textContent === "guest1.webm", "guest1 bucket should show imported filename");
  assert(guest2Status.textContent === "guest2.webm", "guest2 bucket should show imported filename");

  const videos = [...document.querySelectorAll("video[data-speaker]")];
  assert(videos.length === 3, "three hidden decoder videos should exist after Riverside import");
  await Promise.all(videos.map((v) => v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? null : new Promise((r) => v.addEventListener("loadeddata", r, { once: true }))));
  assert(videos.every((v) => v.src.startsWith("blob:")), "imported tracks should be backed by blob URLs");
  assert(videos.every((v) => v.videoWidth > 0), "imported tracks should decode real dimensions");

  assertCanvasVisible("split preset after Riverside import");
  await clickPreset("stack");
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack");
  assertCanvasVisible("stack preset");
  assertStackRowsVisible();
  await clickPreset("spotlight");
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight");
  assertCanvasVisible("spotlight preset");
  assertRegionColor("spotlight center", 25, 25, 75, 75, "red");

  const setupBeforeBad = {
    filled: document.querySelectorAll(".bucket.filled").length,
    host: hostStatus.textContent,
    exportReady: !document.querySelector("#export").disabled,
  };

  typeInto(document.querySelector("#riverside-link"), "https://example.com/not-a-riverside-link");
  document.querySelector("#riverside-import-btn").click();
  await sleep(300);
  const errEl = document.querySelector("#riverside-error");
  assert(errEl && !errEl.hidden && errEl.textContent.length > 0, "unsupported link should show a visible error");
  assert(document.querySelectorAll(".bucket.filled").length === setupBeforeBad.filled, "bad import must not wipe filled buckets");
  assert(hostStatus.textContent === setupBeforeBad.host, "bad import must not change host filename");
  assert(!document.querySelector("#export").disabled, "export readiness must survive bad import");

  async function waitForExportReady(label, tries) {
    await waitFor(() => {
      const btn = document.querySelector("#export");
      return btn && !btn.disabled && btn.textContent.indexOf("Exporting") === -1;
    }, label + ": export button should be ready", tries || 200);
  }

  async function runExport(attempt) {
    const result = document.querySelector("#export-result");
    result.hidden = true;
    result.innerHTML = "";
    await waitForExportReady("attempt " + attempt, 240);
    document.querySelector("#export").click();
    await waitFor(() => {
      const link = document.querySelector("#export-download");
      const playback = document.querySelector("#export-playback");
      return link && playback && playback.readyState >= HTMLMediaElement.HAVE_METADATA;
    }, "attempt " + attempt + ": export should produce a downloadable playable result", 800);
    const href = document.querySelector("#export-download").getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, "attempt " + attempt + ": download link should be a real blob URL");
    let blob = await (await fetch(href)).blob();
    if (blob.size <= 2048) {
      await sleep(400);
      blob = await (await fetch(href)).blob();
    }
    assert(blob.size > 2048, "attempt " + attempt + ": exported file should carry real bytes, got " + blob.size);
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, "attempt " + attempt + ": exported file should be a playable video with real dimensions");
    return { bytes: blob.size, dimensions: v.videoWidth + "x" + v.videoHeight };
  }

  let exportInfo = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      exportInfo = await runExport(attempt);
      break;
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  if (!exportInfo) throw lastErr || new Error("export failed after retries");

  return {
    filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((b) => b.dataset.bucket),
    exportBytes: exportInfo.bytes,
    exportDimensions: exportInfo.dimensions,
    badLinkError: errEl.textContent,
  };
})()
`;
}

async function main() {
  const chrome = findChrome();
  const cdpPort = await getFreePort();
  const trackDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-tracks-"));
  const { server: trackServer, port: trackPort } = await startTrackServer(trackDir);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-import-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;

  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);

  try {
    const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");

    const generated = await send("Runtime.evaluate", {
      expression: generateVideosExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (generated.exceptionDetails) {
      throw new Error(generated.exceptionDetails.exception?.description || generated.exceptionDetails.text);
    }

    const b64 = generated.result.value;
    fs.writeFileSync(path.join(trackDir, "host.webm"), Buffer.from(b64.host, "base64"));
    fs.writeFileSync(path.join(trackDir, "guest1.webm"), Buffer.from(b64.guest1, "base64"));
    fs.writeFileSync(path.join(trackDir, "guest2.webm"), Buffer.from(b64.guest2, "base64"));

    const riversideLink = buildRiversideLink({
      host: `http://127.0.0.1:${trackPort}/host.webm`,
      guest1: `http://127.0.0.1:${trackPort}/guest1.webm`,
      guest2: `http://127.0.0.1:${trackPort}/guest2.webm`,
    });

    const result = await send("Runtime.evaluate", {
      expression: browserExpression(riversideLink),
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    });
    ws.close();

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }

    console.log("verify-riverside-import: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
    await removeDirEventually(trackDir);
    trackServer.close();
  }
}

main().catch((e) => {
  console.error(`verify-riverside-import: ${e.message}`);
  process.exit(1);
});
