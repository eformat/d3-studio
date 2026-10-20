/* d3 Studio — vanilla JS, no build step. One process, three modes:
 * text (choice / noul / score cards), vision (image + Box overlays), video
 * (Track scrubber). One read of the input answers every question: the run is
 * a single POST /v1/systemone. */

const $ = (id) => document.getElementById(id);
const state = {
  mode: "text",
  decks: [],
  credits: {},
  deck: null,
  questions: [],
  media: { images: [], videos: [], assets: {} },
  mediaReady: Promise.resolve(),
  ready: false,
  status: null,
  track: null,
  running: false,
};

/* Boxes are drawn in white, as returned, with a white chip label each — the
   chip names the question, the dashed low-confidence ones say to check. */
const BOX_COLOR = "#f5f5f7";

/* ---------- boot ---------- */

init();

async function init() {
  wireChrome();
  try {
    const [decks, status] = await Promise.all([
      fetchJSON("/api/examples"),
      fetchJSON("/api/status"),
    ]);
    state.decks = decks.decks || [];
    state.credits = decks.credits || {};
    state.status = status;
    renderModelCard(status);
    selectMode("text");
  } catch (err) {
    toast(`the studio API is unreachable: ${err.message}`);
  }
  pollReady();
  setInterval(pollReady, 4000);
}

function wireChrome() {
  $("mode-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".mode-tab");
    if (tab) selectMode(tab.dataset.mode);
  });
  $("chip-scroller").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (btn) selectDeck(state.decks.find((d) => d.id === btn.dataset.deck));
  });
  $("chip-prev").addEventListener("click", () =>
    $("chip-scroller").scrollBy({ left: -280, behavior: "smooth" }));
  $("chip-next").addEventListener("click", () =>
    $("chip-scroller").scrollBy({ left: 280, behavior: "smooth" }));
  $("chip-scroller").addEventListener("scroll", updateChipArrows, { passive: true });
  window.addEventListener("resize", updateChipArrows);
  $("model-card-btn").addEventListener("click", () => {
    const card = $("model-card");
    card.classList.toggle("hidden");
    card.setAttribute("aria-hidden", card.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    const card = $("model-card");
    if (!card.classList.contains("hidden")
        && !card.contains(e.target) && e.target !== $("model-card-btn")
        && !$("model-card-btn").contains(e.target)) {
      card.classList.add("hidden");
      card.setAttribute("aria-hidden", "true");
    }
  });
  $("add-question").addEventListener("click", () => {
    state.questions.push({ id: nextQuestionId(), type: "choice", instructions: "", criteria: {} });
    renderQuestionCards();
  });
  $("question-cards").addEventListener("click", (e) => {
    const remove = e.target.closest(".q-remove");
    if (!remove) return;
    const card = remove.closest(".q-card");
    state.questions = state.questions.filter((q) => q.id !== card.dataset.qid);
    renderQuestionCards();
  });
  $("question-cards").addEventListener("input", (e) => syncQuestionInput(e));
  $("question-cards").addEventListener("click", (e) => {
    if (e.target.classList.contains("q-crit-add")) {
      const card = e.target.closest(".q-card");
      const q = state.questions.find((x) => x.id === card.dataset.qid);
      if (!q) return;
      if (q.type === "choice") {
        const key = `opt${Object.keys(q.criteria || {}).length + 1}`;
        q.criteria = { ...(q.criteria || {}), [key]: "" };
      } else if (q.type === "score") {
        q.levels = [...(q.levels || []), ""];
      } else if (q.type === "noul") {
        q.criteria = { ...(q.criteria || {}), false: "", true: "" };
      }
      renderQuestionCards();
    }
  });
  $("run-btn").addEventListener("click", run);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
  $("media-upload").addEventListener("change", onMediaUpload);
  $("media-apply").addEventListener("click", onMediaUrl);
  $("scrub-range").addEventListener("input", onScrub);
  $("track-play").addEventListener("click", () => {
    const video = $("stage-video");
    if (video.paused) video.play(); else video.pause();
  });
  $("stage-video").addEventListener("loadedmetadata", onVideoReady);
  $("stage-video").addEventListener("play", () => {
    syncPlayGlyph();
    if (state.track) startTrackFrames();
  });
  $("stage-video").addEventListener("pause", () => {
    syncPlayGlyph();
    stopTrackFrames();
    const video = $("stage-video");
    if (state.track) {
      $("scrub-range").value = Math.round(video.currentTime * 10);
      drawTrackAt(video.currentTime);
      drawVisibleCurve(video.currentTime);
    }
  });
}

