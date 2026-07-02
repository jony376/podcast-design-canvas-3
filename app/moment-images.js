// app/moment-images.js - browser-only runtime registry for uploaded b-roll PNGs.
// Episode/template data stores only image metadata; decoded pixels and object
// URLs live here for the current session and are released on removal/reset.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const images = new Map();

  function isPng(file) {
    if (!file) return false;
    if (file.type && file.type.toLowerCase() === "image/png") return true;
    return /\.png$/i.test(file.name || "");
  }

  function prepare(file) {
    if (!isPng(file)) {
      return { ok: false, error: "Upload a PNG image for the b-roll moment." };
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    const record = {
      ok: true,
      name: file.name || "b-roll.png",
      image,
      url,
      released: false,
      ready: null,
    };
    record.release = function () {
      if (record.released) return;
      record.released = true;
      URL.revokeObjectURL(record.url);
    };
    record.ready = new Promise((resolve, reject) => {
      image.addEventListener("load", () => {
        record.release();
        resolve(record);
      }, { once: true });
      image.addEventListener("error", () => {
        record.release();
        reject(new Error("The selected PNG could not be decoded."));
      }, { once: true });
    });
    image.decoding = "async";
    image.src = url;
    return record;
  }

  function register(momentId, prepared) {
    if (!momentId || !prepared || !prepared.ok) return false;
    release(momentId);
    images.set(momentId, {
      name: prepared.name,
      image: prepared.image,
    });
    return true;
  }

  function get(momentId) {
    const record = images.get(momentId);
    if (!record || !record.image || !record.image.complete || !record.image.naturalWidth) return null;
    return record;
  }

  function release(momentId) {
    images.delete(momentId);
  }

  function releasePrepared(prepared) {
    if (prepared && typeof prepared.release === "function") prepared.release();
  }

  function releaseAll() {
    images.clear();
  }

  PDC.momentImages = {
    isPng,
    prepare,
    register,
    get,
    release,
    releasePrepared,
    releaseAll,
  };
})();
