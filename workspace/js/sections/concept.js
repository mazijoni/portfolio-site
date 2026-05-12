/**
 * sections/concept.js — Concept Art Studio.
 *
 * Draw freehand over reference images from the project's Media tab.
 * Single-layer drawing (no frames), auto-saved to Firestore.
 *
 * Firestore:
 *   users/{uid}/projects/{pid}/concepts/{conceptId}
 *     - name:      string
 *     - refUrl:    string  (reference image URL from media)
 *     - strokes:   Stroke[]  (flat stroke records — same format as animation)
 *     - thumbnail: string | null  (240×135 JPEG, client-generated)
 *     - createdAt: serverTimestamp
 *     - updatedAt: serverTimestamp
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc,
    doc, query, orderBy, serverTimestamp, getDocs, collection, where
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                from "../app.js";
import { currentProjectId,
         currentProject, getDataUid, canCurrentUserEdit } from "../projects.js";
import { escHtml, toast, confirm,
         openModal, closeModal }    from "../ui.js";

const CANVAS_W = 960;
const CANVAS_H = 540;

/* ================================================================ STATE == */

let _pid     = null;
let _uid     = null;
let _canEdit = true;

let _concepts = [];
let _unsub    = null;

let _curConceptId = null;
let _strokes      = [];
let _curStroke    = null;
let _isDrawing    = false;
let _dirty        = false;
let _saveTimer    = null;

let _tool      = "draw";
let _color     = "#ff0000";
let _brushSize = 4;

let _mediaLinks = [];

/* DOM refs */
let _canvasEl  = null;
let _ctx       = null;
let _refImgEl  = null;

let _init = false;

/* ================================================================ FIRESTORE HELPERS == */

const _conceptsRef = () => collection(db, "users", _uid, "projects", _pid, "concepts");
const _conceptDoc  = (id) => doc(db, "users", _uid, "projects", _pid, "concepts", id);

/* ================================================================ INIT == */

export function init() {
    if (_init) return;
    _init = true;

    _canvasEl = document.getElementById("concept-canvas");
    _refImgEl = document.getElementById("concept-ref-img");
    if (!_canvasEl) return;

    _canvasEl.width  = CANVAS_W;
    _canvasEl.height = CANVAS_H;
    _ctx = _canvasEl.getContext("2d");

    /* Seed from current project at init time */
    _uid     = getDataUid();
    _pid     = currentProjectId;
    _canEdit = canCurrentUserEdit();

    _setupToolbar();
    _setupDrawing();
    _setupNewConceptModal();

    if (_uid && _pid) _subscribe();

    window.addEventListener("projectSelected", () => {
        _uid     = getDataUid();
        _pid     = currentProjectId;
        _canEdit = canCurrentUserEdit();

        if (_unsub) { _unsub(); _unsub = null; }
        _concepts = [];
        _backToGallery(true);
        if (_uid && _pid) _subscribe();
    });

    window.addEventListener("sectionActivated", ({ detail }) => {
        if (detail.section !== "concept") return;
        _uid     = getDataUid();
        _pid     = currentProjectId;
        _canEdit = canCurrentUserEdit();
        if (!_unsub && _uid && _pid) _subscribe();
    });
}

/* ================================================================ SUBSCRIBE == */

function _subscribe() {
    if (!_uid || !_pid) return;
    if (_unsub) _unsub();
    const q = query(_conceptsRef(), orderBy("createdAt", "asc"));
    _unsub = onSnapshot(q, (snap) => {
        _concepts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderGallery();
        /* Refresh name display if currently editing */
        if (_curConceptId) {
            const c = _concepts.find(x => x.id === _curConceptId);
            const nameEl = document.getElementById("concept-name-display");
            if (c && nameEl) nameEl.textContent = c.name || "Untitled";
        }
    }, err => console.error("[concept] subscribe:", err));
}

/* ================================================================ GALLERY == */