/* While the clip plays, the box, the scrubber and the curve playhead follow
   the video frame by frame (rAF; timeupdate alone is too coarse to track). */
let trackRaf = 0;
function startTrackFrames() {
  if (!trackRaf) trackRaf = requestAnimationFrame(trackFrame);
}
function stopTrackFrames() {
  if (trackRaf) cancelAnimationFrame(trackRaf);
  trackRaf = 0;
}
function trackFrame() {
  trackRaf = 0;
  const video = $("stage-video");
  if (video.paused || video.ended || !state.track) return;
  $("scrub-range").value = Math.round(video.currentTime * 10);
  drawTrackAt(video.currentTime);
  drawVisibleCurve(video.currentTime);
  trackRaf = requestAnimationFrame(trackFrame);
}

function syncPlayGlyph() {
  const btn = $("track-play");
  if (btn) btn.textContent = $("stage-video").paused ? "▶" : "⏸";
}

function onScrub(e) {
  const video = $("stage-video");
  const value = Number(e.target.value) / 10; /* the range spans duration × 10 */
  if (video.duration && isFinite(video.duration)) video.currentTime = value;
  if (state.track) {
    drawTrackAt(value);
    drawVisibleCurve(value);
  }
}

/* ---------- readiness ---------- */

async function pollReady() {
  let body = null;
  try {
    const r = await fetch("/api/ready");
    body = await r.json();
    state.ready = r.ok && body.status === "ready";
  } catch {
    state.ready = false;
    body = { status: "offline" };
  }
  const badge = $("ready-badge");
  const s = body.status;
  if (state.ready) {
    badge.textContent = "live";
    badge.className = "badge badge-ready";
  } else if (["starting", "loading", "warming"].includes(s)) {
    badge.textContent = `${s}…`;
    badge.className = "badge badge-starting";
  } else {
    badge.textContent = s || "offline";
    badge.className = "badge badge-offline";
  }
  $("run-btn").disabled = !state.ready || state.running;
  let note = $("run-note");
  if (!state.ready && s && s !== "ready") {
    showOfflineNote(body);
  } else {
    hideOfflineNote();
    if (state.ready) note.textContent = "";
  }
}

let offlineEl = null;
function showOfflineNote(body) {
  if (!offlineEl) {
    offlineEl = document.createElement("div");
    offlineEl.className = "offline-note";
    $("run-btn").closest(".run-row").before(offlineEl);
  }
  const reason = body.reason ? ` (${body.reason})` : "";
  offlineEl.textContent = `The model is ${body.status}${reason}. The studio answers replays; live runs resume when it is ready.`;
}
function hideOfflineNote() {
  if (offlineEl) { offlineEl.remove(); offlineEl = null; }
}

/* ---------- model card ---------- */

