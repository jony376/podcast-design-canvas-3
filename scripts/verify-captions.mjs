// scripts/verify-captions.mjs
// Drives the shipped app in headless Chrome and proves issue #143 end to end:
// upload two generated speaker WebM videos through the normal Host/Guest
// controls, upload a generated WebVTT with two timed cues, verify captions
// appear only inside their cue ranges during playback and while scrubbing,
// confirm captions persist across Split/Stack/Spotlight, then export and
// confirm caption overlays are burned into decoded frames at matching times.
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
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run caption verification.");
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

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 220); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = freq || 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 82; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      await sleep(100);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop();
    ac.close();
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  function formatVttTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(3).padStart(6, "0");
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + s;
  }

  function makeVtt() {
    const t1s = formatVttTime(1).replace(/\\./g, ",");
    const t4s = formatVttTime(4).replace(/\\./g, ",");
    const t5s = formatVttTime(5).replace(/\\./g, ",");
    const t8s = formatVttTime(8).replace(/\\./g, ",");
    const body = "WEBVTT\\n\\n"
      + t1s + " --> " + t4s + "\\nCAP ONE TEXT\\n"
      + t5s + " --> " + t8s + "\\nCAP TWO TEXT\\n";
    return new File([body], "episode.vtt", { type: "text/vtt" });
  }

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const typeInto = (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const CAPTION_REGION = { x0: 25, y0: 84, x1: 75, y1: 93 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }

  const stage = () => document.querySelector("#stage-canvas");
  const captionShown = () => {
    const text = stage().dataset.captionText || "";
    const s = regionStats(stage(), CAPTION_REGION);
    return text.length > 0 && s.dark > 0.45 && s.light > 0.004;
  };
  const captionAbsent = () => {
    const text = stage().dataset.captionText || "";
    const s = regionStats(stage(), CAPTION_REGION);
    return !text && s.dark < 0.1 && s.light < 0.01;
  };

  await waitFor(() => window.PDC && window.PDC.captions && document.querySelector("#caption-file")
    && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped caption/scrub/export controls should exist");

  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded speakers should decode with a real duration covering both caption ranges", 420,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  uploadTo(document.querySelector("#caption-file"), makeVtt());
  await waitFor(() => document.querySelectorAll("#caption-list li").length === 2, "two caption cues should be listed");
  const listText = document.querySelector("#caption-list").textContent;
  assert(listText.includes("CAP ONE TEXT") && listText.includes("CAP TWO TEXT"), "caption list should show both cues");
  await waitFor(() => stage().dataset.captionsLoaded === "true", "canvas should mark that captions are loaded");
  assert(/CAP ONE TEXT/.test(stage().dataset.captionText || ""), "first caption should render immediately after import");

  document.querySelector("#restart").click();
  await waitFor(
    () => /CAP ONE TEXT/.test(stage().dataset.captionText || "") && captionShown(),
    "first caption should appear during live playback inside 1-4s",
    160,
  );
  await waitFor(() => captionAbsent(), "caption should disappear once playback passes the first cue", 220);
  await waitFor(
    () => /CAP TWO TEXT/.test(stage().dataset.captionText || "") && captionShown(),
    "second caption should appear during live playback inside 5-8s",
    220,
  );

  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar should span the episode", 120);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
  }

  pausePreview();
  await scrubTo(2);
  await waitFor(() => /CAP ONE TEXT/.test(stage().dataset.captionText || "") && captionShown(), "scrubbed to 2s: first caption shown (Split)");
  await scrubTo(4.5);
  await waitFor(() => captionAbsent(), "scrubbed to 4.5s: no caption in the gap (Split)");
  await scrubTo(6);
  await waitFor(() => /CAP TWO TEXT/.test(stage().dataset.captionText || "") && captionShown(), "scrubbed to 6s: second caption shown (Split)");

  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(document.querySelectorAll("#caption-list li").length === 2, "captions should survive switching to " + presetId);
    await scrubTo(2);
    await waitFor(() => /CAP ONE TEXT/.test(stage().dataset.captionText || ""), presetId + ": first caption at 2s");
    await scrubTo(4.5);
    await waitFor(() => captionAbsent(), presetId + ": no caption at 4.5s");
    await scrubTo(6);
    await waitFor(() => /CAP TWO TEXT/.test(stage().dataset.captionText || ""), presetId + ": second caption at 6s");
  }

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 760,
  );
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 220);
  }

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth;
  probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 350);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      t,
      caption: regionStats(probe, CAPTION_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }

  const inFirst = await seekAndSample(2);
  const inGap = await seekAndSample(4.5);
  const inSecond = await seekAndSample(6);
  const burnedIn = (s) => s.dark > 0.3 && s.light > 0.0015;
  const plainVideo = (s) => s.dark < 0.15;
  assert(inFirst.frame.bright > 0.2, "exported frame at 2s should be nonblank");
  assert(burnedIn(inFirst.caption), "first caption should be burned into export at 2s");
  assert(inGap.frame.bright > 0.2, "exported frame at 4.5s should be nonblank");
  assert(plainVideo(inGap.caption), "no caption should be burned in at 4.5s");
  assert(inSecond.frame.bright > 0.2, "exported frame at 6s should be nonblank");
  assert(burnedIn(inSecond.caption), "second caption should be burned into export at 6s");

  return {
    cuesListed: document.querySelectorAll("#caption-list li").length,
    exportBytes: blob.size,
    exportSamples: { inFirst, inGap, inSecond },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-captions-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-captions: OK — imported WebVTT captions render in preview/export across presets");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => {
  console.error(`verify-captions: ${e.message}`);
  process.exit(1);
});