function _showGallery() {
    const gal = document.getElementById("concept-gallery");
    const ed  = document.getElementById("concept-editor");
    if (gal) gal.style.display = "";
    if (ed)  ed.style.display  = "none";
}

function _showEditor() {
    const gal = document.getElementById("concept-gallery");
    const ed  = document.getElementById("concept-editor");
    if (gal) gal.style.display = "none";
    if (ed)  ed.style.display  = "";
}

function _renderGallery() {
    const cardsEl = document.getElementById("concept-cards");
    const emptyEl = document.getElementById("concept-empty");
    if (!cardsEl) return;

    cardsEl.innerHTML = "";

    if (!_concepts.length) {
        if (emptyEl) emptyEl.style.display = "";
        return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    _concepts.forEach(concept => {
        const card = document.createElement("div");
        card.className = "concept-card";
        card.dataset.id = concept.id;

        /* Layer 1 (reference) lives in Firestore only as a URL.
           Layer 2 (strokes) thumbnail is transparent PNG — never merged.
           The card composites them with CSS so nothing is written merged. */
        const hasRef   = !!concept.refUrl;
        const hasThumb = !!concept.thumbnail;
        const bgStyle  = hasRef
            ? ` style="background-image:url('${escHtml(concept.refUrl)}');background-size:cover;background-position:center"`
            : "";
        const overlay  = hasThumb
            ? `<img src="${escHtml(concept.thumbnail)}" class="concept-card-stroke-overlay" alt="">`
            : "";
        const thumb = (hasRef || hasThumb)
            ? `<div class="concept-card-thumb concept-card-thumb-ref"${bgStyle}>${overlay}</div>`
            : `<div class="concept-card-thumb concept-card-thumb-empty">
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
               </div>`;

        card.innerHTML = `
            ${thumb}
            <div class="concept-card-footer">
                <span class="concept-card-name">${escHtml(concept.name || "Untitled")}</span>
                <div class="concept-card-actions">
                    <button class="concept-card-del" title="Delete">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>`;

        /* Single-click delay so double-click can rename */
        let _clickTimer = null;
        card.addEventListener("click", (e) => {
            if (e.target.closest(".concept-card-actions")) return;
            clearTimeout(_clickTimer);
            _clickTimer = setTimeout(() => _openConcept(concept.id), 220);
        });
        card.addEventListener("dblclick", (e) => {
            if (e.target.closest(".concept-card-actions")) return;
            clearTimeout(_clickTimer);
            _renameConcept(concept.id, concept.name);
        });
        card.querySelector(".concept-card-del").addEventListener("click", (e) => {
            e.stopPropagation();
            _deleteConcept(concept.id);
        });

        cardsEl.appendChild(card);
    });
}

/* ================================================================ CONCEPT CRUD == */

async function _addConcept(name, refUrl) {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    if (!_pid || !_uid) return;
    try {
        const ref = await addDoc(_conceptsRef(), {
            name: name.trim() || "Untitled",
            refUrl: refUrl || "",
            strokes: [],
            thumbnail: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        _openConcept(ref.id);
    } catch (err) {
        console.error("[concept] addConcept:", err);
        toast("Failed to create concept art", "error");
    }
}

async function _deleteConcept(conceptId) {
    if (!_canEdit) return;
    const c = _concepts.find(x => x.id === conceptId);
    const ok = await confirm(`Delete "${c?.name || "this concept"}"?`, "This cannot be undone.");
    if (!ok) return;
    try {
        await deleteDoc(_conceptDoc(conceptId));
    } catch {
        toast("Failed to delete", "error");
    }
}

async function _renameConcept(conceptId, currentName) {
    const name = prompt("Concept name:", currentName || "");
    if (name === null || !name.trim()) return;
    try {
        await updateDoc(_conceptDoc(conceptId), { name: name.trim() });
    } catch {
        toast("Failed to rename", "error");
    }
}

/* ================================================================ EDITOR OPEN / CLOSE == */

function _openConcept(conceptId) {
    clearTimeout(_saveTimer);
    _dirty = false; _isDrawing = false; _curStroke = null; _strokes = [];
    _curConceptId = conceptId;

    const concept = _concepts.find(c => c.id === conceptId);
    const nameEl  = document.getElementById("concept-name-display");
    if (nameEl) nameEl.textContent = concept?.name || "Untitled";

    _clearCanvas();

    /* Load reference image */
    if (_refImgEl) {
        if (concept?.refUrl) {
            _refImgEl.src = concept.refUrl;
            _refImgEl.style.display = "";
        } else {
            _refImgEl.src = "";
            _refImgEl.style.display = "none";
        }
    }

    /* Reset reference opacity slider */
    const opEl = document.getElementById("concept-ref-opacity");
    if (opEl) { opEl.value = "100"; if (_refImgEl) _refImgEl.style.opacity = "1"; }

    /* Load saved strokes */
    _strokes = concept?.strokes ? [...concept.strokes] : [];
    if (_strokes.length) _replayStrokes(_strokes);

    _showEditor();
}

function _backToGallery(silent = false) {
    clearTimeout(_saveTimer);
    if (!silent && _dirty) _saveCurrentArt(true);
    _curConceptId = null;
    _strokes = []; _curStroke = null;
    _dirty = false; _isDrawing = false;
    _clearCanvas();
    if (_refImgEl) { _refImgEl.src = ""; _refImgEl.style.display = "none"; }
    _showGallery();
}

/* ================================================================ DRAWING == */

function _updateCtxStyle(pressure) {
    if (!_ctx) return;
    const p    = Math.max(0.15, pressure ?? 1.0);
    const base = _tool === "erase" ? _brushSize * 3 : _brushSize;
    _ctx.strokeStyle = _tool === "erase" ? "#000000" : _color;
    _ctx.fillStyle   = _tool === "erase" ? "#000000" : _color;
    _ctx.lineWidth   = base * p;
    _ctx.lineCap     = "round";
    _ctx.lineJoin    = "round";
    _ctx.globalCompositeOperation = _tool === "erase" ? "destination-out" : "source-over";
}

function _setupDrawing() {
    if (!_canvasEl) return;

    const _getPos = (e) => {
        const rect = _canvasEl.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
            y: (e.clientY - rect.top)  * (CANVAS_H / rect.height),
        };
    };

    _canvasEl.addEventListener("pointerdown", (e) => {
        if (!_curConceptId || !_canEdit) return;
        _isDrawing = true;
        _canvasEl.setPointerCapture(e.pointerId);
        const { x, y } = _getPos(e);
        const p = Math.max(0.15, e.pressure || 1.0);
        _curStroke = {
            t: _tool === "erase" ? "e" : "d",
            c: _color,
            w: _brushSize,
            pts: [Math.round(x), Math.round(y), Math.round(p * 100)],
        };
        _updateCtxStyle(e.pressure);
        /* Dot for taps */
        _ctx.beginPath();
        _ctx.arc(x, y, Math.max(0.5, _ctx.lineWidth / 2), 0, Math.PI * 2);
        _ctx.fill();
        _ctx.beginPath();
        _ctx.moveTo(x, y);
        e.preventDefault();
    });

    _canvasEl.addEventListener("pointermove", (e) => {
        if (!_isDrawing || !_curStroke) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        events.forEach(ev => {
            const { x, y } = _getPos(ev);
            const p = Math.max(0.15, ev.pressure || 1.0);
            _curStroke.pts.push(Math.round(x), Math.round(y), Math.round(p * 100));
            _updateCtxStyle(ev.pressure);
            _ctx.lineTo(x, y);
            _ctx.stroke();
            _ctx.beginPath();
            _ctx.moveTo(x, y);
        });
        e.preventDefault();
    });

    function _finaliseStroke() {
        if (!_isDrawing) return;
        _isDrawing = false;
        if (_curStroke && _curStroke.pts.length) {
            _strokes.push(_curStroke);
        }
        _curStroke = null;
        _dirty = true;
        _scheduleSave();
    }

    _canvasEl.addEventListener("pointerup",     _finaliseStroke);
    _canvasEl.addEventListener("pointercancel", _finaliseStroke);
}

function _clearCanvas() {
    if (_ctx) _ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
}

/* Same flat-array replay logic as animation.js */
function _replayStrokes(strokes, targetCtx) {
    const ctx = targetCtx || _ctx;
    if (!ctx || !strokes) return;
    for (const s of strokes) {
        if (!s.pts || s.pts.length < 3) continue;
        const baseW = s.t === "e" ? (s.w || 4) * 3 : (s.w || 4);
        ctx.save();
        ctx.globalCompositeOperation = s.t === "e" ? "destination-out" : "source-over";
        ctx.strokeStyle = s.t === "e" ? "#000" : (s.c || "#fff");
        ctx.fillStyle   = s.t === "e" ? "#000" : (s.c || "#fff");
        ctx.lineCap     = "round";
        ctx.lineJoin    = "round";
        const nPts = Math.floor(s.pts.length / 3);
        if (nPts === 1) {
            const p = Math.max(0.15, (s.pts[2] || 100) / 100);
            ctx.lineWidth = baseW * p;
            ctx.beginPath();
            ctx.arc(s.pts[0], s.pts[1], Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.moveTo(s.pts[0], s.pts[1]);
            for (let i = 1; i < nPts; i++) {
                const p = Math.max(0.15, (s.pts[i * 3 + 2] || 100) / 100);
                ctx.lineWidth = baseW * p;
                ctx.lineTo(s.pts[i * 3], s.pts[i * 3 + 1]);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(s.pts[i * 3], s.pts[i * 3 + 1]);
            }
        }
        ctx.restore();
    }
    if (!targetCtx) _updateCtxStyle();
}

/* ================================================================ SAVE == */

function _scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveCurrentArt(), 1500);
}

async function _saveCurrentArt(force = false) {
    if (!force && !_dirty) return;
    if (!_curConceptId || !_uid || !_pid) return;
    _dirty = false;

    const strokes   = [..._strokes];
    const thumbnail = _generateThumbnail();

    try {
        await updateDoc(_conceptDoc(_curConceptId), {
            strokes,
            thumbnail,
            updatedAt: serverTimestamp(),
        });
    } catch (err) {
        console.error("[concept] save:", err);
        _dirty = true;
    }
}

function _generateThumbnail() {
    if (!_strokes.length) return null;
    const off = document.createElement("canvas");
    off.width  = 240;
    off.height = 135;
    const offCtx = off.getContext("2d");
    /* Strokes only — transparent background. The reference image URL is
       stored separately in Firestore; they are never merged in storage. */
    offCtx.save();
    offCtx.scale(240 / CANVAS_W, 135 / CANVAS_H);
    _replayStrokes(_strokes, offCtx);
    offCtx.restore();
    return off.toDataURL("image/png");
}

/* ================================================================ TOOLBAR == */

function _setupToolbar() {
    document.getElementById("btn-concept-back")?.addEventListener("click", () => _backToGallery());
    document.getElementById("btn-concept-new")?.addEventListener("click",  () => _openNewConceptModal());

    document.getElementById("btn-concept-draw")?.addEventListener("click",  () => _setTool("draw"));
    document.getElementById("btn-concept-erase")?.addEventListener("click", () => _setTool("erase"));

    document.getElementById("concept-color")?.addEventListener("input", (e) => {
        _color = e.target.value;
    });

    document.getElementById("concept-brush")?.addEventListener("input", (e) => {
        _brushSize = parseInt(e.target.value, 10);
    });

    document.getElementById("btn-concept-clear")?.addEventListener("click", () => {
        if (!_canEdit || !_curConceptId) return;
        _clearCanvas();
        _strokes = [];
        _dirty = true;
        _scheduleSave();
    });

    document.getElementById("btn-concept-export")?.addEventListener("click", _exportArt);

    document.getElementById("concept-ref-opacity")?.addEventListener("input", (e) => {
        if (_refImgEl) _refImgEl.style.opacity = (parseInt(e.target.value, 10) / 100).toString();
    });
}

function _setTool(tool) {
    _tool = tool;
    document.querySelectorAll(".concept-tool-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.tool === tool);
    });
}