function renderModelCard(status) {
  $("mc-name").textContent = status?.model?.served_name || "d3-turbo";
  const spec = status?.model || {};
  const facts = [];
  if (spec.source === "package") facts.push(["source", "local package (fixture)"]);
  if (spec.source === "hub") {
    facts.push(["model", spec.model || "—"]);
    facts.push(["revision", (spec.revision || "—").slice(0, 12)]);
  }
  facts.push(["device", spec.device || "—"]);
  const limits = status?.limits || {};
  facts.push(["questions", `${limits.questions ?? "—"} per request`]);
  facts.push(["states", `${limits.states ?? "—"} per request`]);
  facts.push(["images", `${limits.images ?? "—"} × ${fmtBytes(limits.image_max_bytes)}`]);
  facts.push(["videos", `${limits.videos ?? "—"} × ${limits.video_max_seconds ?? "—"}s`]);
  $("mc-facts").innerHTML = facts
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHTML(String(v))}</dd>`).join("");
  $("mc-source").textContent = "Probabilities per answer; exactly one box even when the object is absent — pair Box with a yes / no question when it may be missing.";
}

/* ---------- decks ---------- */

function renderChips() {
  const scroller = $("chip-scroller");
  const inMode = state.decks.filter((d) => d.mode === state.mode);
  scroller.innerHTML = inMode
    .map((d) => `<button class="chip${state.deck?.id === d.id ? " active" : ""}" data-deck="${d.id}" title="${escapeHTML(d.id)}">${escapeHTML(d.title)}</button>`)
    .join("") || `<span class="muted tiny">No ${state.mode} decks yet.</span>`;
  updateChipArrows();
}

function updateChipArrows() {
  const sc = $("chip-scroller");
  if (!sc) return;
  $("chip-prev").disabled = sc.scrollLeft <= 4;
  $("chip-next").disabled = sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 4;
}

function deckCountLine(deck) {
  const n = Object.keys(deck.questions || {}).length;
  const media = state.mode === "text" ? "1 message"
    : state.mode === "vision"
      ? `${(deck.images || []).length || 1} photo${(deck.images || []).length > 1 ? "s" : ""}`
      : `${(deck.videos || []).length || 1} clip${(deck.videos || []).length > 1 ? "s" : ""}`;
  return `${media} · ${n} question${n === 1 ? "" : "s"} · one read`;
}

function renderCredits(deck) {
  const host = $("media-credits");
  if (!host) return;
  const files = new Set();
  (deck?.images || []).forEach((s) => s?.file && files.add(s.file));
  (deck?.videos || []).forEach((s) => s?.file && files.add(s.file));
  Object.values(deck?.assets || {}).forEach((s) => s?.file && files.add(s.file));
  const parts = [...files].map((f) => {
    const c = state.credits[f];
    return c ? `${c.title} — ${c.artist} · ${c.license}` : f;
  });
  host.textContent = parts.length ? `Media: ${parts.join("  ·  ")}` : "";
}

function selectMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode));
  const inMode = state.decks.filter((d) => d.mode === mode);
  selectDeck(inMode[0] || null);
}

async function selectDeck(deck) {
  state.deck = deck;
  state.track = null;
  state.media = { images: [], videos: [], assets: {} };
  $("deck-title").textContent = deck ? deck.title : "—";
  $("deck-desc").textContent = deck ? deck.description || "" : "";
  $("deck-count").textContent = deck ? deckCountLine(deck) : "";
  renderCredits(deck);
  renderChips();
  if (!deck) {
    $("state-input").value = "";
    state.questions = [];
    renderQuestionCards();
    setMediaVisibility();
    state.mediaReady = Promise.resolve();
    return;
  }
  $("state-input").value = deck.state || "";
  state.questions = deepCopyQuestions(deck.questions);
  renderQuestionCards();
  setMediaVisibility();
  clearResults();
  /* The run waits for this: Box / Track questions need the deck media in the
     request, and a user hitting run right after a mode switch must not race
     the /media fetch (a confusing box_needs_image 422). */
  state.mediaReady = loadDeckMedia(deck);
  await state.mediaReady;
}

function deepCopyQuestions(questions) {
  return Object.entries(questions || {}).map(([id, q]) => ({
    id, type: q.type, instructions: q.instructions ?? "",
    criteria: q.criteria ? { ...q.criteria } : undefined,
    levels: q.levels ? [...q.levels] : undefined,
    rate: q.rate, at: q.at,
  }));
}

function setMediaVisibility() {
  const isVision = state.mode === "vision";
  const isVideo = state.mode === "video";
  $("media-panel").classList.toggle("hidden", !(isVision || isVideo));
  $("image-stage").classList.toggle("hidden", !isVision);
  $("video-stage").classList.toggle("hidden", !isVideo);
  $("track-scrub").classList.toggle("hidden", !isVideo);
}

async function loadDeckMedia(deck) {
  try {
    const imageFiles = [...(deck.images || []), ...Object.values(deck.assets || {})]
      .filter((s) => /\.(jpe?g|png|webp|gif)$/i.test(s.file || ""));
    const videoFiles = (deck.videos || []).filter((s) => /\.(webm|mp4|mov|mkv)$/i.test(s.file || ""));
    const assetRefs = Object.keys(deck.assets || {}).filter((ref) =>
      /\.(jpe?g|png|webp|gif)$/i.test(deck.assets[ref].file || ""));
    const [images, videos, assetUrls] = await Promise.all([
      Promise.all((deck.images || []).map((s) => mediaDataURL(s.file))),
      Promise.all(videoFiles.map((s) => mediaDataURL(s.file))),
      Promise.all(assetRefs.map(async (ref) => [ref, await mediaDataURL(deck.assets[ref].file)])),
    ]);
    state.media.images = images;
    state.media.videos = videos;
    state.media.assets = Object.fromEntries(assetUrls);
    if (isVision()) await showDeckImage(deck, images, assetUrls);
    if (isVideo() && videos[0]) await showDeckVideo(videos[0]);
  } catch (err) {
    toast(`media failed to load: ${err.message}`, "warn");
  }
}

function isVision() { return state.mode === "vision"; }
function isVideo() { return state.mode === "video"; }

async function showDeckImage(deck, images, assetUrls) {
  const img = $("stage-image");
  const assets = Object.fromEntries(assetUrls);
  let src = images[0] || null;
  if (!src && deck.show?.image) src = assets[deck.show.image] || null;
  if (!src && assetUrls.length) src = assetUrls[0][1];
  if (!src) { img.removeAttribute("src"); return; }
  await setImageSrc(img, src);
  clearOverlays();
}

async function showDeckVideo(dataUrl) {
  const video = $("stage-video");
  video.src = dataUrl;
  await new Promise((resolve) => {
    if (video.readyState >= 1) return resolve();
    video.addEventListener("loadedmetadata", resolve, { once: true });
  });
  video.currentTime = 0;
  state.track = null;
  clearOverlays();
}

function setImageSrc(img, src) {
  return new Promise((resolve) => {
    if (img.src === src && img.complete) return resolve();
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
    img.src = src;
  });
}

async function mediaDataURL(file) {
  const r = await fetch(`/media/${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const blob = await r.blob();
  return await blobToDataURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(blob);
  });
}

