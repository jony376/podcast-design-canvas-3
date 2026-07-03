// app/riverside.js
// Pure Riverside-style share link parser: extracts synced speaker track URLs from a
// share link fragment without any network or account access. The fragment format is
// http(s) or data:video/* track URLs embedded in the share-link fragment — no
// external Riverside API, account sign-in, or separate track server required.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS } = PDC.presets;

  const FRAGMENT_KEY = "pdc-synced-tracks";

  function base64UrlDecode(encoded) {
    let b64 = String(encoded || "").replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return decodeURIComponent(escape(atob(b64)));
  }

  function base64UrlEncode(text) {
    const b64 = btoa(unescape(encodeURIComponent(String(text))));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function isRiversideHost(raw) {
    try {
      const u = new URL(String(raw || "").trim());
      return /(^|\.)riverside\.fm$/i.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  function isTrackUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return false;
    if (text.startsWith("data:")) {
      const mime = text.slice(5, text.indexOf(",")).split(";")[0].toLowerCase();
      return mime === "video/webm" || mime === "video/mp4" || mime.startsWith("video/");
    }
    try {
      const u = new URL(text);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function parseRiversideLink(raw) {
    const link = String(raw || "").trim();
    if (!link) return { ok: false, error: "Paste a Riverside episode share link first." };
    if (!isRiversideHost(link)) {
      return { ok: false, error: "That does not look like a Riverside share link." };
    }

    let hash = "";
    try {
      hash = new URL(link).hash || "";
    } catch (e) {
      return { ok: false, error: "That Riverside link could not be read." };
    }

    const prefix = "#" + FRAGMENT_KEY + "=";
    if (!hash.startsWith(prefix)) {
      return { ok: false, error: "This Riverside link does not include synced speaker track URLs." };
    }

    const encoded = hash.slice(prefix.length);
    if (!encoded) return { ok: false, error: "This Riverside link is missing synced track data." };

    let payload;
    try {
      payload = JSON.parse(base64UrlDecode(encoded));
    } catch (e) {
      return { ok: false, error: "The synced track data in this Riverside link is invalid." };
    }

    const tracksIn = payload && payload.tracks;
    if (!tracksIn || typeof tracksIn !== "object") {
      return { ok: false, error: "This Riverside link does not list any speaker tracks." };
    }

    const tracks = {};
    for (let i = 0; i < SPEAKER_BUCKETS.length; i++) {
      const bucket = SPEAKER_BUCKETS[i];
      const url = String(tracksIn[bucket] || "").trim();
      if (!url) continue;
      if (!isTrackUrl(url)) {
        return { ok: false, error: "Speaker track URL for " + bucket + " is not a valid track address." };
      }
      tracks[bucket] = url;
    }

    if (!tracks.host || !tracks.guest1) {
      return { ok: false, error: "This Riverside link needs Host and Guest 1 track URLs at minimum." };
    }

    return {
      ok: true,
      title: payload.title ? String(payload.title).trim() : "",
      tracks: tracks,
    };
  }

  function buildRiversideLink(tracks, opts) {
    const pathPart = (opts && opts.path) || "/studio/share/local-sync";
    const payload = { tracks: tracks };
    if (opts && opts.title) payload.title = opts.title;
    return "https://riverside.fm" + pathPart + "#" + FRAGMENT_KEY + "=" + base64UrlEncode(JSON.stringify(payload));
  }

  PDC.riverside = {
    FRAGMENT_KEY: FRAGMENT_KEY,
    isRiversideHost: isRiversideHost,
    isTrackUrl: isTrackUrl,
    parseRiversideLink: parseRiversideLink,
    buildRiversideLink: buildRiversideLink,
  };
})();
