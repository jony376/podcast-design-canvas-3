// scripts/layer2-riverside-screenshots.mjs
// Layer 2 manual review pack for issue #178: drive the real Riverside import UI
// over http://, capture PNG screenshots at each workflow step, and write a
// manifest for PR evidence. Does not open a PR — run before you ask for review.
//
// Usage:
//   CHROME_BIN=... node scripts/layer2-riverside-screenshots.mjs
// Output: review-screenshots/riverside-178/*.png + manifest.json
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "review-screenshots", "riverside-178");

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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN.");
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

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
    };
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const full = path.join(root, rel);
      if (!full.startsWith(root)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(full, (err, data) => {
        if (err) {
          res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": types[path.extname(full)] || "application/octet-stream" });
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

async function ensurePreviewPlaying(send) {
  await send("Runtime.evaluate", {
    expression: `(function(){
      const btn = document.querySelector("#play");
      if (btn && !btn.disabled && btn.textContent.indexOf("Pause") === -1) btn.click();
    })()`,
  });
  await sleep(400);
}

async function captureScreenshot(send, name, note) {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return { file: path.relative(root, file), note };
}

async function main() {
  const chrome = findChrome();
  fs.mkdirSync(outDir, { recursive: true });

  const trackDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-layer2-tracks-"));
  const { server: trackServer, port: trackPort } = await startTrackServer(trackDir);
  const { server: appServer, port: appPort } = await startStaticServer();
  const appUrl = `http://127.0.0.1:${appPort}/index.html`;

  const cdpPort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-layer2-riverside-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=1280,900`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    appUrl,
  ]);

  const manifest = {
    issue: 178,
    appUrl,
    capturedAt: new Date().toISOString(),
    screenshots: [],
  };

  try {
    const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    manifest.screenshots.push(
      await captureScreenshot(send, "01-setup-initial", "Setup screen with Riverside import field visible"),
    );
    await sleep(300);

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

    const steps = [
      { id: "02-link-pasted", run: async () => {
        await send("Runtime.evaluate", {
          expression: `(function(){ const i=document.querySelector("#riverside-link"); i.value=${JSON.stringify(riversideLink)}; i.dispatchEvent(new Event("input",{bubbles:true})); })()`,
        });
        await sleep(200);
      }},
      { id: "03-buckets-filled", run: async () => {
        await send("Runtime.evaluate", { expression: `document.querySelector("#riverside-import-btn").click()` });
        await sleep(50);
        for (let i = 0; i < 120; i++) {
          const n = await send("Runtime.evaluate", {
            expression: `document.querySelectorAll(".bucket.filled").length`,
            returnByValue: true,
          });
          if (n.result.value === 3) break;
          await sleep(100);
        }
        await sleep(400);
      }},
      { id: "04-split-preview", run: async () => {
        await ensurePreviewPlaying(send);
      }},
      { id: "05-stack-preview", run: async () => {
        await send("Runtime.evaluate", {
          expression: `document.querySelector('button[data-preset="stack"]').click();`,
        });
        await ensurePreviewPlaying(send);
      }},
      { id: "06-spotlight-preview", run: async () => {
        await send("Runtime.evaluate", {
          expression: `document.querySelector('button[data-preset="spotlight"]').click();`,
        });
        await ensurePreviewPlaying(send);
      }},
      { id: "07-bad-link-error", run: async () => {
        await send("Runtime.evaluate", {
          expression: `(function(){ const i=document.querySelector("#riverside-link"); i.value="https://example.com/not-a-riverside-link"; i.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#riverside-import-btn").click(); })()`,
        });
        await sleep(500);
      }},
      { id: "08-export-result", run: async () => {
        await send("Runtime.evaluate", { expression: `document.querySelector("#export").click()` });
        for (let i = 0; i < 200; i++) {
          const ok = await send("Runtime.evaluate", {
            expression: `(() => {
              const link = document.querySelector("#export-download");
              const playback = document.querySelector("#export-playback");
              const txt = (document.querySelector("#export-result") || {}).textContent || "";
              return !!(link && playback && playback.readyState >= 1 && playback.videoWidth > 0 && !/— 0 KB/.test(txt));
            })()`,
            returnByValue: true,
          });
          if (ok.result.value) break;
          await sleep(100);
        }
        await sleep(400);
      }},
    ];

    const notes = {
      "01-setup-initial": "Setup screen with Riverside import field visible",
      "02-link-pasted": "Riverside share link pasted in import field (local test tracks)",
      "03-buckets-filled": "Host, Guest 1, Guest 2 buckets filled after Import tracks",
      "04-split-preview": "Split preset composed preview with three imported tracks",
      "05-stack-preview": "Stack preset shows three speaker rows",
      "06-spotlight-preview": "Spotlight preset with host-dominant center",
      "07-bad-link-error": "Invalid link shows recoverable error; buckets unchanged",
      "08-export-result": "Export completed with download link and playback preview",
    };

    for (const step of steps) {
      await step.run();
      manifest.screenshots.push(await captureScreenshot(send, step.id, notes[step.id]));
    }

    const summary = await send("Runtime.evaluate", {
      expression: `({
        filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((b) => b.dataset.bucket),
        hostFile: document.querySelector('[data-status="host"]').textContent,
        badLinkError: document.querySelector("#riverside-error").textContent,
        exportSummary: document.querySelector("#export-result").textContent.slice(0, 200),
      })`,
      returnByValue: true,
    });
    manifest.summary = summary.result.value;
    manifest.riversideLink = riversideLink;

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    ws.close();

    console.log("layer2-riverside-screenshots: OK");
    console.log("Screenshots written to:", outDir);
    for (const s of manifest.screenshots) {
      console.log(" -", s.file, "—", s.note);
    }
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
    await removeDirEventually(trackDir);
    trackServer.close();
    appServer.close();
  }
}

main().catch((e) => {
  console.error(`layer2-riverside-screenshots: ${e.message}`);
  process.exit(1);
});