/* ---------- media controls ---------- */

async function onMediaUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const dataUrl = await blobToDataURL(file);
  applyUserMedia(dataUrl, file.type);
  e.target.value = "";
}

async function onMediaUrl() {
  const raw = $("media-url").value.trim();
  if (!raw) return;
  if (raw.startsWith("data:")) { applyUserMedia(raw); return; }
  try {
    const r = await fetch(raw);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    applyUserMedia(await blobToDataURL(await r.blob()));
  } catch (err) {
    $("media-note").textContent = `fetch failed (${err.message}) — the server must allow CORS; paste a data: URL instead`;
  }
}

async function applyUserMedia(dataUrl) {
  clearResults();
  if (isVision()) {
    await setImageSrc($("stage-image"), dataUrl);
    state.media.images = [dataUrl];
    state.media.videos = [];
    $("media-note").textContent = "using your image";
  } else if (isVideo()) {
    const video = $("stage-video");
    video.src = dataUrl;
    state.media.videos = [dataUrl];
    state.media.images = [];
    state.track = null;
    $("media-note").textContent = "using your clip";
  }
}

/* ---------- question cards ---------- */

function nextQuestionId() {
  const used = new Set(state.questions.map((q) => q.id));
  for (let i = 1; ; i++) if (!used.has(`q${i}`)) return `q${i}`;
}

function renderQuestionCards() {
  const host = $("question-cards");
  host.innerHTML = state.questions.map((q, i) => {
    const typeOpts = ["choice", "noul", "score", ...(isVision() || isVideo() ? ["box", "track"] : [])]
      .map((t) => `<option value="${t}"${q.type === t ? " selected" : ""}>${t}</option>`).join("");
    return `<div class="q-card" data-qid="${q.id}">
      <div class="q-card-head">
        <input class="q-name" data-field="id" value="${escapeHTML(q.id)}" spellcheck="false" aria-label="question id">
        <select class="q-type" data-field="type" aria-label="question type">${typeOpts}</select>
        <button class="q-remove" title="remove" aria-label="remove">✕</button>
      </div>
      <textarea data-field="instructions" placeholder="${q.type === "box" ? "What to locate (required)" : "The question (asked once, answered with every other)"}">${escapeHTML(q.instructions || "")}</textarea>
      ${q.type === "choice" ? criteriaEditor(q) : ""}
      ${q.type === "noul" ? criteriaEditor(q) : ""}
      ${q.type === "score" ? levelsEditor(q) : ""}
      ${q.type === "track" ? `<div class="q-criteria"><div class="q-crit-row"><label class="muted tiny">rate <select class="q-type" data-field="rate">
          <option value="1"${q.rate !== 2 ? " selected" : ""}>1/s</option>
          <option value="2"${q.rate === 2 ? " selected" : ""}>2/s</option></select></label></div></div>` : ""}
    </div>`;
  }).join("") || `<p class="muted tiny">No questions — add one.</p>`;
}

function criteriaEditor(q) {
  const rows = Object.entries(q.criteria || {}).map(([key, desc], i) => `
    <div class="q-crit-row">
      <input class="crit-key" data-field="crit-key" data-orig="${escapeHTML(key)}" value="${escapeHTML(key)}" aria-label="option key">
      <input data-field="crit-desc" data-orig="${escapeHTML(key)}" value="${escapeHTML(desc ?? "")}" placeholder="${isVideo() ? "" : "description"}" aria-label="option description">
      <button class="q-crit-add" data-remove-crit="${escapeHTML(key)}" title="remove option">✕</button>
    </div>`).join("");
  return `<div class="q-criteria">${rows}
    <button class="q-crit-add">+ option</button></div>`;
}

