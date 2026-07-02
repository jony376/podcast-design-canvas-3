// app/captions.js — user-supplied WebVTT caption import for the episode
// timeline. Pure, DOM-free model: captions live ON THE EPISODE (not on a
// preset or the preview), so switching Split/Stack/Spotlight or applying a
// saved template keeps every cue attached. The preview draws active cues onto
// the stage canvas each frame, and export records that same canvas so
// captions burn into the output at the matching times.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // WebVTT timestamps: MM:SS.mmm or HH:MM:SS.mmm (comma or dot decimals).
  function parseTimestamp(raw) {
    const s = String(raw || "").trim().replace(",", ".");
    const parts = s.split(":");
    if (parts.length < 2 || parts.length > 3) return NaN;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    if (parts.length === 3) {
      hours = Number(parts[0]);
      minutes = Number(parts[1]);
      seconds = Number(parts[2]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return NaN;
      if (hours < 0 || minutes < 0 || seconds < 0 || minutes >= 60 || seconds >= 60) return NaN;
      return hours * 3600 + minutes * 60 + seconds;
    }
    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return NaN;
    if (minutes < 0 || seconds < 0) return NaN;
    return minutes * 60 + seconds;
  }

  function stripTags(text) {
    return String(text || "").replace(/<[^>]+>/g, "").trim();
  }

  function skipMetadataBlock(lines, index) {
    while (index < lines.length && lines[index].trim() !== "") index += 1;
    return index;
  }

  // Parse a WebVTT document into timed cues. Returns { ok, cues } or { ok, error }.
  function parseWebVTT(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!/^WEBVTT/i.test(raw.trimStart())) {
      return { ok: false, error: "Caption file must begin with a WEBVTT header." };
    }

    const lines = raw.split("\n");
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      i += 1;
      if (!line) continue;
      if (/^WEBVTT/i.test(line)) continue;
      if (/^NOTE(?:\s|$)/i.test(line)) {
        i = skipMetadataBlock(lines, i);
        continue;
      }
      if (/^STYLE/i.test(line) || /^REGION/i.test(line)) {
        i = skipMetadataBlock(lines, i);
        continue;
      }
      // Skip WEBVTT header metadata (Kind:, Language:, etc.) before the first cue.
      if (/^[\w-]+:\s/.test(line)) continue;

      let timingLine = line;
      if (!timingLine.includes("-->")) {
        if (i >= lines.length) continue;
        timingLine = lines[i].trim();
        i += 1;
        if (!timingLine.includes("-->")) continue;
      }

      const parts = timingLine.split("-->");
      const start = parseTimestamp(parts[0]);
      const end = parseTimestamp((parts[1] || "").trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      const textLines = [];
      while (i < lines.length && lines[i].trim() !== "") {
        if (lines[i].includes("-->")) break;
        textLines.push(lines[i]);
        i += 1;
      }
      const cueText = stripTags(textLines.join("\n"));
      if (!cueText) continue;
      cues.push({ start, end, text: cueText });
    }

    if (!cues.length) {
      return { ok: false, error: "No timed caption cues were found in the file." };
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return { ok: true, cues };
  }

  function setCaptions(episode, fileName, cues) {
    episode.captions = {
      fileName: String(fileName || "captions.vtt"),
      cues: cues.slice(),
    };
    return episode.captions;
  }

  function clearCaptions(episode) {
    episode.captions = null;
  }

  function hasCaptions(episode) {
    return !!(episode.captions && episode.captions.cues && episode.captions.cues.length);
  }

  function listCues(episode) {
    return hasCaptions(episode) ? episode.captions.cues.slice() : [];
  }

  // Cues active at time t (seconds): start inclusive, end exclusive.
  function activeCaptionsAt(episode, tSeconds) {
    const t = Number(tSeconds);
    if (!Number.isFinite(t) || !hasCaptions(episode)) return [];
    return episode.captions.cues.filter((cue) => t >= cue.start && t < cue.end);
  }

  PDC.captions = {
    parseTimestamp,
    parseWebVTT,
    setCaptions,
    clearCaptions,
    hasCaptions,
    listCues,
    activeCaptionsAt,
  };
})();