function _exportArt() {
    const off = document.createElement("canvas");
    off.width  = CANVAS_W;
    off.height = CANVAS_H;
    const offCtx = off.getContext("2d");
    if (_refImgEl && _refImgEl.naturalWidth) {
        offCtx.drawImage(_refImgEl, 0, 0, CANVAS_W, CANVAS_H);
    }
    _replayStrokes(_strokes, offCtx);
    const a = document.createElement("a");
    const concept = _concepts.find(c => c.id === _curConceptId);
    a.download = (concept?.name || "concept") + ".png";
    a.href = off.toDataURL("image/png");
    a.click();
}

/* ================================================================ NEW CONCEPT MODAL == */

function _openNewConceptModal() {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    _loadMediaLinks().then(() => {
        _renderConceptImagePicker();
        const nameEl = document.getElementById("concept-new-name");
        if (nameEl) { nameEl.value = ""; nameEl.focus(); }
        openModal("modal-concept-new");
    });
}

function _renderConceptImagePicker() {
    const el = document.getElementById("concept-img-picker");
    if (!el) return;
    el.innerHTML = "";

    /* Blank / no reference option (selected by default) */
    const blankItem = document.createElement("div");
    blankItem.className = "concept-cpick-item concept-cpick-selected";
    blankItem.dataset.url = "";
    blankItem.innerHTML = `
        <div class="concept-cpick-thumb concept-cpick-blank">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
                <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
            </svg>
        </div>
        <div class="concept-cpick-label">No reference</div>`;
    el.appendChild(blankItem);

    _mediaLinks.forEach(link => {
        const url   = link.image || link.url || "";
        const label = escHtml(link.name || link.title || link.url || "Image");
        const item  = document.createElement("div");
        item.className   = "concept-cpick-item";
        item.dataset.url = url;
        item.innerHTML = `
            <div class="concept-cpick-thumb">
                <img src="${escHtml(url)}" alt="${label}" loading="lazy">
            </div>
            <div class="concept-cpick-label">${label}</div>`;
        el.appendChild(item);
    });

    if (_mediaLinks.length === 0) {
        const hint = document.createElement("p");
        hint.className   = "concept-cpick-hint";
        hint.textContent = "Add images in the Media tab to use as references.";
        el.appendChild(hint);
    }

    el.querySelectorAll(".concept-cpick-item").forEach(item => {
        item.addEventListener("click", () => {
            el.querySelectorAll(".concept-cpick-item").forEach(i => i.classList.remove("concept-cpick-selected"));
            item.classList.add("concept-cpick-selected");
        });
    });
}

function _setupNewConceptModal() {
    document.getElementById("form-concept-new")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name        = (document.getElementById("concept-new-name")?.value || "").trim() || "Untitled";
        const selectedEl  = document.querySelector("#concept-img-picker .concept-cpick-selected");
        const refUrl      = selectedEl?.dataset.url || "";
        closeModal("modal-concept-new");
        await _addConcept(name, refUrl);
    });
}

async function _loadMediaLinks() {
    if (!_uid || !_pid || !currentProject) return;
    try {
        const catId = currentProject.sourceCategoryId ?? _pid;
        const q     = query(collection(db, "users", _uid, "links"), where("categoryId", "==", catId));
        const snap  = await getDocs(q);
        _mediaLinks = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(l => l.image || l.type === "image" || _isImageUrl(l.url || ""));
    } catch {
        _mediaLinks = [];
    }
}

function _isImageUrl(url) {
    return /\.(jpe?g|png|gif|webp|svg|bmp)(\?.*)?$/i.test(url);
}