function levelsEditor(q) {
  const rows = (q.levels || []).map((lvl, i) => `
    <div class="q-crit-row q-levels">
      <input data-field="level" data-idx="${i}" value="${escapeHTML(lvl ?? "")}" placeholder="level ${i}" aria-label="level">
      <button class="q-crit-add" data-remove-level="${i}" title="remove level">✕</button>
    </div>`).join("");
  return `<div class="q-criteria">${rows}
    <button class="q-crit-add">+ level</button></div>`;
}

function syncQuestionInput(e) {
  const card = e.target.closest(".q-card");
  if (!card) return;
  const q = state.questions.find((x) => x.id === card.dataset.qid);
  if (!q) return;
  const field = e.target.dataset.field;
  if (field === "id") {
    const fresh = e.target.value.trim();
    if (fresh && !state.questions.some((x) => x.id === fresh && x !== q)) q.id = fresh;
    card.dataset.qid = q.id;
  } else if (field === "type") {
    const was = q.type;
    q.type = e.target.value;
    if (was === "choice" && q.type === "noul" && q.criteria) {
      const entries = Object.entries(q.criteria);
      if (entries.length) q.criteria = Object.fromEntries(entries);
    }
    if (q.type === "choice" && !q.criteria) q.criteria = {};
    if (q.type === "score" && !q.levels) q.levels = ["low", "high"];
    renderQuestionCards();
  } else if (field === "instructions") {
    q.instructions = e.target.value;
  } else if (field === "rate") {
    q.rate = Number(e.target.value);
  } else if (field === "crit-key") {
    const orig = e.target.dataset.orig;
    const fresh = e.target.value.trim() || orig;
    const entries = Object.entries(q.criteria || {});
    const desc = entries.find(([k]) => k === orig)?.[1];
    q.criteria = Object.fromEntries([...entries.filter(([k]) => k !== orig), [fresh, desc]]);
  } else if (field === "crit-desc") {
    const key = e.target.dataset.orig;
    if (q.criteria && key in q.criteria) q.criteria[key] = e.target.value;
  } else if (field === "level") {
    const idx = Number(e.target.dataset.idx);
    if (q.levels && idx < q.levels.length) q.levels[idx] = e.target.value;
  }
}

document.addEventListener("click", (e) => {
  const removeCrit = e.target.closest("[data-remove-crit]");
  if (removeCrit) {
    const card = removeCrit.closest(".q-card");
    const q = state.questions.find((x) => x.id === card.dataset.qid);
    if (q?.criteria) { delete q.criteria[removeCrit.dataset.removeCrit]; renderQuestionCards(); }
    return;
  }
  const removeLevel = e.target.closest("[data-remove-level]");
  if (removeLevel) {
    const card = removeLevel.closest(".q-card");
    const q = state.questions.find((x) => x.id === card.dataset.qid);
    if (q?.levels) { q.levels.splice(Number(removeLevel.dataset.removeLevel), 1); renderQuestionCards(); }
  }
});

/* ---------- run ---------- */

function buildRequest() {
  const request = { state: $("state-input").value, questions: {} };
  for (const q of state.questions) {
    const question = { type: q.type, instructions: q.instructions };
    if (q.type === "choice" || q.type === "noul") {
      if (q.criteria && Object.keys(q.criteria).length) question.criteria = q.criteria;
    } else if (q.type === "score") {
      if (q.levels?.length) question.levels = q.levels;
    } else if (q.type === "track") {
      if (q.rate) question.rate = q.rate;
    }
    request.questions[q.id] = question;
  }
  if ($("long-ctx")?.checked) request.options = { long_context: true };
  if (state.media.images.length) request.images = state.media.images;
  if (state.media.videos.length) request.videos = state.media.videos;
  const assetRefs = usedAssetRefs();
  if (assetRefs.length) {
    request.assets = Object.fromEntries(assetRefs.map((ref) => [
      ref, { type: "image", data_base64: base64Of(state.media.assets[ref]) },
    ]));
  }
  return request;
}

function base64Of(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function usedAssetRefs() {
  const refs = new Set();
  if (state.deck?.show?.options) state.deck.show.options.forEach((r) => refs.add(r));
  if (state.deck?.show?.image) refs.add(state.deck.show.image);
  return [...refs].filter((ref) => state.media.assets[ref]);
}

async function run() {
  if (!state.ready || state.running) return;
  if (!state.questions.length) { toast("add a question first"); return; }
  state.running = true;
  $("run-btn").disabled = true;
  $("run-note").textContent = "one read of the input…";
  const t0 = performance.now();
  try {
    /* Box / Track questions need the deck media; a run fired right after a
       mode switch waits for the /media fetch instead of racing it. */
    await state.mediaReady;
    const r = await fetch("/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest()),
    });
    const elapsed = performance.now() - t0;
    const body = await r.json();
    if (!r.ok) {
      const message = body?.error?.message || body?.detail || JSON.stringify(body).slice(0, 200);
      toast(`HTTP ${r.status}: ${message}`);
      $("run-note").textContent = "";
      if (String(message).includes("max_length_exceeded") && !$("long-ctx").checked) {
        $("run-note").textContent = "the question ran over the token budget — try the long context toggle";
        $("long-ctx").closest("label").style.color = "var(--warn)";
      }
      return;
    }
    renderAnswers(body.answers || {}, elapsed, r.headers);
  } catch (err) {
    toast(`run failed: ${err.message}`);
    $("run-note").textContent = "";
  } finally {
    state.running = false;
    $("run-btn").disabled = !state.ready;
  }
}

/* ---------- results ---------- */

function clearResults() {
  $("results").innerHTML = `<p class="muted" id="results-empty">Run a deck — every question is answered in one read of the input.</p>`;
  $("result-timing").textContent = "";
  clearOverlays();
  $("track-scrub").classList.add("hidden");
}

function clearOverlays() {
  $("box-layer").innerHTML = "";
  $("track-layer").innerHTML = "";
}

function renderAnswers(answers, elapsedMs, headers) {
  const host = $("results");
  const names = Object.keys(answers);
  clearOverlays();
  host.innerHTML = names.map((id) => {
    const a = answers[id];
    if (a.type === "box") return boxAnswer(id, a);
    if (a.type === "track") return trackAnswer(id, a);
    if (a.type === "choice") return choiceAnswer(id, a);
    if (a.type === "score") return scoreAnswer(id, a);
    return noulAnswer(id, a);
  }).join("") || `<p class="muted">No answers.</p>`;
  const timing = serverTiming(headers);
  const ms = timing?.total || elapsedMs;
  $("result-timing").textContent = `${fmtMs(ms)} · ${names.length} answers · one read`;
  if (state.mode === "vision") drawBoxes(answers);
  if (state.mode === "video") wireTrack(answers);
  $("run-note").textContent = "";
}

function confClass(c) { return c >= 0.5 ? "conf-high" : c >= 0.15 ? "conf-mid" : "conf-low"; }
function confPill(c) { return `<span class="conf-pill ${confClass(c)}">conf ${fmtProb(c)}</span>`; }

function choiceAnswer(id, a) {
  const entries = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
  const win = a.choice ?? entries[0]?.[0];
  const optionImages = optionImagesFor(id);
  return `<div class="answer-card">
    <div class="answer-head">
      <span class="answer-name">${escapeHTML(id)}</span>
      <span class="answer-type-tag">${a.type}</span>
    </div>
    <div class="bars">${entries.map(([key, p]) => `
      <div class="bar-row">
        <span class="bar-key${key === win ? " win" : ""}" title="${escapeHTML(criterionLabel(id, key))}">${escapeHTML(criterionLabel(id, key))}</span>
        <div class="bar-track"><div class="bar-fill${key === win ? " win" : ""}" style="width:${(p * 100).toFixed(1)}%"></div></div>
        <span class="bar-val${key === win ? " win" : ""}">${fmtProb(p)}</span>
      </div>`).join("")}</div>
    ${optionImages ? `<div class="option-thumbs">${optionImages}</div>` : ""}
    <div class="answer-note">${confPill(a.confidence ?? 0)} <span class="muted tiny">picked “${escapeHTML(String(win))}”</span></div>
  </div>`;
}

function optionImagesFor(id) {
  if (state.mode !== "vision" || !state.deck) return null;
  const show = state.deck.show;
  if (!show?.options || !Array.isArray(show.options)) return null;
  return show.options.map((ref, i) => {
    const url = state.media.assets[ref];
    if (!url) return "";
    return `<div class="option-thumb" data-ref="${escapeHTML(ref)}">
      <img src="${url}" alt="option ${i}">
      <span class="opt-key">${escapeHTML(ref)}</span></div>`;
  }).join("") || null;
}

function criterionLabel(id, key) {
  const q = state.questions.find((x) => x.id === id);
  if (q?.criteria && key in q.criteria) {
    const desc = q.criteria[key];
    if (typeof desc === "string" && desc && !desc.startsWith("<")) return desc;
  }
  return key;
}

function noulAnswer(id, a) {
  const p = clamp01(a.noul ?? 0);
  const yes = p >= 0.5;
  return `<div class="answer-card">
    <div class="answer-head">
      <span class="answer-name">${escapeHTML(id)}</span>
      <span class="answer-type-tag">noul</span>
    </div>
    <div class="bars">
      <div class="bar-row"><span class="bar-key${yes ? " win" : ""}">yes</span>
        <div class="bar-track"><div class="bar-fill${yes ? " win" : ""}" style="width:${(p * 100).toFixed(1)}%"></div></div>
        <span class="bar-val${yes ? " win" : ""}">${fmtProb(p)}</span></div>
      <div class="bar-row"><span class="bar-key${!yes ? " win" : ""}">no</span>
        <div class="bar-track"><div class="bar-fill${!yes ? " win" : ""}" style="width:${((1 - p) * 100).toFixed(1)}%"></div></div>
        <span class="bar-val${!yes ? " win" : ""}">${fmtProb(1 - p)}</span></div>
    </div>
    <div class="answer-note"><span class="muted tiny">probability of “yes”</span></div>
  </div>`;
}

function scoreAnswer(id, a) {
  const legend = a.legend || {};
  const entries = Object.entries(a.probabilities || {});
  const levels = entries.map(([idx, p]) => [legend[idx] ?? idx, p]);
  const win = levels.reduce((best, cur) => (cur[1] > best[1] ? cur : best), levels[0] || ["—", 0]);
  return `<div class="answer-card">
    <div class="answer-head">
      <span class="answer-name">${escapeHTML(id)}</span>
      <span class="answer-type-tag">score</span>
    </div>
    <div class="bars">${levels.map(([name, p]) => `
      <div class="bar-row">
        <span class="bar-key${name === win[0] ? " win" : ""}">${escapeHTML(String(name))}</span>
        <div class="bar-track"><div class="bar-fill${name === win[0] ? " win" : ""}" style="width:${(p * 100).toFixed(1)}%"></div></div>
        <span class="bar-val${name === win[0] ? " win" : ""}">${fmtProb(p)}</span>
      </div>`).join("")}</div>
    <div class="answer-note">score <b class="mono">${fmtScore(a.score)}</b> <span class="muted tiny">(expected level)</span></div>
  </div>`;
}

function boxAnswer(id, a) {
  const conf = a.confidence ?? 0;
  return `<div class="answer-card">
    <div class="answer-head">
      <span class="answer-name">${escapeHTML(id)}</span>
      <span class="answer-type-tag">box</span>
    </div>
    <div class="answer-note">${confPill(conf)}
      <span class="mono tiny"> box(${fmtFrac(a.box?.top)}, ${fmtFrac(a.box?.left)}) → (${fmtFrac(a.box?.bottom)}, ${fmtFrac(a.box?.right)})</span>
      <span class="muted tiny"> — fractions of the image</span></div>
  </div>`;
}

function drawBoxes(answers) {
  const layer = $("box-layer");
  const img = $("stage-image");
  layer.innerHTML = "";
  if (!img.complete || !img.naturalWidth) return;
  for (const [id, a] of Object.entries(answers)) {
    if (a.type !== "box" || !a.box) continue;
    const conf = a.confidence ?? 0;
    const top = clamp01(a.box.top) * 100, bottom = clamp01(a.box.bottom) * 100;
    const left = clamp01(a.box.left) * 100, right = clamp01(a.box.right) * 100;
    const rect = document.createElement("div");
    rect.className = "box-rect" + (conf < 0.5 ? " low" : "");
    rect.style.cssText = `top:${top}%;left:${left}%;width:${right - left}%;height:${bottom - top}%;`;
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = `${id} ${fmtProb(conf)}`;
    if (bottom > 92) label.classList.add("flip"); /* the chip would leave the stage */
    rect.appendChild(label);
    layer.appendChild(rect);
  }
}

function trackAnswer(id, a) {
  const track = a.track || [];
  const visible = track.filter((t) => (t.visible ?? 0) >= 0.5).length;
  return `<div class="answer-card">
    <div class="answer-head">
      <span class="answer-name">${escapeHTML(id)}</span>
      <span class="answer-type-tag">track</span>
    </div>
    <div class="track-summary">
      <span class="track-stat">points <b>${track.length}</b></span>
      <span class="track-stat">visible <b>${visible}</b>/${track.length}</span>
      <span class="track-stat">span <b>${track.length ? fmtSec(track[0].time) + " → " + fmtSec(track[track.length - 1].time) : "—"}</b></span>
    </div>
    <div class="answer-note"><span class="muted tiny">Scrub the clip — the box follows the target, the curve is the probability it is visible.</span></div>
  </div>`;
}

function wireTrack(answers) {
  const trackEntry = Object.entries(answers).find(([, a]) => a.type === "track");
  if (!trackEntry) return;
  state.track = { id: trackEntry[0], points: trackEntry[1].track || [] };
  $("track-scrub").classList.remove("hidden");
  const video = $("stage-video");
  onVideoReady();
  if (video.currentTime > 0) drawTrackAt(video.currentTime);
  drawVisibleCurve();
}

function onVideoReady() {
  const video = $("stage-video");
  if (video.duration && isFinite(video.duration)) {
    $("scrub-range").max = Math.round(video.duration * 10);
    if (state.track) {
      drawTrackAt(video.currentTime);
      drawVisibleCurve();
    }
  }
}

function drawTrackAt(timeSec) {
  const t = state.track;
  if (!t || !t.points.length) return;
  let best = t.points[0];
  for (const p of t.points) if (Math.abs(p.time - timeSec) < Math.abs(best.time - timeSec)) best = p;
  const layer = $("track-layer");
  layer.innerHTML = "";
  const video = $("stage-video");
  if (!video.videoWidth) return;
  const top = clamp01(best.box?.top) * 100, bottom = clamp01(best.box?.bottom) * 100;
  const left = clamp01(best.box?.left) * 100, right = clamp01(best.box?.right) * 100;
  const rect = document.createElement("div");
  rect.className = "box-rect" + ((best.visible ?? 0) < 0.5 ? " low" : "");
  rect.style.cssText = `top:${top}%;left:${left}%;width:${right - left}%;height:${bottom - top}%;`;
  const label = document.createElement("span");
  label.className = "box-label";
  label.textContent = `${t.id} @${fmtSec(best.time)} vis ${fmtProb(best.visible ?? 0)}`;
  if (bottom > 92) label.classList.add("flip");
  rect.appendChild(label);
  layer.appendChild(rect);
  $("scrub-time").textContent = fmtSec(timeSec);
  $("scrub-visible").textContent = `visible ${fmtProb(best.visible ?? 0)}`;
}

function drawVisibleCurve(nowSec) {
  const t = state.track;
  const canvas = $("visible-canvas");
  if (!t || !t.points.length || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.height;
  canvas.width = w;
  ctx.clearRect(0, 0, w, h);
  const times = t.points.map((p) => p.time);
  const t0 = Math.min(...times), t1 = Math.max(...times) || 1;
  ctx.strokeStyle = "#f5f5f7";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  t.points.forEach((p, i) => {
    const x = ((p.time - t0) / (t1 - t0)) * (w - 8) + 4;
    const y = h - 4 - clamp01(p.visible ?? 0) * (h - 10);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#86868b";
  ctx.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono");
  ctx.fillText(`visible probability, ${fmtSec(t0)}s → ${fmtSec(t1)}s`, 6, 12);
  /* the playhead — where the clip is right now */
  if (nowSec != null) {
    const x = clamp01((nowSec - t0) / (t1 - t0)) * (w - 8) + 4;
    ctx.strokeStyle = "rgba(233, 26, 34, .9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x, h - 2);
    ctx.stroke();
  }
}

/* ---------- helpers ---------- */

async function fetchJSON(url, options) {
  const r = await fetch(url, options);
  const body = await r.json();
  if (!r.ok) throw new Error(body?.detail || body?.error?.message || `HTTP ${r.status}`);
  return body;
}

function serverTiming(headers) {
  const raw = headers?.get("server-timing");
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^([^;]+);dur=([\d.]+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function toast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.className = kind === "warn" ? "toast warn" : "toast";
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 6000);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const fmtProb = (p) => (Number(p) || 0).toFixed(3);
const fmtScore = (s) => (Number(s) || 0).toFixed(2);
const fmtFrac = (f) => (Number(f) || 0).toFixed(3);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
const fmtSec = (s) => `${(Number(s) || 0).toFixed(2)}s`;
const fmtBytes = (b) => (!b ? "—" : b >= (1 << 20) ? `${(b / (1 << 20)).toFixed(0)} MiB` : `${(b / 1024).toFixed(0)} KiB`);
