/**
 * apps/links.js — Link Gallery app.
 *
 * Completely standalone from the Workspace (uses users/{uid}/gallery-links,
 * NOT users/{uid}/links which is used by the workspace media section).
 *
 * Categories work like workspace media: draggable section headers,
 * order saved to localStorage. No separate category filter tabs.
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc, deleteField,
    doc, getDoc, query, orderBy, where, serverTimestamp,
    collection, getDocs, setDoc
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { refs }                from "../db.js";
import { tmdbKey as _tmdbDefaultKey } from "../app.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml }    from "../ui.js";
import { materialIcons }       from "../icons.js";

/* ══════════ CONSTANTS ══════════ */

const TYPES = {
    "website":            { label: "Website",          icon: "public" },
    "youtube-channel":    { label: "YT Channel",        icon: "live_tv" },
    "youtube-playlist":   { label: "YT Playlist",       icon: "playlist_play" },
    "youtube-video":      { label: "YT Video",          icon: "play_circle" },
    "streaming-service":  { label: "Streaming Service", icon: "smart_display" },
    "image":              { label: "Image",             icon: "image" },
    "3d-model":           { label: "3D Model",          icon: "view_in_ar" },
    "file":               { label: "File",              icon: "attach_file" },
    "video":              { label: "Video",             icon: "videocam" },
    "creator":            { label: "Creator / Channel", icon: "person" },
    "person":             { label: "Person / Character",icon: "face" },
    "other":              { label: "Other",             icon: "link" },
};

// Alias → canonical name for person auto-detection (edit these to match your content)
const MGH_PERSON_ALIASES = {
    "ellie":        "Ellie (The Last of Us)",
    "joel":         "Joel (The Last of Us)",
    "abby":         "Abby (The Last of Us)",
};

/* ══════════ STATE ══════════ */

let _db, _user, _unsub;
let _links          = [];
let _search         = "";
let _activeCat      = "all";   // "all" | category name | "_uncat"
let _sortMode       = "manual";
let _editId         = null;
let _editCatId      = null;
let _dragId         = null;
let _settingsLoaded = false;   // true after first Firestore settings snapshot
const _mediaThumbs = {}; // url → imgUrl | null  (undefined = not yet tried)

/* ── Bulk select state ── */
let _selectMode  = false;
let _selectedIds = new Set();

// Box-select drag state
let _boxDrag = false;
let _boxStartX = 0, _boxStartY = 0;
let _boxEl = null;

let _cats = [];   // [{ id, name, icon }]
const _CATS_KEY = () => `linksCats_${_user?.uid}`;
function _loadCats() {
    try { _cats = JSON.parse(localStorage.getItem(_CATS_KEY()) || "[]"); }
    catch { _cats = []; }
    // Migrate: auto-apply streaming/media prefab to any existing matching category
    let migrated = false;
    _cats = _cats.map(c => {
        if (c.name.toLowerCase() === "streaming" && !c.prefab) {
            migrated = true;
            return { ...c, prefab: "streaming", icon: "smart_display" };
        }
        if (c.name.toLowerCase() === "media" && !c.prefab) {
            migrated = true;
            return { ...c, prefab: "media", icon: "perm_media" };
        }
        return c;
    });
    if (migrated) _saveCats();
}
function _saveCats() {
    try { localStorage.setItem(_CATS_KEY(), JSON.stringify(_cats)); } catch {}
    // Also persist to Firestore so categories survive across devices and domains.
    // Guard with _settingsLoaded to avoid overwriting Firestore before we've read it.
    if (_settingsLoaded && _db && _user?.uid) {
        setDoc(refs.linkSettings(_db, _user.uid), { categories: _cats }, { merge: true })
            .catch(err => console.error("[links] _saveCats Firestore error:", err));
    }
}
function _syncCatsFromLinks() {
    const known = new Set(_cats.map(c => c.name));
    let changed = false;
    _links.forEach(l => {
        if (l.category && !known.has(l.category)) {
            const isStreaming = l.category.toLowerCase() === "streaming";
            const isMedia     = l.category.toLowerCase() === "media";
            _cats.push({ id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: l.category, icon: isStreaming ? "smart_display" : isMedia ? "perm_media" : "folder", ...(isStreaming ? { prefab: "streaming" } : isMedia ? { prefab: "media" } : {}) });
            known.add(l.category);
            changed = true;
        }
    });
    if (changed) _saveCats();
}

/* ══════════ BULK SELECT ══════════ */

function _enterSelectMode() {
    _selectMode  = true;
    _selectedIds = new Set();
    const btn = document.getElementById("btn-links-select-mode");
    if (btn) { btn.classList.add("active"); btn.textContent = "✕ Cancel"; }
    _updateBulkBar();
    // Add select-mode class to body for CSS hooks (hides drag handles, disables link clicks)
    document.getElementById("links-body")?.classList.add("links-select-mode");
}

function _exitSelectMode() {
    _selectMode  = false;
    _selectedIds = new Set();
    const btn = document.getElementById("btn-links-select-mode");
    if (btn) {
        btn.classList.remove("active");
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Select`;
    }
    document.getElementById("links-body")?.classList.remove("links-select-mode");
    // Clear visual selection on cards
    document.querySelectorAll("#links-body .link-card.link-card--selected")
        .forEach(c => c.classList.remove("link-card--selected"));
    _updateBulkBar();
}

function _toggleSelectItem(id) {
    if (_selectedIds.has(id)) _selectedIds.delete(id);
    else _selectedIds.add(id);
    // Sync visual state
    const card = document.querySelector(`#links-body .link-card[data-id="${id}"]`);
    if (card) card.classList.toggle("link-card--selected", _selectedIds.has(id));
    _updateBulkBar();
}

function _updateBulkBar() {
    let bar = document.getElementById("links-bulk-bar");
    if (!_selectMode) { bar?.remove(); return; }

    if (!bar) {
        bar = document.createElement("div");
        bar.id = "links-bulk-bar";
        bar.className = "links-bulk-bar";
        // Insert after the links header
        const header = document.querySelector("#app-links .links-header");
        header?.insertAdjacentElement("afterend", bar);
    }

    const n = _selectedIds.size;
    bar.innerHTML = `
        <span class="links-bulk-count">${n} selected</span>
        <div class="links-bulk-actions">
            <button class="ws-btn ws-btn-ghost ws-btn-sm" id="btn-bulk-select-all">Select all</button>
            <button class="ws-btn ws-btn-ghost ws-btn-sm" id="btn-bulk-deselect">Deselect all</button>
            <button class="ws-btn ws-btn-danger ws-btn-sm" id="btn-bulk-delete" ${n === 0 ? "disabled" : ""}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                Delete ${n > 0 ? n + " item" + (n !== 1 ? "s" : "") : ""}
            </button>
        </div>`;

    bar.querySelector("#btn-bulk-select-all").addEventListener("click", () => {
        document.querySelectorAll("#links-body .link-card[data-id]").forEach(c => {
            _selectedIds.add(c.dataset.id);
            c.classList.add("link-card--selected");
        });
        _updateBulkBar();
    });
    bar.querySelector("#btn-bulk-deselect").addEventListener("click", () => {
        _selectedIds.clear();
        document.querySelectorAll("#links-body .link-card.link-card--selected")
            .forEach(c => c.classList.remove("link-card--selected"));
        _updateBulkBar();
    });
    bar.querySelector("#btn-bulk-delete").addEventListener("click", _bulkDelete);
}

async function _bulkDelete() {
    const ids = [..._selectedIds];
    if (!ids.length) return;
    const ok = await confirm(`Delete ${ids.length} link${ids.length !== 1 ? "s" : ""}? This cannot be undone.`);
    if (!ok) return;
    try {
        await Promise.all(ids.map(id =>
            deleteDoc(doc(_db, "users", _user.uid, "gallery-links", id))
        ));
        toast(`Deleted ${ids.length} link${ids.length !== 1 ? "s" : ""}`, "success");
        _exitSelectMode();
    } catch (err) {
        console.error("[links] bulk delete error:", err);
        toast("Error deleting some links", "error");
    }
}

/* ── Box-select (rubber-band drag) ── */

function _initBoxSelect(body) {
    body.addEventListener("mousedown", e => {
        if (!_selectMode) return;
        // Only start drag on the container itself or empty space
        if (e.target.closest(".link-card")) return;
        if (e.button !== 0) return;
        _boxDrag  = true;
        const rect = body.getBoundingClientRect();
        _boxStartX = e.clientX - rect.left + body.scrollLeft;
        _boxStartY = e.clientY - rect.top  + body.scrollTop;

        _boxEl = document.createElement("div");
        _boxEl.className = "links-box-select";
        body.appendChild(_boxEl);
        e.preventDefault();
    });

    body.addEventListener("mousemove", e => {
        if (!_boxDrag || !_boxEl) return;
        const rect   = body.getBoundingClientRect();
        const curX   = e.clientX - rect.left + body.scrollLeft;
        const curY   = e.clientY - rect.top  + body.scrollTop;
        const x      = Math.min(_boxStartX, curX);
        const y      = Math.min(_boxStartY, curY);
        const w      = Math.abs(curX - _boxStartX);
        const h      = Math.abs(curY - _boxStartY);
        _boxEl.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

        // Highlight cards that intersect the box
        const boxRect = { left: x + rect.left - body.scrollLeft, top: y + rect.top - body.scrollTop, right: x + rect.left - body.scrollLeft + w, bottom: y + rect.top - body.scrollTop + h };
        document.querySelectorAll("#links-body .link-card[data-id]").forEach(card => {
            const cr = card.getBoundingClientRect();
            const hit = cr.left < boxRect.right && cr.right > boxRect.left && cr.top < boxRect.bottom && cr.bottom > boxRect.top;
            card.classList.toggle("link-card--box-hover", hit);
        });
    });

    const _endBox = () => {
        if (!_boxDrag) return;
        _boxDrag = false;
        _boxEl?.remove(); _boxEl = null;
        // Commit all box-hovered cards to selection
        document.querySelectorAll("#links-body .link-card.link-card--box-hover").forEach(card => {
            card.classList.remove("link-card--box-hover");
            _selectedIds.add(card.dataset.id);
            card.classList.add("link-card--selected");
        });
        _updateBulkBar();
    };
    body.addEventListener("mouseup",    _endBox);
    body.addEventListener("mouseleave", _endBox);
}

/* ══════════ BULK SELECT END ══════════ */

/* ══════════ INIT ══════════ */

export function initLinks(db, user) {
    _db   = db;
    _user = user;
    _loadCats();

    // Subscribe to Firestore settings — source of truth for categories across devices/domains.
    // The guard flag _settingsLoaded prevents _saveCats from overwriting Firestore
    // before we've received the initial snapshot.
    onSnapshot(refs.linkSettings(_db, _user.uid), snap => {
        if (snap.exists()) {
            const remoteCats = snap.data()?.categories;
            if (Array.isArray(remoteCats) && remoteCats.length > 0) {
                _cats = remoteCats;
                try { localStorage.setItem(_CATS_KEY(), JSON.stringify(_cats)); } catch {}
            } else if (!_settingsLoaded && _cats.length > 0) {
                // Remote doc exists but has no categories yet — push local cats up once
                setDoc(refs.linkSettings(_db, _user.uid), { categories: _cats }, { merge: true })
                    .catch(console.error);
            }
        } else if (!_settingsLoaded && _cats.length > 0) {
            // No settings doc yet — migrate localStorage cats to Firestore
            setDoc(refs.linkSettings(_db, _user.uid), { categories: _cats }, { merge: true })
                .catch(console.error);
        }
        _settingsLoaded = true;
        _render();
    }, err => console.error("[links] settings snapshot error:", err));

    document.getElementById("btn-links-select-mode")
        ?.addEventListener("click", () => _selectMode ? _exitSelectMode() : _enterSelectMode());

    const _linksBody = document.getElementById("links-body");
    if (_linksBody) _initBoxSelect(_linksBody);

    document.getElementById("btn-add-link")
        .addEventListener("click", () => _openForm(null));
    document.getElementById("links-search")
        .addEventListener("input", e => { _search = e.target.value.toLowerCase(); _render(); });
    document.getElementById("links-sort-select")
        .addEventListener("change", e => { _sortMode = e.target.value; _render(); });

    document.getElementById("links-cat-bar")
        .addEventListener("click", e => {
            const addBtn = e.target.closest("[data-cat-action='add-cat']");
            if (addBtn) { _openCatForm(null); return; }
            const catBtn = e.target.closest("[data-cat-name]");
            if (catBtn) { _activeCat = catBtn.dataset.catName; _render(); }
        });

    document.getElementById("links-body")
        .addEventListener("click", _onBodyClick);
    document.getElementById("form-add-link")
        .addEventListener("submit", _onFormSubmit);
    document.getElementById("link-url-field")
        .addEventListener("input", _autoDetectType);
    document.getElementById("link-type-field")
        .addEventListener("change", e => _updateTypeHint(e.target.value));
    document.getElementById("link-title-field")
        .addEventListener("input", _mghOnNameInput);

    const q = query(refs.galleryLinks(_db, _user.uid), orderBy("createdAt", "desc"));
    _unsub = onSnapshot(q, snap => {
        _links = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _render();
    });
    if (!window._sdVisChangeSet) {
        window._sdVisChangeSet = true;
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            try {
                const raw = sessionStorage.getItem("sl_opened");
                if (!raw) return;
                const { linkId, title, time } = JSON.parse(raw);
                sessionStorage.removeItem("sl_opened");
                if (Date.now() - time > 4 * 60 * 60 * 1000) return;
                _showReturnPrompt(linkId, title);
            } catch {}
        });
    }
}


/* ══════════ RENDER ══════════ */

function _sorted(list) {
    const arr = [...list];
    switch (_sortMode) {
        case "a-z":    return arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        case "z-a":    return arr.sort((a, b) => (b.title || "").localeCompare(a.title || ""));
        case "newest": return arr.sort((a, b) => ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
        case "oldest": return arr.sort((a, b) => ((a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
        default:
            return arr.sort((a, b) => {
                const ap = a.pinned ? -1e9 : (a.sortOrder ?? a.createdAt?.seconds ?? 0);
                const bp = b.pinned ? -1e9 : (b.sortOrder ?? b.createdAt?.seconds ?? 0);
                return ap - bp;
            });
    }
}

function _filter(list) {
    let out = list;
    if (_search) {
        out = out.filter(l =>
            l.title?.toLowerCase().includes(_search) ||
            l.url?.toLowerCase().includes(_search)   ||
            l.category?.toLowerCase().includes(_search) ||
            l.description?.toLowerCase().includes(_search)
        );
    }
    return _sorted(out);
}

function _renderCatBar() {
    const bar = document.getElementById("links-cat-bar");
    if (!bar) return;
    const allHtml = `<button class="links-cat-btn${_activeCat === "all" ? " active" : ""}" data-cat-name="all">All</button>`;
    const catBtns = _cats.map(c =>
        `<button class="links-cat-btn${_activeCat === c.name ? " active" : ""}" data-cat-name="${escHtml(c.name)}"><span class="material-symbols-outlined links-cat-btn-icon">${escHtml(c.icon)}</span>${escHtml(c.name)}</button>`
    ).join("");
    const hasUncat = _links.some(l => !l.category);
    const uncatBtn = hasUncat
        ? `<button class="links-cat-btn${_activeCat === "_uncat" ? " active" : ""}" data-cat-name="_uncat"><span class="material-symbols-outlined links-cat-btn-icon">folder_open</span>Uncategorised</button>`
        : "";
    const addBtn = `<button class="links-cat-add-btn" data-cat-action="add-cat"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Category</button>`;
    bar.innerHTML = allHtml + catBtns + uncatBtn + addBtn;
}

/* ── Category lock helpers ── */
const _unlockedCats = new Set(); // in-memory; cleared on page reload

async function _sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function _bioAvailable() {
    if (typeof PublicKeyCredential === "undefined") return false;
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
}
async function _bioEnroll(catId) {
    const uid = new Uint8Array(16);
    new TextEncoder().encodeInto(catId.padEnd(16, "0").slice(0, 16), uid);
    const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Link Gallery", id: location.hostname },
        user: { id: uid, name: "user", displayName: "Link Gallery" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000,
    }});
    return btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
}
async function _bioVerify(credentialId) {
    const rawId = Uint8Array.from(atob(credentialId), c => c.charCodeAt(0));
    await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: rawId, type: "public-key", transports: ["internal"] }],
        userVerification: "required",
        timeout: 60000,
    }});
}
async function _showLockScreen(cat) {
    const body = document.getElementById("links-body");
    if (!body) return;
    const bioOk = !!cat.credentialId && await _bioAvailable();
    const bioBtnHtml = bioOk ? `
        <button class="ws-btn ws-btn-accent link-ls-bio-btn" id="ls-bio-btn">
            <span class="material-symbols-outlined" style="font-size:1.1em;vertical-align:middle">fingerprint</span>
            Fingerprint / Face ID
        </button>
        <div class="link-ls-or">— or —</div>` : "";
    body.innerHTML = `
        <div class="link-lockscreen">
            <div class="link-ls-icon"><span class="material-symbols-outlined">lock</span></div>
            <div class="link-ls-name">${escHtml(cat.name)}</div>
            <div class="link-ls-sub">This category is locked</div>
            ${bioBtnHtml}
            <form id="ls-form" class="link-ls-form" autocomplete="off">
                <input type="password" class="link-ls-pw" id="ls-pw" placeholder="Password" autocomplete="current-password">
                <button type="submit" class="ws-btn ws-btn-accent">Unlock</button>
            </form>
            <div class="link-ls-err" id="ls-err" style="display:none"></div>
        </div>`;
    const showErr = msg => { const el = body.querySelector("#ls-err"); if (el) { el.className = "link-ls-err"; el.textContent = msg; el.style.display = ""; } };
    const _doUnlock = () => { _unlockedCats.add(cat.id); _activeCat = cat.name; _render(); };
    const _offerBio = async () => {
        const erEl = body.querySelector("#ls-err");
        if (!erEl) return _doUnlock();
        erEl.className = "link-ls-bio-offer";
        erEl.innerHTML = `<p>Enable fingerprint for faster unlock next time?</p>
            <div class="link-ls-offer-btns">
                <button id="ls-bio-yes" class="ws-btn ws-btn-accent ws-btn-sm">Enable</button>
                <button id="ls-bio-no" class="ws-btn ws-btn-ghost ws-btn-sm">Not now</button>
            </div>`;
        erEl.style.display = "";
        body.querySelector("#ls-bio-yes").addEventListener("click", async () => {
            try {
                const credId = await _bioEnroll(cat.id);
                _cats = _cats.map(c => c.id === cat.id ? { ...c, credentialId: credId } : c);
                _saveCats(); cat.credentialId = credId;
            } catch { /* user declined */ }
            _doUnlock();
        });
        body.querySelector("#ls-bio-no").addEventListener("click", _doUnlock);
    };
    if (bioOk) {
        body.querySelector("#ls-bio-btn").addEventListener("click", async () => {
            try { await _bioVerify(cat.credentialId); _doUnlock(); }
            catch (err) { if (err?.name !== "NotAllowedError") showErr("Biometric failed. Try password."); }
        });
    }
    body.querySelector("#ls-form").addEventListener("submit", async e => {
        e.preventDefault();
        const pw = body.querySelector("#ls-pw").value;
        if (!pw) return;
        if (await _sha256(pw) !== cat.passwordHash) { showErr("Incorrect password."); body.querySelector("#ls-pw").value = ""; return; }
        if (!cat.credentialId && await _bioAvailable()) await _offerBio(); else _doUnlock();
    });
}

function _renderCatsGrid(body) {
    if (_cats.length === 0 && _links.length === 0) {
        body.innerHTML = `
            <div class="links-empty">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" style="opacity:.35">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <p>No links yet. Add your first one!</p>
                <button id="btn-links-add-first" class="ws-btn ws-btn-accent ws-btn-sm">+ Add Link</button>
            </div>`;
        document.getElementById("btn-links-add-first")?.addEventListener("click", () => _openForm(null));
        return;
    }
    const catCards = _cats.map(c => {
        const count = _links.filter(l => l.category === c.name).length;
        const lockBadge = c.locked ? `<span class="link-cat-lock-badge" title="Locked"><span class="material-symbols-outlined">lock</span></span>` : "";
        const actionBtns = `
            <button class="link-card-action-btn" data-cat-action="edit-cat" data-cat-id="${escHtml(c.id)}" title="Edit">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="link-card-action-btn link-card-action-btn--danger" data-cat-action="delete-cat" data-cat-id="${escHtml(c.id)}" title="Delete">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>`;
        if (c.prefab === "media") {
            const count = _links.filter(l => l.category === c.name).length;
            return `
            <div class="link-cat-card link-cat-card--media" data-cat-name="${escHtml(c.name)}">
                ${lockBadge}
                <div class="link-cat-card-icon"><span class="material-symbols-outlined">perm_media</span></div>
                <div class="link-cat-card-name">${escHtml(c.name)}</div>
                <div class="link-cat-card-count">${count} item${count !== 1 ? "s" : ""}</div>
                <div class="link-cat-card-footer">${actionBtns}</div>
            </div>`;
        }
        if (c.prefab === "streaming") return `
            <div class="link-cat-card link-cat-card--streaming" data-cat-name="${escHtml(c.name)}">
                ${lockBadge}
                <div class="link-cat-card-icon"><span class="material-symbols-outlined">smart_display</span></div>
                <div class="link-cat-card-name">${escHtml(c.name)}</div>
                <div class="link-cat-card-count" data-streaming-count="${escHtml(c.name)}">…</div>
                <div class="link-cat-card-footer">${actionBtns}</div>
            </div>`;
        return `
            <div class="link-cat-card" data-cat-name="${escHtml(c.name)}">
                ${lockBadge}
                <div class="link-cat-card-icon"><span class="material-symbols-outlined">${escHtml(c.icon)}</span></div>
                <div class="link-cat-card-name">${escHtml(c.name)}</div>
                <div class="link-cat-card-count">${count} link${count !== 1 ? "s" : ""}</div>
                <div class="link-cat-card-footer">
                    <button class="link-card-action-btn" data-cat-action="edit-cat" data-cat-id="${escHtml(c.id)}" title="Edit">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="link-card-action-btn link-card-action-btn--danger" data-cat-action="delete-cat" data-cat-id="${escHtml(c.id)}" title="Delete">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>`;
    }).join("");
    const uncatCount = _links.filter(l => !l.category).length;
    const uncatCard  = uncatCount ? `
        <div class="link-cat-card" data-cat-name="_uncat">
            <div class="link-cat-card-icon"><span class="material-symbols-outlined">folder_open</span></div>
            <div class="link-cat-card-name">Uncategorised</div>
            <div class="link-cat-card-count">${uncatCount} link${uncatCount !== 1 ? "s" : ""}</div>
            <div class="link-cat-card-footer"></div>
        </div>` : "";
    body.innerHTML = `<div class="link-cats-grid">${catCards}${uncatCard}</div>`;

    // Async: fill streaming cards with total movie/show counts
    _cats.filter(c => c.prefab === "streaming").forEach(async c => {
        const svcLinks = _links.filter(l => l.category === c.name);
        await Promise.all(svcLinks.map(l => _loadStreamItems(l.id)));
        const total = svcLinks.reduce((acc, l) => acc + (_streamCache[l.id]?.length || 0), 0);
        const el = body.querySelector(`[data-streaming-count="${CSS.escape(c.name)}"]`);
        if (el) el.textContent = `${total} title${total !== 1 ? "s" : ""}`;
    });
}

function _domain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return ""; }
}

function _shortUrl(url) {
    try {
        const u = new URL(url);
        return (u.hostname + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
    } catch { return url || ""; }
}

function _isSafeUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" || u.protocol === "http:";
    } catch { return false; }
}

const _serviceLabel = link => link.title || _domain(link.url) || "Service";

async function _renderStreamingHub(body, cat) {
    _shCatName = cat.name;
    const services = _links.filter(l => l.category === cat.name);
    _hubLastServices = services;
    body.innerHTML = "";
    const hub = document.createElement("div");
    hub.className = "streaming-hub";

    const _favSrc = link => {
        const d = _domain(link.url);
        return (link.type || "").startsWith("youtube-")
            ? "https://www.google.com/s2/favicons?domain=youtube.com&sz=64"
            : d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : null;
    };

    const pillsHtml = services.map(link => {
        const fav = _favSrc(link);
        return `<div class="sh-pill-wrap">
            <button class="sh-pill" data-sh-link-id="${escHtml(link.id)}" title="${escHtml(_serviceLabel(link))}">
                ${fav ? `<img class="sh-pill-favicon" src="${escHtml(fav)}" alt="" onerror="this.style.display='none'">` : `<span class="material-symbols-outlined sh-pill-favicon-fb">smart_display</span>`}
                <span class="sh-pill-name">${escHtml(_serviceLabel(link))}</span>
            </button>
            <button class="sh-pill-del" data-sh-del-id="${escHtml(link.id)}" title="Remove ${escHtml(_serviceLabel(link))}">\u2715</button>
        </div>`;
    }).join("");

    hub.innerHTML = `
        <div class="sh-services-bar" id="sh-services-bar">
            ${pillsHtml}
            <button class="sh-pill sh-pill-add" id="sh-add-service-btn">
                <span class="material-symbols-outlined" style="font-size:1rem">add</span>
                <span class="sh-pill-name">Add Service</span>
            </button>
            <button class="sh-pill sh-pill-add" id="sh-add-item-btn">
                <span class="material-symbols-outlined" style="font-size:1rem">movie</span>
                <span class="sh-pill-name">Add Movie/Show</span>
            </button>
        </div>
        <div class="sh-tab-bar" id="sh-tab-bar">
            <button class="sh-tab${_shActiveTab==="all"?" sh-tab-active":""}" data-sh-tab="all">All</button>
            <button class="sh-tab${_shActiveTab==="movie"?" sh-tab-active":""}" data-sh-tab="movie">Movies</button>
            <button class="sh-tab${_shActiveTab==="series"?" sh-tab-active":""}" data-sh-tab="series">Series</button>
            <button class="sh-lucky-btn" id="sh-lucky-btn" title="Pick a random movie or next episode">
                <span class="material-symbols-outlined">casino</span>
                <span class="sh-lucky-btn-label">I&#8217;m Feeling Lucky</span>
            </button>
        </div>
        <div class="sh-content" id="sh-content"><div class="sh-loading">Loading…</div></div>`;
    body.appendChild(hub);

    hub.querySelector("#sh-services-bar").addEventListener("click", async e => {
        const delBtn = e.target.closest("[data-sh-del-id]");
        if (delBtn) {
            const linkId = delBtn.dataset.shDelId;
            const svc    = services.find(s => s.id === linkId);
            const name   = svc ? _serviceLabel(svc) : "this service";
            if (!await confirm(`Remove "${name}"? All tracked movies and series will be deleted.`)) return;
            try {
                const itemSnap = await getDocs(_streamRef(linkId));
                await Promise.all(itemSnap.docs.map(d => deleteDoc(d.ref)));
                await deleteDoc(doc(_db, "users", _user.uid, "gallery-links", linkId));
                delete _streamCache[linkId];
            } catch (err) { console.error(err); toast("Error removing service", "error"); }
            return;
        }
        const pill = e.target.closest("[data-sh-link-id]");
        if (pill) { _openLibrary(pill.dataset.shLinkId); return; }
        if (e.target.closest("#sh-add-service-btn")) {
            _openForm(null);
            setTimeout(() => {
                const cf = document.getElementById("link-cat-field");
                const tf = document.getElementById("link-type-field");
                if (cf) cf.value = cat.name;
                if (tf) { tf.value = "streaming-service"; _updateTypeHint("streaming-service"); }
            }, 80);
            return;
        }
        if (e.target.closest("#sh-add-item-btn")) {
            _openHubItemForm(services);
        }
    });

    hub.querySelector("#sh-tab-bar").addEventListener("click", e => {
        if (e.target.closest("#sh-lucky-btn")) { _showLuckyPick(services); return; }
        const tab = e.target.closest("[data-sh-tab]");
        if (!tab) return;
        _shActiveTab = tab.dataset.shTab;
        hub.querySelectorAll(".sh-tab").forEach(t => t.classList.toggle("sh-tab-active", t === tab));
        const fresh = _buildHubItems(services);
        _renderHubContent(document.getElementById("sh-content"), fresh);
    });

    // Load all service libraries in parallel then render
    await Promise.all(services.map(l => _loadStreamItems(l.id)));
    const allItems = _buildHubItems(services);
    _renderHubContent(document.getElementById("sh-content"), allItems);
}

function _buildHubItems(services) {
    return services.flatMap(l =>
        (_streamCache[l.id] || []).map(item => ({
            ...item,
            _serviceId:    l.id,
            _serviceTitle: l.title || _domain(l.url) || "Service",
        }))
    );
}

function _sdHubCardHtml(item) {
    const isSeries  = item.type === "series";
    const rawUrl    = item.url && _isSafeUrl(item.url) ? item.url : null;
    const safeUrl   = rawUrl ? escHtml(rawUrl) : null;
    const dispTitle = item.title || (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : "");
    const tot  = isSeries ? (item.seasons || []).reduce((a, se) => a + (se.eps || 0), 0) : 0;
    const done = isSeries ? (item.seasons || []).reduce((a, se) => a + (se.watched?.length || 0), 0) : 0;
    const pct  = tot ? Math.round(done / tot * 100) : 0;
    return `<div class="sd-movie-card${item.watched ? " sd-movie-watched" : ""}" data-sh-item-id="${escHtml(item.id)}" data-sh-svc-id="${escHtml(item._serviceId)}" data-hub-drag-item="${escHtml(item.id)}" data-hub-svc-id="${escHtml(item._serviceId)}" draggable="true">
        ${safeUrl ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer" draggable="false">` : `<div class="sd-movie-poster">`}
            ${item.posterUrl && _isSafeUrl(item.posterUrl) ? `<img class="sd-movie-poster-img" src="${escHtml(item.posterUrl)}" alt="" loading="lazy" draggable="false">` : `<span class="material-symbols-outlined sd-movie-icon">${isSeries ? "tv" : "movie"}</span>`}
            ${isSeries && tot > 0 ? `<div class="sd-tile-prog"><div class="sd-tile-prog-fill" style="width:${pct}%"></div></div>` : ""}
        ${safeUrl ? `</a>` : `</div>`}
        ${!isSeries ? `<button class="sd-watched-toggle sh-toggle-watched" data-sh-item-id="${escHtml(item.id)}" data-sh-svc-id="${escHtml(item._serviceId)}" title="${item.watched ? "Mark unwatched" : "Mark watched"}">
            <span class="material-symbols-outlined">${item.watched ? "check_circle" : "radio_button_unchecked"}</span>
        </button>` : ""}
        <div class="sd-movie-info">
            ${safeUrl ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}" draggable="false">${escHtml(dispTitle)}</a>` : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
        </div>
        <div class="sh-svc-badge">${escHtml(item._serviceTitle)}</div>
    </div>`;
}

function _renderHubContent(container, allItems) {
    if (!container) return;
    if (!allItems.length) {
        container.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">video_library</span><p>Add a streaming service then open it to track movies &amp; series.</p></div>`;
        container.onclick = null; return;
    }
    let filtered = allItems;
    if (_shActiveTab === "movie")  filtered = allItems.filter(i => i.type !== "series");
    if (_shActiveTab === "series") filtered = allItems.filter(i => i.type === "series");
    if (!filtered.length) {
        const label = _shActiveTab === "movie" ? "movies" : "series";
        container.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">${_shActiveTab === "movie" ? "movie" : "tv"}</span><p>No ${label} tracked yet.</p></div>`;
        container.onclick = null; return;
    }
    const units = _buildUnits(filtered);
    container.innerHTML = `<div class="sh-unified-grid">${
        units.map(u => {
            if (u.type === "solo") return _sdHubCardHtml(u.item);
            const collapsed = _shCollapsedColls.has(u.name);
            if (collapsed) {
                const fp = u.items.find(i => i.posterUrl && _isSafeUrl(i.posterUrl));
                const ph = fp ? `<img class="sd-movie-poster-img" src="${escHtml(fp.posterUrl)}" alt="" loading="lazy">` : `<span class="material-symbols-outlined sd-movie-icon">video_library</span>`;
                return `<div class="sd-movie-card sd-coll-collapsed" data-sh-coll-tog="${escHtml(u.name)}">
                    <button class="sd-movie-poster sd-coll-stack-btn" data-sh-coll-tog="${escHtml(u.name)}" title="Expand">
                        <div class="sd-cs-layer sd-cs-back2"></div><div class="sd-cs-layer sd-cs-back1"></div>
                        <div class="sd-cs-layer sd-cs-front">${ph}</div>
                        <div class="sd-cs-count">${u.items.length}</div>
                    </button>
                    <div class="sd-movie-info">
                        <span class="sd-movie-title" title="${escHtml(u.name)}">${escHtml(u.name)}</span>
                        <button class="sd-expand-toggle" data-sh-coll-tog="${escHtml(u.name)}" title="Expand"><span class="material-symbols-outlined">expand_more</span></button>
                    </div>
                </div>`;
            }
            return `<div class="sd-coll-block" data-sh-coll="${escHtml(u.name)}">
                <div class="sd-coll-hdr">
                    <span class="sd-coll-name">${escHtml(u.name)}</span>
                    <span class="sd-coll-badge">${u.items.length}</span>
                    <button class="sd-coll-toggle" data-sh-coll-tog="${escHtml(u.name)}" title="Collapse"><span class="material-symbols-outlined">expand_less</span></button>
                </div>
                <div class="sd-coll-inner">${u.items.map(i => _sdHubCardHtml(i)).join("")}</div>
            </div>`;
        }).join("")
    }</div>`;
    const _hubGrid = container.querySelector(".sh-unified-grid");
    if (_hubGrid) _attachHubDrag(_hubGrid, filtered, container);
    container.onclick = async e => {
        const ct = e.target.closest("[data-sh-coll-tog]");
        if (ct) {
            const name = ct.dataset.shCollTog;
            if (_shCollapsedColls.has(name)) _shCollapsedColls.delete(name); else _shCollapsedColls.add(name);
            _renderHubContent(container, allItems);
            return;
        }
        const wb = e.target.closest(".sh-toggle-watched");
        if (wb && !e.target.closest("a")) {
            const itemId = wb.dataset.shItemId, svcId = wb.dataset.shSvcId;
            const item = (_streamCache[svcId] || []).find(i => i.id === itemId);
            if (!item) return;
            item.watched = !item.watched;
            const card = wb.closest("[data-sh-item-id]");
            if (card) {
                card.classList.toggle("sd-movie-watched", item.watched);
                wb.querySelector(".material-symbols-outlined").textContent = item.watched ? "check_circle" : "radio_button_unchecked";
                wb.title = item.watched ? "Mark unwatched" : "Mark watched";
            }
            try {
                await updateDoc(doc(_db, "users", _user.uid, "gallery-links", svcId, "streaming-items", itemId), { watched: item.watched });
            } catch (err) { console.error(err); item.watched = !item.watched; }
        }
    };
}

/* ══════════ MEDIA HUB HELPERS ══════════ */

/* ── Low-level URL helpers ── */
function _mghFav(url) {
    try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
    catch { return ""; }
}
function _mghThumb(url) {
    if (!url) return "";
    return `https://image.thum.io/get/width/600/crop/338/noanimate/${encodeURIComponent(url)}`;
}
function _mghPretty(url) {
    try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, ""); }
    catch { return url || ""; }
}
function _mghEmbed(url) {
    if (!url) return null;
    if (/\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url)) return { type: "direct", src: url };
    try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, "");
        if (h === "youtube.com" || h === "m.youtube.com") {
            if (u.searchParams.has("v")) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${u.searchParams.get("v")}` };
            const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/);
            if (m) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${m[2]}` };
        }
        if (h === "youtu.be") {
            const id = u.pathname.slice(1).split("/")[0];
            if (id) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` };
        }
        if (h === "vimeo.com") {
            const id = u.pathname.split("/").filter(Boolean).pop();
            if (id) return { type: "vimeo", src: `https://player.vimeo.com/video/${id}` };
        }
    } catch { /* noop */ }
    return null;
}

/* ── Platform badge (with peer-lookup) ── */
function _mghPlatBadge(link) {
    let lbl = link.badgeLabel || "";
    let col = link.badgeColor || "";
    const linkUrl = link.url || "";
    let h = "";
    try { h = new URL(linkUrl).hostname.replace(/^www\./, ""); } catch {}

    // Peer lookup: if another creator in gallery-links shares the same host and has a badge, use it
    if (!lbl && h) {
        const peer = _links.find(l => {
            if ((l.type !== "creator" && l.type !== "youtube-channel") || !l.badgeLabel) return false;
            try { return new URL(l.url || "").hostname.replace(/^www\./, "") === h; } catch { return false; }
        });
        if (peer) { lbl = peer.badgeLabel; col = peer.badgeColor || ""; }
    }
    let cls = "other", defaultLabel = "";
    if (h.includes("youtube.com") || h === "youtu.be") { cls = "yt";     defaultLabel = "YT"; }
    else if (h.includes("twitter.com") || h.includes("x.com")) { cls = "tw"; defaultLabel = "X"; }
    else if (h.includes("instagram.com"))  { cls = "ig";     defaultLabel = "IG"; }
    else if (h.includes("tiktok.com"))     { cls = "ttk";    defaultLabel = "TikTok"; }
    else if (h.includes("twitch.tv"))      { cls = "twitch"; defaultLabel = "Twitch"; }
    else if (h.includes("vimeo.com"))      { cls = "other";  defaultLabel = "Vimeo"; }
    return { cls, label: lbl || defaultLabel, color: col, isCustom: !!lbl };
}

/* ── Creator ↔ media attribution ── */
function _mghFindCreatorFor(link) {
    if (!link || (link.type !== "image" && link.type !== "3d-model" &&
                  link.type !== "youtube-video" && link.type !== "youtube-playlist" &&
                  link.type !== "video")) return null;
    if (link.creatorId) return _links.find(l => l.id === link.creatorId) ?? null;
    if (!link.url) return null;
    for (const c of _links.filter(l => l.type === "creator" || l.type === "youtube-channel")) {
        if (!c.url) continue;
        try {
            const cu = new URL(c.url); const mu = new URL(link.url);
            if (cu.hostname === mu.hostname) {
                const cp = cu.pathname.replace(/\/$/, ""); const mp = mu.pathname.replace(/\/$/, "");
                if (cp && (mp === cp || mp.startsWith(cp + "/"))) return c;
            }
        } catch { /* noop */ }
    }
    return null;
}
function _mghMatchLinked(creator) {
    return _links.filter(l => {
        if (l.type === "creator" || l.type === "person" || l.type === "youtube-channel") return false;
        const pIds = l.personIds || (l.personId ? [l.personId] : []);
        if (l.creatorId === creator.id || pIds.includes(creator.id)) return true;
        return _mghFindCreatorFor(l)?.id === creator.id;
    });
}

/* ── Platform URL parsing / avatar ── */
function _mghParseCreatorUrl(url) {
    try {
        const u = new URL(url); const h = u.hostname.replace(/^www\./, "");
        if (h === "youtube.com" || h === "youtu.be") {
            const m = u.pathname.match(/\/@([^/?#]+)/) || u.pathname.match(/\/c\/([^/?#]+)/) || u.pathname.match(/\/user\/([^/?#]+)/);
            return { platform: "youtube", username: m ? m[1] : "" };
        }
        if (h === "x.com" || h === "twitter.com") { const m = u.pathname.match(/^\/([^/?#]+)/); return { platform: "twitter", username: m ? m[1] : "" }; }
        if (h === "instagram.com") { const m = u.pathname.match(/^\/([^/?#]+)/); return { platform: "instagram", username: m ? m[1] : "" }; }
        if (h === "tiktok.com")    { const m = u.pathname.match(/^\/@?([^/?#]+)/); return { platform: "tiktok", username: m ? m[1].replace(/^@/, "") : "" }; }
        if (h === "twitch.tv")     { const m = u.pathname.match(/^\/([^/?#]+)/); return { platform: "twitch", username: m ? m[1] : "" }; }
        return { platform: "other", username: "" };
    } catch { return null; }
}
function _mghCreatorAvatar(platform, username) {
    if (!username) return "";
    const map = { youtube: "youtube", twitter: "twitter", instagram: "instagram", tiktok: "tiktok", twitch: "twitch" };
    return map[platform] ? `https://unavatar.io/${map[platform]}/${encodeURIComponent(username)}` : "";
}
function _mghDetectPersonId(text) {
    if (!text) return "";
    for (const p of _links.filter(l => l.type === "person" || (l.type === "creator" && l.isCharacter))) {
        const pn = (p.title || p.name || "").toLowerCase();
        if (!pn) continue;
        const re = new RegExp("\\b" + pn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
        if (re.test(text)) return p.id;
        for (const alias of (p.aliases || [])) {
            if (!alias) continue;
            const are = new RegExp("\\b" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
            if (are.test(text)) return p.id;
        }
        // Check PERSON_NAME_ALIASES canonical → alias direction
        for (const [alias, canonical] of Object.entries(MGH_PERSON_ALIASES)) {
            if (canonical.toLowerCase() === pn) {
                const aliasRe = new RegExp("\\b" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
                if (aliasRe.test(text)) return p.id;
            }
        }
    }
    return "";
}

/* ── Card action buttons ── */
function _mghCardActions(link) {
    const wrap = document.createElement("div");
    wrap.className = "db-card-actions";
    wrap.innerHTML = `
        <button class="db-card-action-btn" title="Edit">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="db-card-action-btn db-card-del-btn" title="Delete">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>`;
    wrap.querySelector(".db-card-action-btn").addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); _openForm(link.id); });
    wrap.querySelector(".db-card-del-btn").addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); _delete(link.id); });
    return wrap;
}

/* ── Lightbox ── */
let _mghLbInited = false;
function _mghLightbox(src) {
    const lb = document.getElementById("ws-lightbox"); const img = document.getElementById("ws-lightbox-img");
    if (!lb || !img) return;
    img.src = src; lb.classList.add("open");
    if (!_mghLbInited) {
        _mghLbInited = true;
        document.getElementById("ws-lightbox-close")?.addEventListener("click", () => { lb.classList.remove("open"); img.src = ""; });
        lb.addEventListener("click", e => { if (e.target === lb) { lb.classList.remove("open"); img.src = ""; } });
        document.addEventListener("keydown", e => { if (e.key === "Escape" && lb.classList.contains("open")) { lb.classList.remove("open"); img.src = ""; } });
    }
}

/* ── Creator panel ── */
let _mghCpInited = false;
function _mghOpenCreatorPanel(creator) {
    if (!creator) return;
    const panel = document.getElementById("mgh-creator-panel");
    if (!panel) return;
    const isChar = creator.type === "person";
    const matched = _mghMatchLinked(creator);
    const avatarSrc = creator.thumbUrl || "";

    const avatarEl    = document.getElementById("mgh-cp-avatar");
    const fallbackEl  = document.getElementById("mgh-cp-avatar-fallback");
    if (avatarSrc) { avatarEl.src = avatarSrc; avatarEl.style.display = ""; fallbackEl.style.display = "none"; }
    else { avatarEl.style.display = "none"; fallbackEl.style.display = "flex"; }

    document.getElementById("mgh-cp-name").textContent = creator.title || "";

    const badge = document.getElementById("mgh-cp-badge");
    if (isChar) { badge.textContent = "char"; badge.className = "creator-platform-badge person"; badge.style.display = ""; }
    else {
        const { cls, label, color } = _mghPlatBadge(creator);
        if (label) {
            badge.textContent = label; badge.className = `creator-platform-badge ${cls}`;
            badge.style.color = color || ""; badge.style.borderColor = color ? color + "66" : "";
            badge.style.display = "";
        } else { badge.style.display = "none"; }
    }

    document.getElementById("mgh-cp-username").textContent = (!isChar && creator.username) ? `@${creator.username}` : "";
    const descEl = document.getElementById("mgh-cp-desc");
    const descTxt = creator.description || creator.desc || "";
    if (descTxt) { descEl.textContent = descTxt; descEl.style.display = ""; } else descEl.style.display = "none";

    const profBtn = document.getElementById("mgh-cp-profile-btn");
    if (!isChar && creator.url) { profBtn.style.display = ""; profBtn.onclick = () => window.open(creator.url, "_blank", "noopener,noreferrer"); }
    else profBtn.style.display = "none";

    const body = document.getElementById("mgh-cp-body");
    body.innerHTML = "";
    if (!matched.length) {
        body.innerHTML = `<div class="creator-panel-empty">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.25"><rect x="6" y="10" width="36" height="28" rx="2" stroke="white" stroke-width="2"/><path d="M14 24h20M14 30h12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
            <p>No saved items ${isChar ? "tagged with this character" : "linked to this creator"} yet.</p>
        </div>`;
    } else {
        const countEl = document.createElement("p"); countEl.className = "creator-panel-count";
        countEl.textContent = `${matched.length} saved item${matched.length !== 1 ? "s" : ""}`;
        body.appendChild(countEl);
        const grid = document.createElement("div"); grid.className = "media-grid";
        matched.forEach(l => {
            const VTYPES = ["youtube-video", "youtube-playlist", "video"];
            grid.appendChild(VTYPES.includes(l.type) ? _mghVideoCard(l) : _mghImageCard(l));
        });
        body.appendChild(grid);
    }

    panel.classList.add("active");
    if (!_mghCpInited) {
        _mghCpInited = true;
        document.getElementById("mgh-cp-back").addEventListener("click", () => panel.classList.remove("active"));
        document.addEventListener("keydown", e => { if (e.key === "Escape" && panel.classList.contains("active")) panel.classList.remove("active"); });
    }
}

/* ── Site card ── */
function _mghSiteCard(link) {
    const card = document.createElement("div"); card.className = "db-site-card";
    const fav = _mghFav(link.url); const thumb = link.thumbUrl || _mghThumb(link.url);
    const label = link.title || _mghPretty(link.url); const fbId = "mgh_fb_" + link.id;
    card.innerHTML = `
        <a class="db-site-link" href="${escHtml(link.url || "#")}" target="_blank" rel="noopener noreferrer">
            <div class="db-site-thumb">
                <img class="db-site-thumb-img" src="${escHtml(thumb)}" alt=""
                     onerror="this.style.display='none';document.getElementById('${fbId}').style.display='flex'">
                <div class="db-site-thumb-fb" id="${fbId}" style="display:none">
                    <img src="${escHtml(fav)}" alt="" onerror="this.style.display='none'">
                    <span>${escHtml(label)}</span>
                </div>
            </div>
            <div class="db-site-body">
                <div class="db-site-name">${escHtml(label)}</div>
                <div class="db-site-url">${escHtml(_mghPretty(link.url))}</div>
            </div>
        </a>`;
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Video card ── */
function _mghVideoCard(link) {
    const card = document.createElement("div"); card.className = "video-card";
    const embed = _mghEmbed(link.url);
    const creator = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);
    let mediaHtml, isThumb = false, isLink = false;
    if (embed) {
        mediaHtml = embed.type === "direct"
            ? `<video src="${escHtml(embed.src)}" controls style="position:absolute;inset:0;width:100%;height:100%;background:#000" preload="metadata"></video>`
            : `<iframe src="${escHtml(embed.src)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe>`;
    } else if (link.thumbUrl) {
        isThumb = true;
        mediaHtml = `<img src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.title || "")}" style="width:100%;height:auto;display:block">
            <div class="video-thumb-play-overlay">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><path d="M13 10.5l10 5.5-10 5.5V10.5z" fill="white"/></svg>
            </div>`;
    } else if (link.url) {
        isLink = true;
        const domain = _domain(link.url);
        mediaHtml = `<div class="video-link-placeholder">
            <svg width="36" height="36" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/><path d="M13 10.5l10 5.5-10 5.5V10.5z" fill="rgba(255,255,255,0.85)"/></svg>
            <span class="video-link-domain">${escHtml(domain)}</span>
        </div>`;
    } else {
        mediaHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:80px;color:#555;font-size:0.8rem">No video</div>`;
    }
    const badge = embed ? (embed.type === "youtube" ? "YT" : embed.type === "vimeo" ? "VIMEO" : "VIDEO") : (link.thumbUrl ? "IMG" : "LINK");
    card.innerHTML = `
        <div class="video-iframe-wrap${isThumb ? " video-iframe-wrap--thumb" : ""}">${mediaHtml}</div>
        <div class="video-card-body">
            <span class="video-type-badge">${badge}</span>
            <span class="video-card-name">${escHtml(link.title || "")}</span>
            ${link.url ? `<a class="card-source-link" href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
        </div>
        ${creator ? `<div class="image-card-creator" title="Creator: ${escHtml(creator.title || "")}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(creator.title || "")}</span></div>` : ""}
        ${persons.length ? `<div class="image-card-person"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(persons.map(p => p.title).join(", "))}</span></div>` : ""}`;
    if ((isThumb || isLink) && link.url) {
        const openLink = () => window.open(link.url, "_blank", "noopener,noreferrer");
        card.querySelector(".video-thumb-play-overlay")?.addEventListener("click", openLink);
        card.querySelector(".video-link-placeholder")?.addEventListener("click", openLink);
        card.querySelector(".video-iframe-wrap img")?.addEventListener("click", openLink);
    }
    card.querySelector(".image-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.querySelector(".image-card-person")?.addEventListener("click", e => { e.stopPropagation(); if (persons[0]) _mghOpenCreatorPanel(persons[0]); });
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Image card ── */
function _mghImageCard(link) {
    const card = document.createElement("div"); card.className = "image-card";
    const src = link.url || "";
    const creator = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);
    const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'%3E%3Crect fill='%231a1a1a' width='4' height='3'/%3E%3C/svg%3E";
    card.innerHTML = `
        ${src
            ? `<img class="image-card-img" src="${escHtml(src)}" alt="${escHtml(link.title || "")}" loading="lazy" onerror="this.src='${fallback}'">`
            : `<div style="background:#111;min-height:80px;display:flex;align-items:center;justify-content:center;color:#444;font-size:0.72rem">No image</div>`}
        <div class="image-card-body">
            <span class="image-type-badge">${link.type === "3d-model" ? "3D" : "IMG"}</span>
            <span class="image-card-name">${escHtml(link.title || "")}</span>
            ${link.sourceUrl ? `<a class="card-source-link" href="${escHtml(link.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
        </div>
        ${creator ? `<div class="image-card-creator" title="Creator: ${escHtml(creator.title || "")}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(creator.title || "")}</span></div>` : ""}
        ${persons.length ? `<div class="image-card-person"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(persons.map(p => p.title).join(", "))}</span></div>` : ""}`;
    const imgEl = card.querySelector(".image-card-img");
    if (imgEl && src) imgEl.addEventListener("click", e => { e.stopPropagation(); _mghLightbox(src); });
    card.querySelector(".image-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.querySelector(".image-card-person")?.addEventListener("click", e => { e.stopPropagation(); if (persons[0]) _mghOpenCreatorPanel(persons[0]); });
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Creator card ── */
function _mghCreatorCard(link) {
    const card = document.createElement("div"); card.className = "creator-card";
    const isChar = link.type === "person";
    const avatarSrc = link.thumbUrl || "";
    const { cls, label: bdgLabel, color, isCustom } = _mghPlatBadge(link);
    const badgeStyle = (isCustom && color) ? ` style="color:${escHtml(color)};border-color:${escHtml(color)}66"` : "";
    const linkedCount = _mghMatchLinked(link).length;
    card.innerHTML = `
        ${avatarSrc
            ? `<img class="creator-avatar" src="${escHtml(avatarSrc)}" alt="${escHtml(link.title || "")}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
               <div class="creator-avatar-fallback" style="display:none">👤</div>`
            : `<div class="creator-avatar-fallback">👤</div>`}
        <div class="creator-info">
            <div class="creator-name">${escHtml(link.title || "")}</div>
            <div class="creator-meta">
                ${isChar
                    ? `<span class="creator-platform-badge person">char</span>`
                    : (bdgLabel ? `<span class="creator-platform-badge ${cls}"${badgeStyle}>${escHtml(bdgLabel)}</span>` : "")}
                ${linkedCount > 0 ? `<span class="creator-media-count" title="${linkedCount} linked item${linkedCount !== 1 ? "s" : ""}">${linkedCount}</span>` : ""}
            </div>
            ${(link.description || link.desc) ? `<div class="creator-desc">${escHtml(link.description || link.desc || "")}</div>` : ""}
        </div>
        ${link.url ? `<a class="creator-card-link" href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="Open profile" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}`;
    card.addEventListener("click", e => {
        if (e.target.closest(".db-card-actions") || e.target.closest(".creator-card-link")) return;
        _mghOpenCreatorPanel(link);
    });
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ══════════ MEDIA HUB VIEW ══════════ */

function _renderMediaHub(body, cat) {
    body.innerHTML = "";
    const catLinks = _links.filter(l => l.category === cat.name);

    // Per-hub persisted state
    let _mghLayout = localStorage.getItem(`mghLayout_${cat.id}`) || "grid";
    let _mghSearch = "";
    let _mghSectionOrder = (() => { try { return JSON.parse(localStorage.getItem(`mghOrder_${cat.id}`) || "null") || null; } catch { return null; } })();

    const CREATOR_TYPES = ["creator", "youtube-channel"];
    const PERSON_TYPES  = ["person"];
    const IMAGE_TYPES   = ["image", "3d-model"];
    const VIDEO_TYPES   = ["youtube-video", "youtube-playlist", "video"];

    const hub = document.createElement("div"); hub.className = "media-gallery-hub";

    // Toolbar
    const toolbar = document.createElement("div"); toolbar.className = "mgh-toolbar";
    toolbar.innerHTML = `
        <span class="mgh-title">
            <span class="material-symbols-outlined">perm_media</span>
            ${escHtml(cat.name)}
        </span>
        <div class="mgh-search-wrap" id="mgh-search-wrap" style="display:none">
            <input class="mgh-search-input" id="mgh-search-input" placeholder="Search…" autocomplete="off">
            <button class="mgh-search-close" id="mgh-search-close" title="Close">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="mgh-toolbar-actions">
            <button class="ws-btn ws-btn-ghost ws-btn-icon mgh-layout-btn ${_mghLayout === "grid" ? "active" : ""}" id="mgh-layout-grid" title="Grid" data-layout="grid">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button class="ws-btn ws-btn-ghost ws-btn-icon mgh-layout-btn ${_mghLayout === "list" ? "active" : ""}" id="mgh-layout-list" title="List" data-layout="list">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
            <button class="ws-btn ws-btn-ghost ws-btn-icon" id="mgh-btn-search" title="Search">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
        </div>`;
    const addBtn = document.createElement("button"); addBtn.className = "ws-btn ws-btn-accent"; addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => { _openForm(null); setTimeout(() => { const cf = document.getElementById("link-cat-field"); if (cf) cf.value = cat.name; }, 80); });
    const importBtn = document.createElement("button");
    importBtn.className = "ws-btn ws-btn-ghost";
    importBtn.title = "Import media from a Workspace project";
    importBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="21" x2="12" y2="7"/><line x1="4" y1="4" x2="20" y2="4"/></svg>Import`;
    importBtn.addEventListener("click", () => _mghImportFromWorkspace(cat));
    toolbar.appendChild(importBtn);
    toolbar.appendChild(addBtn);
    hub.appendChild(toolbar);

    const mghBody = document.createElement("div"); mghBody.className = `mgh-body media-body${_mghLayout === "list" ? " layout-list" : ""}`;
    hub.appendChild(mghBody);
    body.appendChild(hub);

    // Layout toggle
    toolbar.querySelectorAll(".mgh-layout-btn").forEach(btn => btn.addEventListener("click", () => {
        _mghLayout = btn.dataset.layout;
        localStorage.setItem(`mghLayout_${cat.id}`, _mghLayout);
        mghBody.classList.toggle("layout-list", _mghLayout === "list");
        toolbar.querySelectorAll(".mgh-layout-btn").forEach(b => b.classList.toggle("active", b === btn));
    }));

    // Search
    toolbar.querySelector("#mgh-btn-search").addEventListener("click", () => {
        const sw = toolbar.querySelector("#mgh-search-wrap"); sw.style.display = "";
        toolbar.querySelector("#mgh-search-input").focus();
    });
    toolbar.querySelector("#mgh-search-close").addEventListener("click", () => {
        toolbar.querySelector("#mgh-search-wrap").style.display = "none";
        toolbar.querySelector("#mgh-search-input").value = "";
        _mghSearch = ""; _renderSections();
    });
    toolbar.querySelector("#mgh-search-input").addEventListener("input", e => { _mghSearch = e.target.value.trim().toLowerCase(); _renderSections(); });

    // Empty state
    if (!catLinks.length) {
        mghBody.innerHTML = `<div class="links-empty">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" style="opacity:.35"><rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 19 16 19 16 8"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="1 17 5 12 9 14.5 12 11 16 15"/></svg>
            <p>No media yet. Click <strong>+ Add</strong> to get started.</p>
        </div>`;
        return;
    }

    const DEFAULT_ORDER = ["creator", "person", "image", "video", "site"];
    let _order = _mghSectionOrder || DEFAULT_ORDER;
    _order = [...new Set([..._order, ...DEFAULT_ORDER])]; // ensure all keys present

    function _renderSections() {
        mghBody.innerHTML = "";
        const search = _mghSearch;
        const visible = search
            ? catLinks.filter(l => (l.title || "").toLowerCase().includes(search) || (l.url || "").toLowerCase().includes(search) || (l.description || "").toLowerCase().includes(search))
            : catLinks;

        if (!visible.length && search) { mghBody.innerHTML = `<div class="ws-placeholder">No matches.</div>`; return; }

        const creators = visible.filter(l => CREATOR_TYPES.includes(l.type));
        const persons  = visible.filter(l => PERSON_TYPES.includes(l.type));
        const images   = visible.filter(l => IMAGE_TYPES.includes(l.type));
        const videos   = visible.filter(l => VIDEO_TYPES.includes(l.type));
        const sites    = visible.filter(l => ![...CREATOR_TYPES, ...PERSON_TYPES, ...IMAGE_TYPES, ...VIDEO_TYPES].includes(l.type));

        const SECS = {
            creator: { label: "Creators",        items: creators, gridClass: "creators-grid", buildCard: _mghCreatorCard },
            person:  { label: "Persons & Chars",  items: persons,  gridClass: "creators-grid", buildCard: _mghCreatorCard },
            image:   { label: "Images & 3D",      items: images,   gridClass: "media-grid",    buildCard: _mghImageCard },
            video:   { label: "Videos",           items: videos,   gridClass: "media-grid",    buildCard: _mghVideoCard },
            site:    { label: "Sites & Files",    items: sites,    gridClass: "db-sites-grid", buildCard: _mghSiteCard },
        };

        _order.forEach(key => {
            const sec = SECS[key]; if (!sec || !sec.items.length) return;
            mghBody.appendChild(_makeMghSubGroup(key, sec.label, sec.items, sec.gridClass, sec.buildCard));
        });
    }

    function _makeMghSubGroup(key, label, items, gridClass, buildCard) {
        const sg = document.createElement("div"); sg.className = "db-sub-group mgh-section"; sg.dataset.typeKey = key;
        const hdr = document.createElement("div"); hdr.className = "db-sub-header"; hdr.style.cursor = "grab"; hdr.title = "Drag to reorder";
        hdr.innerHTML = `<span class="db-sub-label">${label}</span><div class="db-sub-line"></div><span class="mgh-section-count">${items.length}</span>`;
        sg.appendChild(hdr);
        const grid = document.createElement("div"); grid.className = gridClass;
        items.forEach(l => grid.appendChild(buildCard(l)));
        sg.appendChild(grid);

        hdr.addEventListener("mousedown", () => sg.setAttribute("draggable", "true"));
        sg.addEventListener("mouseleave", () => sg.setAttribute("draggable", "false"));
        sg.addEventListener("mouseup", () => sg.setAttribute("draggable", "false"));
        sg.addEventListener("dragstart", e => { window._mghDragSg = sg; e.dataTransfer.effectAllowed = "move"; setTimeout(() => sg.style.opacity = "0.4", 0); });
        sg.addEventListener("dragover", e => {
            e.preventDefault(); e.dataTransfer.dropEffect = "move";
            if (!window._mghDragSg) return;
            const bodyRect = mghBody.getBoundingClientRect(), y = e.clientY - bodyRect.top;
            if (y < 80) mghBody.scrollTop -= 15; else if (y > bodyRect.height - 80) mghBody.scrollTop += 15;
            const afterEl = [...mghBody.querySelectorAll(".db-sub-group:not([style*='opacity: 0.4'])")].reduce((closest, child) => {
                const box = child.getBoundingClientRect(); const offset = e.clientY - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) return { offset, element: child };
                return closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
            if (afterEl == null) mghBody.appendChild(window._mghDragSg); else mghBody.insertBefore(window._mghDragSg, afterEl);
        });
        sg.addEventListener("dragend", () => {
            sg.setAttribute("draggable", "false"); sg.style.opacity = "1";
            if (window._mghDragSg) {
                window._mghDragSg = null;
                _order = [...mghBody.querySelectorAll(".db-sub-group")].map(el => el.dataset.typeKey);
                _mghSectionOrder = _order;
                localStorage.setItem(`mghOrder_${cat.id}`, JSON.stringify(_order));
            }
        });
        return sg;
    }

    _renderSections();
}

/* ── Import from Workspace ── */

async function _mghImportFromWorkspace(cat) {
    let projects = [];
    try {
        const snap = await getDocs(refs.projects(_db, _user.uid));
        projects = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.title);
    } catch (err) { console.error(err); toast("Could not fetch workspace projects.", "error"); return; }
    if (!projects.length) { toast("No workspace projects found.", "error"); return; }

    // Build picker overlay
    const overlay = document.createElement("div");
    overlay.className = "mgh-import-overlay";
    overlay.innerHTML = `
        <div class="mgh-import-dialog">
            <div class="mgh-import-header">
                <span>Import from Workspace</span>
                <button class="mgh-import-close" id="_mic-x">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <label class="mgh-import-label">Source project</label>
            <select class="mgh-import-select" id="_mic-proj">
                ${projects.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.title)}</option>`).join("")}
            </select>
            <label class="mgh-import-check">
                <input type="checkbox" id="_mic-skip" checked>
                Skip items already in this hub (same URL)
            </label>
            <div class="mgh-import-actions">
                <button class="ws-btn ws-btn-ghost" id="_mic-cancel">Cancel</button>
                <button class="ws-btn ws-btn-accent" id="_mic-go">Import</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#_mic-x").addEventListener("click", close);
    overlay.querySelector("#_mic-cancel").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#_mic-go").addEventListener("click", async () => {
        const projId  = overlay.querySelector("#_mic-proj").value;
        const skipDup = overlay.querySelector("#_mic-skip").checked;
        close();
        await _doWorkspaceImport(cat, projId, skipDup);
    });
}

async function _doWorkspaceImport(cat, projId, skipDup) {
    // Mirror workspace logic: links use categoryId === sourceCategoryId ?? projectId
    let catId = projId;
    try {
        const projSnap = await getDoc(refs.project(_db, _user.uid, projId));
        if (projSnap.exists()) catId = projSnap.data().sourceCategoryId ?? projId;
    } catch { /* fall back to projId */ }

    let wsLinks = [];
    try {
        const snap = await getDocs(query(refs.links(_db, _user.uid),
            where("categoryId", "==", catId)));
        wsLinks = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
    } catch (err) { console.error(err); toast("Could not fetch workspace media.", "error"); return; }
    if (!wsLinks.length) { toast("No media found in that project.", "error"); return; }

    // Workspace type → gallery-links type
    const typeMap = { site: "website", video: "video", image: "image", creator: "creator", person: "person" };

    const existingUrls = skipDup ? new Set(_links.map(l => l.url).filter(Boolean)) : new Set();
    const idMap = {}; // old workspace doc id → new gallery-links doc id

    const mapDoc = (l, remapId) => {
        const glType = typeMap[l.type] || "website";
        const thumbUrl = l.avatarUrl || l.thumbUrl || l.imageUrl || "";
        const data = {
            title:       l.name || "",
            url:         l.url  || "",
            type:        glType,
            category:    cat.name,
            description: l.desc || "",
            thumbUrl,
            pinned:      false,
            sortOrder:   Date.now(),
            createdAt:   serverTimestamp(),
        };
        if (glType === "creator" || glType === "person") {
            data.badgeLabel = l.badgeLabel || "";
            data.badgeColor = l.badgeColor || "";
            if (l.platform) data.platform = l.platform;
            if (l.username) data.username = l.username;
        }
        if (glType === "image") {
            if (l.sourceUrl) data.sourceUrl = l.sourceUrl;
        }
        if (glType === "image" || glType === "video") {
            const newCreatorId = remapId(l.creatorId);
            if (newCreatorId) data.creatorId = newCreatorId;
            const newPersonIds = (l.personIds || []).map(remapId).filter(Boolean);
            if (newPersonIds.length) {
                data.personIds = newPersonIds;
                data.personId  = newPersonIds[0];
            } else if (l.personId) {
                const np = remapId(l.personId);
                if (np) { data.personId = np; data.personIds = [np]; }
            }
        }
        return data;
    };

    const remapId = oldId => (oldId && idMap[oldId]) ? idMap[oldId] : null;
    let count = 0;

    // Pass 1: creators & persons (so their new IDs can be referenced by images/videos)
    for (const l of wsLinks) {
        if (l.type !== "creator" && l.type !== "person") continue;
        if (skipDup && l.url && existingUrls.has(l.url)) {
            const ex = _links.find(gl => gl.url === l.url);
            if (ex) idMap[l.id] = ex.id;
            continue;
        }
        try {
            const ref = await addDoc(refs.galleryLinks(_db, _user.uid), mapDoc(l, remapId));
            idMap[l.id] = ref.id;
            if (l.url) existingUrls.add(l.url);
            count++;
        } catch (err) { console.error("[import] creator/person:", err); }
    }

    // Pass 2: sites, videos, images
    for (const l of wsLinks) {
        if (l.type === "creator" || l.type === "person") continue;
        if (skipDup && l.url && existingUrls.has(l.url)) continue;
        try {
            await addDoc(refs.galleryLinks(_db, _user.uid), mapDoc(l, remapId));
            if (l.url) existingUrls.add(l.url);
            count++;
        } catch (err) { console.error("[import] media:", err); }
    }

    toast(`Imported ${count} item${count !== 1 ? "s" : ""} into "${cat.name}".`, "success");
}

function _render() {
    _syncCatsFromLinks();
    _renderCatBar();
    const body = document.getElementById("links-body");
    if (!body) return;

    // Global search while on All tab: show matching links flat
    if (_activeCat === "all" && _search) {
        const filtered = _filter(_links);
        if (!filtered.length) {
            body.innerHTML = `<div class="links-empty"><p>Nothing matches your search.</p></div>`;
            return;
        }
        body.innerHTML = "";
        const grid = document.createElement("div");
        grid.className = "links-grid";
        filtered.forEach(l => grid.appendChild(_card(l)));
        body.appendChild(grid);
        return;
    }

    if (_activeCat === "all") {
        _renderCatsGrid(body);
        return;
    }

    // Prefab category views
    const activeCatObj = _cats.find(c => c.name === _activeCat);
    if (activeCatObj?.prefab === "streaming") {
        _renderStreamingHub(body, activeCatObj); // async, no await needed — updates in place
        return;
    }
    if (activeCatObj?.prefab === "media") {
        _renderMediaHub(body, activeCatObj);
        return;
    }

    // Category detail view
    const allInCat = _activeCat === "_uncat"
        ? _links.filter(l => !l.category)
        : _links.filter(l => l.category === _activeCat);
    const filtered = _filter(allInCat);

    if (filtered.length === 0) {
        body.innerHTML = `
            <div class="links-empty">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" style="opacity:.35">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <p>${allInCat.length === 0 ? "No links in this category yet." : "Nothing matches your search."}</p>
                ${allInCat.length === 0 ? `<button id="btn-links-add-here" class="ws-btn ws-btn-accent ws-btn-sm">+ Add Link</button>` : ""}
            </div>`;
        document.getElementById("btn-links-add-here")?.addEventListener("click", () => _openForm(null));
        return;
    }

    body.innerHTML = "";
    const pinned = filtered.filter(l => l.pinned);
    const rest   = filtered.filter(l => !l.pinned);

    if (pinned.length) {
        const pinnedSec = document.createElement("div");
        pinnedSec.className = "links-cat-section";
        pinnedSec.innerHTML = `<div class="links-sub-header"><span class="links-sub-label"><span class="material-symbols-outlined" style="font-size:0.8rem;vertical-align:middle;margin-right:4px">star</span>Pinned</span><div class="links-sub-line"></div></div>`;
        const pg = document.createElement("div");
        pg.className = "links-grid";
        pinned.forEach(l => pg.appendChild(_card(l)));
        pinnedSec.appendChild(pg);
        body.appendChild(pinnedSec);
    }
    if (rest.length) {
        const grid = document.createElement("div");
        grid.className = "links-grid";
        rest.forEach(l => grid.appendChild(_card(l)));
        body.appendChild(grid);
    }
}

/* ── Card ── */
function _card(link) {
    const el = document.createElement("div");
    const _cardType = link.type || "website";
    el.className = "link-card" + (link.pinned ? " link-card--pinned" : "") + ((_cardType === "image" || _cardType === "3d-model") ? " link-card--media" : "");
    el.dataset.id = link.id;
    el.draggable = _sortMode === "manual";

    if (_sortMode === "manual") {
        el.addEventListener("dragstart", e => {
            _dragId = link.id;
            el.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend",  () => { el.classList.remove("dragging"); _dragId = null; });
        el.addEventListener("dragover", e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (_dragId && link.id !== _dragId) el.classList.add("drag-over");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
        el.addEventListener("drop", async e => {
            e.preventDefault();
            el.classList.remove("drag-over");
            if (_dragId && _dragId !== link.id) await _reorder(_dragId, link.id);
        });
    }

    const domain   = _domain(link.url);
    const type     = link.type || "website";
    const typeInfo = TYPES[type] || TYPES.other;
    const safeHref = _isSafeUrl(link.url) ? escHtml(link.url) : "#";

    const isMedia  = (type === "image" || type === "3d-model");
    const isImage  = type === "image" && _isSafeUrl(link.url);
    // Resolve banner image: explicit thumbUrl > image URL itself > nothing
    const thumbSrc = (link.thumbUrl && _isSafeUrl(link.thumbUrl))
        ? link.thumbUrl
        : (isImage ? link.url : null);

    if (isMedia) {
        // ── Media card (image / 3d-model): banner at top ──
        const faviconSrc = domain
            ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
            : null;
        const faviconHtml = faviconSrc
            ? `<img class="link-card-favicon" src="${escHtml(faviconSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : `<span class="material-symbols-outlined link-card-favicon-fb">${typeInfo.icon}</span>`;
        const bannerContent = thumbSrc
            ? `<img class="link-card-banner-img" src="${escHtml(thumbSrc)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('link-card-banner--error')">`
            : `<span class="material-symbols-outlined link-card-banner-icon">${typeInfo.icon}</span>`;
        el.innerHTML = `
        <div class="link-card-drag-handle" title="Drag to reorder">
            <svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13.5" r="1.5"/><circle cx="7.5" cy="13.5" r="1.5"/></svg>
        </div>
        <a class="link-card-banner" href="${safeHref}" target="_blank" rel="noopener noreferrer">
            ${bannerContent}
        </a>
        <a class="link-card-main link-card-main--compact" href="${safeHref}" target="_blank" rel="noopener noreferrer">
            <div class="link-card-favicon-wrap">${faviconHtml}</div>
            <div class="link-card-info">
                <div class="link-card-title">${escHtml(link.title || domain || link.url)}</div>
                <div class="link-card-url">${escHtml(_shortUrl(link.url))}</div>
                ${link.description ? `<div class="link-card-desc">${escHtml(link.description)}</div>` : ""}
            </div>
            <span class="material-symbols-outlined link-type-badge link-type-badge--${escHtml(type)}" title="${typeInfo.label}">${typeInfo.icon}</span>
        </a>
        <div class="link-card-footer">
            ${link.category ? `<span class="link-card-cat">${escHtml(link.category)}</span>` : `<span></span>`}
            <div class="link-card-actions">
                <button class="link-card-action-btn${link.pinned ? " active" : ""}" data-action="pin" title="${link.pinned ? "Unpin" : "Pin"}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="${link.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
                <button class="link-card-action-btn" data-action="edit" title="Edit">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="link-card-action-btn link-card-action-btn--danger" data-action="delete" title="Delete">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
            </div>
        </div>`;
        return el;
    }

    // ── Standard card ──
    const faviconSrc = type.startsWith("youtube-")
        ? "https://www.google.com/s2/favicons?domain=youtube.com&sz=32"
        : domain
            ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
            : null;
    const faviconHtml = faviconSrc
        ? `<img class="link-card-favicon" src="${escHtml(faviconSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<span class="material-symbols-outlined link-card-favicon-fb">${typeInfo.icon}</span>`;

    el.innerHTML = `
        <div class="link-card-drag-handle" title="Drag to reorder">
            <svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13.5" r="1.5"/><circle cx="7.5" cy="13.5" r="1.5"/></svg>
        </div>
        <a class="link-card-main" href="${safeHref}" target="_blank" rel="noopener noreferrer">
            <div class="link-card-favicon-wrap">${faviconHtml}</div>
            <div class="link-card-info">
                <div class="link-card-title">${escHtml(link.title || domain || link.url)}</div>
                <div class="link-card-url">${escHtml(_shortUrl(link.url))}</div>
                ${link.description ? `<div class="link-card-desc">${escHtml(link.description)}</div>` : ""}
            </div>
            <span class="material-symbols-outlined link-type-badge link-type-badge--${escHtml(type)}" title="${typeInfo.label}">${typeInfo.icon}</span>
        </a>
        <div class="link-card-footer">
            ${link.category ? `<span class="link-card-cat">${escHtml(link.category)}</span>` : `<span></span>`}
            <div class="link-card-actions">
                ${type === "streaming-service" ? `<button class="link-card-action-btn" data-action="library" title="View library"><span class="material-symbols-outlined" style="font-size:13px">video_library</span></button>` : ""}
                <button class="link-card-action-btn${link.pinned ? " active" : ""}" data-action="pin" title="${link.pinned ? "Unpin" : "Pin"}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="${link.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
                <button class="link-card-action-btn" data-action="edit" title="Edit">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="link-card-action-btn link-card-action-btn--danger" data-action="delete" title="Delete">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
            </div>
        </div>`;
    if (type === "streaming-service") {
        el.querySelector(".link-card-main").addEventListener("click", () => {
            try { sessionStorage.setItem("sl_opened", JSON.stringify({ linkId: link.id, title: link.title || _domain(link.url) || "Streaming", time: Date.now() })); } catch {}
        });
    }
    return el;
}

function _populateCatSelect(currentValue) {
    const sel = document.getElementById("link-cat-field");
    if (!sel) return;
    sel.innerHTML = `<option value="">— None —</option>` +
        _cats.map(c => `<option value="${escHtml(c.name)}"${c.name === currentValue ? " selected" : ""}>${escHtml(c.name)}</option>`).join("");
    if (currentValue) sel.value = currentValue;
}

/* ══════════ BODY CLICK DELEGATION ══════════ */

function _onBodyClick(e) {
    // In select mode: clicking a card toggles selection instead of navigating
    if (_selectMode) {
        const card = e.target.closest(".link-card[data-id]");
        if (card) { e.preventDefault(); _toggleSelectItem(card.dataset.id); return; }
        return;
    }

    // Category card click (not on a sub-button)
    const catCard = e.target.closest(".link-cat-card[data-cat-name]");
    if (catCard && !e.target.closest("[data-cat-action]")) {
        const _catName = catCard.dataset.catName;
        const _catObj  = _cats.find(c => c.name === _catName);
        if (_catObj?.locked && !_unlockedCats.has(_catObj.id)) {
            _showLockScreen(_catObj);
            return;
        }
        _activeCat = _catName;
        _render();
        return;
    }
    const btn = e.target.closest("[data-action],[data-cat-action]");
    if (!btn) return;
    const catAction = btn.dataset.catAction;
    if (catAction === "edit-cat")   { _openCatForm(btn.dataset.catId); return; }
    if (catAction === "delete-cat") { _deleteCat(btn.dataset.catId); return; }
    const action = btn.dataset.action;
    const card   = btn.closest(".link-card");
    if (!card) return;
    const id = card.dataset.id;
    if (action === "edit")         _openForm(id);
    else if (action === "delete")  _delete(id);
    else if (action === "pin")     _togglePin(id);
    else if (action === "library") _openLibrary(id);
}

/* ══════════ CRUD ══════════ */

async function _delete(id) {
    const link = _links.find(l => l.id === id);
    const ok   = await confirm(`Delete "${link?.title || link?.url}"?`);
    if (!ok) return;
    try {
        await deleteDoc(doc(_db, "users", _user.uid, "gallery-links", id));
        toast("Link deleted");
    } catch (err) {
        console.error(err);
        toast("Error deleting link", "error");
    }
}

async function _togglePin(id) {
    const link = _links.find(l => l.id === id);
    if (!link) return;
    try {
        await updateDoc(doc(_db, "users", _user.uid, "gallery-links", id), {
            pinned: !link.pinned, updatedAt: serverTimestamp(),
        });
    } catch (err) { console.error(err); toast("Error updating link", "error"); }
}

async function _reorder(draggedId, targetId) {
    const dragged = _links.find(l => l.id === draggedId);
    const target  = _links.find(l => l.id === targetId);
    if (!dragged || !target) return;
    const dOrder = dragged.sortOrder ?? Date.now();
    const tOrder = target.sortOrder ?? Date.now() - 1;
    try {
        await Promise.all([
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", draggedId), { sortOrder: tOrder, updatedAt: serverTimestamp() }),
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", targetId),  { sortOrder: dOrder, updatedAt: serverTimestamp() }),
        ]);
    } catch (err) { console.error(err); }
}

/* ══════════ CATEGORY MODAL ══════════ */

let _linkCatIconActiveCat = "all";

function _renderLinkCatIconCats() {
    const el = document.getElementById("link-cat-icon-cats");
    if (!el) return;
    const cats = [
        { id: "all", name: "All" }, { id: "general", name: "General" }, { id: "files", name: "Files" },
        { id: "tech", name: "Tech" }, { id: "chat", name: "Communicate" }, { id: "media", name: "Media" },
        { id: "objects", name: "Objects" }, { id: "actions", name: "Actions" }, { id: "activities", name: "Activities" },
        { id: "business", name: "Business" }, { id: "home", name: "Home" }, { id: "maps", name: "Maps" },
        { id: "social", name: "Social" }, { id: "text", name: "Text" },
    ];
    el.innerHTML = cats.map(c =>
        `<button type="button" class="icon-cat-btn${_linkCatIconActiveCat === c.id ? " active" : ""}" data-icon-cat="${c.id}">${c.name}</button>`
    ).join("");
}

function _renderLinkCatIconGrid(search) {
    const grid = document.getElementById("link-cat-icon-grid");
    if (!grid) return;
    const term    = search.toLowerCase().replace(/ /g, "_").trim();
    const curIcon = document.getElementById("link-cat-icon-ms")?.textContent.trim() || "folder";
    grid.innerHTML = materialIcons
        .filter(i => _linkCatIconActiveCat === "all" || i.cat === _linkCatIconActiveCat)
        .filter(i => !term || i.name.includes(term))
        .map(i => `<button type="button" class="link-cat-icon-swatch${i.name === curIcon ? " selected" : ""}" data-icon="${escHtml(i.name)}" title="${escHtml(i.name)}"><span class="material-symbols-outlined">${escHtml(i.name)}</span></button>`)
        .join("") || `<div style="font-size:0.75rem;color:var(--text-muted);padding:0.5rem;grid-column:1/-1">No matching icons.</div>`;
}

function _ensureCatModal() {
    if (document.getElementById("modal-link-cat")) return;
    const overlay = document.createElement("div");
    overlay.id        = "modal-link-cat";
    overlay.className = "ws-modal-overlay hidden";
    overlay.innerHTML = `
        <div class="ws-modal">
            <div class="ws-modal-header">
                <h2 id="modal-link-cat-title">New Category</h2>
                <button class="ws-modal-close" data-modal="modal-link-cat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <form id="form-link-cat" class="ws-modal-form" autocomplete="off">
                <input type="hidden" id="link-cat-id-field">
                <input type="hidden" id="link-cat-prefab-field" value="">
                <input type="hidden" id="link-cat-icon-field" value="folder">
                <div class="form-group" id="link-cat-prefab-group">
                    <label>Type</label>
                    <div class="lc-prefabs" id="link-cat-prefabs">
                        <button type="button" class="lc-prefab active" data-prefab="">
                            <span class="material-symbols-outlined">folder</span>
                            <span>Standard</span>
                        </button>
                        <button type="button" class="lc-prefab" data-prefab="streaming">
                            <span class="material-symbols-outlined">smart_display</span>
                            <span>Streaming Hub</span>
                        </button>
                        <button type="button" class="lc-prefab" data-prefab="media">
                            <span class="material-symbols-outlined">perm_media</span>
                            <span>Media Hub</span>
                        </button>
                    </div>
                </div>
                <div class="form-group">
                    <label for="link-cat-name-field">Name *</label>
                    <div class="link-cat-form-row">
                        <div class="link-cat-icon-btn">
                            <span class="material-symbols-outlined" id="link-cat-icon-ms">folder</span>
                        </div>
                        <input type="text" id="link-cat-name-field" placeholder="e.g. Dev Tools, Gaming" required maxlength="40">
                    </div>
                </div>
                <div class="form-group">
                    <label>Icon</label>
                    <div class="link-cat-icon-cats" id="link-cat-icon-cats"></div>
                    <input type="text" id="link-cat-icon-search" class="link-cat-icon-search" placeholder="Search icons…" autocomplete="off">
                    <div class="link-cat-icon-grid" id="link-cat-icon-grid"></div>
                </div>
                <div class="form-group" id="link-cat-lock-group">
                    <label class="link-cat-lock-toggle">
                        <input type="checkbox" id="link-cat-lock-field">
                        <span>Lock with password</span>
                    </label>
                    <div id="link-cat-lock-pw-wrap" style="display:none">
                        <input type="password" id="link-cat-lock-pw" placeholder="Set password" maxlength="100" autocomplete="new-password" style="margin-top:0.5rem;width:100%">
                        <p style="margin-top:4px;font-size:0.75rem;color:var(--text-muted)">Fingerprint / Face ID will be offered after first unlock if your device supports it.</p>
                    </div>
                </div>
                <div class="ws-modal-footer">
                    <button type="button" class="ws-btn ws-btn-ghost" data-modal="modal-link-cat">Cancel</button>
                    <button type="submit" class="ws-btn ws-btn-accent" id="btn-link-cat-submit">Create</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal("modal-link-cat"); });
    overlay.querySelector(".ws-modal-close").addEventListener("click", () => closeModal("modal-link-cat"));
    overlay.querySelector("[data-modal='modal-link-cat']").addEventListener("click", () => closeModal("modal-link-cat"));

    overlay.querySelector("#link-cat-prefabs").addEventListener("click", e => {
        const btn = e.target.closest("[data-prefab]");
        if (!btn) return;
        const prefab = btn.dataset.prefab;
        document.getElementById("link-cat-prefab-field").value = prefab;
        overlay.querySelectorAll(".lc-prefab").forEach(b => b.classList.toggle("active", b === btn));
        if (prefab === "streaming") {
            if (!document.getElementById("link-cat-name-field").value.trim())
                document.getElementById("link-cat-name-field").value = "Streaming";
            document.getElementById("link-cat-icon-ms").textContent = "smart_display";
            document.getElementById("link-cat-icon-field").value = "smart_display";
            overlay.querySelectorAll(".link-cat-icon-swatch").forEach(s =>
                s.classList.toggle("selected", s.dataset.icon === "smart_display"));
        }
        if (prefab === "media") {
            if (!document.getElementById("link-cat-name-field").value.trim())
                document.getElementById("link-cat-name-field").value = "Media";
            document.getElementById("link-cat-icon-ms").textContent = "perm_media";
            document.getElementById("link-cat-icon-field").value = "perm_media";
            overlay.querySelectorAll(".link-cat-icon-swatch").forEach(s =>
                s.classList.toggle("selected", s.dataset.icon === "perm_media"));
        }
    });

    overlay.querySelector("#link-cat-icon-cats").addEventListener("click", e => {
        const btn = e.target.closest("[data-icon-cat]");
        if (!btn) return;
        _linkCatIconActiveCat = btn.dataset.iconCat;
        overlay.querySelectorAll("[data-icon-cat]").forEach(b => b.classList.toggle("active", b === btn));
        _renderLinkCatIconGrid(document.getElementById("link-cat-icon-search")?.value || "");
    });

    overlay.querySelector("#link-cat-icon-search").addEventListener("input", e => {
        _renderLinkCatIconGrid(e.target.value);
    });

    overlay.querySelector("#link-cat-icon-grid").addEventListener("click", e => {
        const sw = e.target.closest(".link-cat-icon-swatch");
        if (!sw) return;
        const iconName = sw.dataset.icon;
        document.getElementById("link-cat-icon-ms").textContent = iconName;
        document.getElementById("link-cat-icon-field").value = iconName;
        overlay.querySelectorAll(".link-cat-icon-swatch").forEach(s => s.classList.toggle("selected", s === sw));
    });

    overlay.querySelector("#link-cat-lock-field").addEventListener("change", e => {
        overlay.querySelector("#link-cat-lock-pw-wrap").style.display = e.target.checked ? "" : "none";
    });
    document.getElementById("form-link-cat").addEventListener("submit", _onCatFormSubmit);
}

function _openCatForm(editId) {
    _linkCatIconActiveCat = "all";
    _ensureCatModal();
    _editCatId = editId;
    document.getElementById("form-link-cat").reset();
    const searchEl = document.getElementById("link-cat-icon-search");
    if (searchEl) searchEl.value = "";
    _renderLinkCatIconCats();

    const prefabGroup = document.getElementById("link-cat-prefab-group");
    const prefabField = document.getElementById("link-cat-prefab-field");
    if (prefabGroup) prefabGroup.style.display = "";

    let selectedIcon = "folder";
    if (editId) {
        const cat = _cats.find(c => c.id === editId);
        if (!cat) return;
        setModalTitle("modal-link-cat", "Edit Category");
        document.getElementById("btn-link-cat-submit").textContent = "Save";
        document.getElementById("link-cat-id-field").value   = editId;
        document.getElementById("link-cat-name-field").value = cat.name;
        const currentPrefab = cat.prefab || "";
        if (prefabField) prefabField.value = currentPrefab;
        // Pre-select the active prefab button
        document.querySelectorAll("#link-cat-prefabs .lc-prefab").forEach(b =>
            b.classList.toggle("active", b.dataset.prefab === currentPrefab)
        );
        selectedIcon = cat.icon || "folder";
        const _lf = document.getElementById("link-cat-lock-field");
        const _lpw = document.getElementById("link-cat-lock-pw");
        const _lpww = document.getElementById("link-cat-lock-pw-wrap");
        if (_lf) { _lf.checked = !!cat.locked; if (_lpww) _lpww.style.display = cat.locked ? "" : "none"; }
        if (_lpw) { _lpw.value = ""; _lpw.placeholder = cat.locked ? "Change password (leave blank to keep)" : "Set password"; }
    } else {
        setModalTitle("modal-link-cat", "New Category");
        document.getElementById("btn-link-cat-submit").textContent = "Create";
        document.getElementById("link-cat-id-field").value = "";
        if (prefabField) prefabField.value = "";
        // Reset prefab buttons to "Standard" selected
        document.querySelectorAll("#link-cat-prefabs .lc-prefab").forEach(b =>
            b.classList.toggle("active", b.dataset.prefab === ""));
        const _lf2 = document.getElementById("link-cat-lock-field");
        const _lpw2 = document.getElementById("link-cat-lock-pw");
        const _lpww2 = document.getElementById("link-cat-lock-pw-wrap");
        if (_lf2) { _lf2.checked = false; if (_lpww2) _lpww2.style.display = "none"; }
        if (_lpw2) { _lpw2.value = ""; _lpw2.placeholder = "Set password"; }
    }
    document.getElementById("link-cat-icon-ms").textContent = selectedIcon;
    const _iconFieldEl = document.getElementById("link-cat-icon-field");
    if (_iconFieldEl) _iconFieldEl.value = selectedIcon;
    _renderLinkCatIconGrid("");
    openModal("modal-link-cat");
    setTimeout(() => document.getElementById("link-cat-name-field").focus(), 60);
}

async function _onCatFormSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("link-cat-name-field").value.trim();
    if (!name) { toast("Enter a category name", "error"); return; }
    const icon   = (document.getElementById("link-cat-icon-field")?.value ||
                   document.getElementById("link-cat-icon-ms")?.textContent || "folder").trim() || "folder";
    const editId = document.getElementById("link-cat-id-field").value;

    let prefab = document.getElementById("link-cat-prefab-field")?.value || "";
    if (!prefab && name.toLowerCase() === "streaming") prefab = "streaming";
    if (!prefab && name.toLowerCase() === "media") prefab = "media";

    // Lock settings
    const lockChecked = document.getElementById("link-cat-lock-field")?.checked || false;
    const lockPwVal   = document.getElementById("link-cat-lock-pw")?.value.trim() || "";
    const existingCat = editId ? _cats.find(c => c.id === editId) : null;
    let lockData = { locked: false, passwordHash: null, credentialId: null };
    if (lockChecked) {
        if (lockPwVal) {
            lockData = { locked: true, passwordHash: await _sha256(lockPwVal), credentialId: null };
        } else if (existingCat?.locked && existingCat?.passwordHash) {
            lockData = { locked: true, passwordHash: existingCat.passwordHash, credentialId: existingCat.credentialId || null };
        } else {
            toast("Enter a password to lock this category", "error"); return;
        }
    }

    if (editId) {
        const old = _cats.find(c => c.id === editId);
        const oldName = old?.name;
        _cats = _cats.map(c => c.id === editId
            ? { ...c, name, icon, ...lockData, ...(prefab ? { prefab } : { prefab: undefined }) }
            : c);
        // Remove undefined keys
        _cats = _cats.map(c => {
            const out = { ...c };
            if (out.prefab === undefined) delete out.prefab;
            return out;
        });
        if (oldName && oldName !== name) {
            const toUpdate = _links.filter(l => l.category === oldName);
            Promise.all(toUpdate.map(l =>
                updateDoc(doc(_db, "users", _user.uid, "gallery-links", l.id), { category: name, updatedAt: serverTimestamp() })
            )).catch(err => console.error(err));
            if (_activeCat === oldName) _activeCat = name;
        }
        if (!!lockData.locked !== !!(old?.locked)) _unlockedCats.delete(editId);
        toast("Category updated", "success");
    } else {
        if (_cats.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            toast("Category already exists", "error"); return;
        }
        _cats.push({ id: `cat-${Date.now()}`, name, icon, ...lockData, ...(prefab ? { prefab } : {}) });
        toast("Category created", "success");
    }
    _saveCats();
    closeModal("modal-link-cat");
    _editCatId = null;
    _render();
}

async function _deleteCat(id) {
    const cat = _cats.find(c => c.id === id);
    if (!cat) return;
    const linksInCat = _links.filter(l => l.category === cat.name);
    const msg = linksInCat.length
        ? `Delete category "${cat.name}"? The ${linksInCat.length} link${linksInCat.length !== 1 ? "s" : ""} inside will become uncategorised.`
        : `Delete category "${cat.name}"?`;
    const ok = await confirm(msg);
    if (!ok) return;
    _cats = _cats.filter(c => c.id !== id);
    _saveCats();
    if (_activeCat === cat.name) _activeCat = "all";
    // Remove the category from all links in Firestore so they don't recreate it
    if (linksInCat.length) {
        Promise.all(linksInCat.map(l =>
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", l.id), { category: deleteField() })
        )).catch(err => console.error("[links] _deleteCat uncat error:", err));
    }
    toast("Category deleted");
    _render();
}

/* ══════════ FORM ══════════ */

function _openForm(editId) {
    _editId = editId;
    const form = document.getElementById("form-add-link");
    form.reset();
    document.getElementById("link-type-field").value = "website";
    const charHint = document.getElementById("link-char-hint");
    if (charHint) charHint.textContent = "";

    // Populate creator + person attribution selects
    const creatorSel = document.getElementById("link-creator-field");
    const personSel  = document.getElementById("link-person-field");
    if (creatorSel) {
        creatorSel.innerHTML = '<option value="">— none —</option>';
        _links.filter(l => l.type === "creator" || l.type === "youtube-channel").forEach(c => {
            const o = document.createElement("option"); o.value = c.id; o.textContent = c.title || c.url || c.id;
            creatorSel.appendChild(o);
        });
    }
    if (personSel) {
        personSel.innerHTML = "";
        _links.filter(l => l.type === "person").forEach(p => {
            const o = document.createElement("option"); o.value = p.id; o.textContent = p.title || p.url || p.id;
            personSel.appendChild(o);
        });
    }

    if (editId) {
        const link = _links.find(l => l.id === editId);
        if (!link) return;
        setModalTitle("modal-link", "Edit Link");
        document.getElementById("btn-link-submit").textContent = "Save Changes";
        document.getElementById("link-id-field").value         = editId;
        document.getElementById("link-url-field").value        = link.url         || "";
        document.getElementById("link-title-field").value      = link.title       || "";
        document.getElementById("link-type-field").value       = link.type        || "website";
        _populateCatSelect(link.category || "");
        document.getElementById("link-desc-field").value  = link.description || link.desc || "";
        document.getElementById("link-thumb-field").value = link.thumbUrl    || "";
        const _blf = document.getElementById("link-badge-label-field"); if (_blf) _blf.value = link.badgeLabel || "";
        const _bcf = document.getElementById("link-badge-color-field"); if (_bcf) _bcf.value = link.badgeColor || "#888888";
        const _sf  = document.getElementById("link-source-field");      if (_sf)  _sf.value  = link.sourceUrl  || "";
        // Attribution
        if (creatorSel && link.creatorId) creatorSel.value = link.creatorId;
        if (personSel) {
            const selIds = link.personIds || (link.personId ? [link.personId] : []);
            Array.from(personSel.options).forEach(o => { o.selected = selIds.includes(o.value); });
        }
        _updateTypeHint(link.type || "website");
    } else {
        setModalTitle("modal-link", "Add Link");
        document.getElementById("btn-link-submit").textContent = "Add Link";
        document.getElementById("link-id-field").value = "";
        const preselect = (_activeCat !== "all" && _activeCat !== "_uncat") ? _activeCat : "";
        _populateCatSelect(preselect);
        _updateTypeHint("website");
    }

    openModal("modal-link");
    setTimeout(() => document.getElementById("link-url-field").focus(), 60);
}

/* Wikipedia auto-fetch for person type */
let _mghCharTimer;
function _mghOnNameInput() {
    if (document.getElementById("link-type-field")?.value !== "person") return;
    clearTimeout(_mghCharTimer);
    _mghCharTimer = setTimeout(_mghAutoFetchCharImage, 600);
}

async function _mghAutoFetchCharImage() {
    if (document.getElementById("link-type-field")?.value !== "person") return;
    const name = document.getElementById("link-title-field")?.value.trim();
    const hint = document.getElementById("link-char-hint");
    if (!name) { if (hint) hint.textContent = ""; return; }
    const existingUrl = document.getElementById("link-thumb-field")?.value.trim();
    if (existingUrl) return;
    if (hint) { hint.style.color = "var(--text-secondary)"; hint.textContent = "Looking up…"; }
    try {
        const slug = encodeURIComponent(name.replace(/ /g, "_"));
        const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
        if (resp.ok) {
            const data = await resp.json();
            const thumbUrl = data.thumbnail?.source || data.originalimage?.source || "";
            const desc = data.description || "";
            if (thumbUrl) {
                document.getElementById("link-thumb-field").value = thumbUrl;
                const di = document.getElementById("link-desc-field");
                if (di && !di.value.trim() && desc) di.value = desc;
                if (hint) { hint.style.color = "var(--success)"; hint.textContent = `Found: "${data.title}"${desc ? " — " + desc : ""}`; }
                return;
            } else if (data.title && !data.missing) {
                if (hint) { hint.style.color = "var(--text-secondary)"; hint.textContent = `Found "${data.title}" but no image — paste a URL manually.`; }
                return;
            }
        }
        if (hint) { hint.style.color = "var(--text-secondary)"; hint.textContent = "No Wikipedia match — paste a URL manually."; }
    } catch {
        if (hint) { hint.style.color = "var(--text-secondary)"; hint.textContent = "Lookup failed — paste a URL manually."; }
    }
}

const _STREAMING_DOMAINS = [
    "netflix.com", "primevideo.com", "amazon.com/gp/video", "disneyplus.com",
    "hulu.com", "hbomax.com", "max.com", "appletv.apple.com", "tv.apple.com",
    "peacocktv.com", "paramountplus.com", "discoveryplus.com", "crunchyroll.com",
    "funimation.com", "mubi.com", "curiositystream.com", "tubi.tv", "pluto.tv",
    "dazn.com", "sky.com/watch", "nowtv.com", "britbox.com", "acorn.tv",
    "viaplay.com", "ruutu.fi", "tv2play.dk", "tvplay.lv", "nrk.no", "tv2.no",
    "svtplay.se", "areena.yle.fi", "plex.tv", "jellyfin", "emby.media",
    "pstream",
];

function _autoDetectType() {
    // Don't overwrite a type the user has already chosen
    const typeField = document.getElementById("link-type-field");
    if (typeField.value && typeField.value !== "website") return;

    const url = document.getElementById("link-url-field").value.trim().toLowerCase();
    let type = "website";
    if (url.includes("youtube.com/channel") || url.includes("youtube.com/@") ||
        url.includes("youtube.com/c/") || url.includes("youtube.com/user/")) {
        type = "youtube-channel";
    } else if (url.includes("youtube.com/playlist") ||
               (url.includes("youtube.com/watch") && url.includes("list="))) {
        type = "youtube-playlist";
    } else if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        type = "youtube-video";
    } else if (_STREAMING_DOMAINS.some(d => url.includes(d))) {
        type = "streaming-service";
    } else if (/\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/.test(url)) {
        type = "video";
    } else if (/\.(jpg|jpeg|png|gif|webp|svg|avif|bmp)(\?|#|$)/.test(url)) {
        type = "image";
    } else if (/\.(3mf|stl|obj|step|gltf|glb)(\?|#|$)/.test(url) ||
               /makerworld\.bambulab\.com|printables\.com|thingiverse\.com|thangs\.com/.test(url)) {
        type = "3d-model";
    }
    document.getElementById("link-type-field").value = type;
    _updateTypeHint(type);
}

function _updateTypeHint(type) {
    const hint = document.getElementById("link-type-hint");
    if (!hint) return;
    const info = TYPES[type] || TYPES.other;
    hint.innerHTML = `<span class="material-symbols-outlined" style="font-size:0.85em;vertical-align:middle;margin-right:2px">${escHtml(info.icon)}</span>${escHtml(info.label)}`;
    hint.style.display = "inline";

    const thumbGroup  = document.getElementById("link-thumb-group");
    const thumbLabel  = document.getElementById("link-thumb-label");
    const sourceGroup = document.getElementById("link-source-group");
    const badgeGroup  = document.getElementById("link-badge-group");
    const descGroup   = document.getElementById("link-desc-group");
    const attrGroup   = document.getElementById("link-attr-group");
    const urlLabel    = document.getElementById("link-url-label");

    const isCreator   = type === "creator" || type === "youtube-channel";
    const isPerson    = type === "person";
    const isImage     = type === "image" || type === "3d-model";
    const isVideo     = type === "youtube-video" || type === "youtube-playlist" || type === "video";

    if (urlLabel)    urlLabel.textContent    = isImage ? "Image URL *" : "URL *";
    if (thumbGroup)  thumbGroup.style.display  = (isCreator || isPerson || isVideo || isImage) ? "" : "none";
    if (thumbLabel)  thumbLabel.textContent  = (isCreator || isPerson) ? "Avatar URL" : "Thumbnail URL";
    if (sourceGroup) sourceGroup.style.display = isImage ? "" : "none";
    if (badgeGroup)  badgeGroup.style.display  = (isCreator) ? "" : "none";
    if (descGroup)   descGroup.style.display   = (isCreator || isPerson) ? "" : "none";
    if (attrGroup)   attrGroup.style.display   = (isImage || isVideo) ? "" : "none";
}

function _extractTitleFromUrl(url) {
    try {
        const path = new URL(url).pathname;
        // pstream / TMDB slug: /media/tmdb-movie-12345-the-dark-knight
        const m = path.match(/tmdb-(?:movie|tv)-\d+-(.+?)(?:\/|$)/);
        if (m) return m[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
        // Fallback: last meaningful path segment
        const seg = path.split("/").filter(Boolean).pop() || "";
        if (!seg || /^\d+$/.test(seg)) return "";
        return seg.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).split(".")[0].trim();
    } catch { return ""; }
}

async function _fetchTitleFromStreamingPage(url) {
    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(7000) });
        if (!res.ok) return null;
        const json = await res.json();
        const html = json.contents || "";
        if (!html) return null;
        // og:title (two attribute orderings)
        const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (og) return og[1].replace(/\s*[|\u2013\u2014].*$/, "").trim();
        // <title> fallback — strip " | Netflix" suffix etc.
        const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (t) return t[1].replace(/\s*[|\u2013\u2014-].*$/, "").trim();
        return null;
    } catch { return null; }
}

async function _onFormSubmit(e) {
    e.preventDefault();
    const url = document.getElementById("link-url-field").value.trim();
    const _fType = document.getElementById("link-type-field").value || "website";
    if (!_isSafeUrl(url) && _fType !== "image" && _fType !== "3d-model") {
        toast("Please enter a valid http/https URL", "error"); return;
    }

    const _safeUrl = v => { const s = v?.trim(); return (s && _isSafeUrl(s)) ? s : ""; };

    const isCreator = _fType === "creator" || _fType === "youtube-channel";
    const isPerson  = _fType === "person";
    const isImage   = _fType === "image" || _fType === "3d-model";
    const isVideo   = _fType === "youtube-video" || _fType === "youtube-playlist" || _fType === "video";

    const data = {
        url,
        title:       document.getElementById("link-title-field").value.trim(),
        type:        _fType,
        category:    document.getElementById("link-cat-field").value.trim(),
        description: document.getElementById("link-desc-field").value.trim(),
        thumbUrl:    _safeUrl(document.getElementById("link-thumb-field")?.value),
        updatedAt:   serverTimestamp(),
    };

    if (isCreator) {
        data.badgeLabel = document.getElementById("link-badge-label-field")?.value.trim() || "";
        data.badgeColor = document.getElementById("link-badge-color-field")?.value || "";
        // Auto-parse URL for platform/username/avatar when adding a creator
        if (url) {
            const parsed = _mghParseCreatorUrl(url);
            if (parsed && parsed.platform !== "other" && parsed.username) {
                data.username = parsed.username;
                data.platform = parsed.platform;
                if (!data.thumbUrl) data.thumbUrl = _mghCreatorAvatar(parsed.platform, parsed.username);
            }
        }
    }
    if (isImage) {
        const sv = _safeUrl(document.getElementById("link-source-field")?.value);
        if (sv) data.sourceUrl = sv;
    }
    if (isImage || isVideo) {
        // Creator attribution
        const cVal = document.getElementById("link-creator-field")?.value || "";
        data.creatorId = cVal || null;
        // Person attribution (multi-select)
        const pSel = document.getElementById("link-person-field");
        data.personIds = pSel ? Array.from(pSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
        data.personId  = data.personIds[0] || null; // back-compat

        // Auto-detect creator — for images use sourceUrl (the page the image came from),
        // for videos use the video URL itself (same logic as workspace media)
        if (!data.creatorId) {
            const sourceUrl = isVideo ? url : (data.sourceUrl || "");
            if (sourceUrl) {
                const parsed = _mghParseCreatorUrl(sourceUrl);
                if (parsed && parsed.platform !== "other" && parsed.username) {
                    const existing = _links.find(l =>
                        (l.type === "creator" || l.type === "youtube-channel") &&
                        (l.username || "").toLowerCase() === parsed.username.toLowerCase() &&
                        (l.platform || _mghParseCreatorUrl(l.url || "")?.platform) === parsed.platform
                    );
                    if (existing) {
                        data.creatorId = existing.id;
                    } else {
                        const _profileUrls = {
                            youtube:   `https://www.youtube.com/@${parsed.username}`,
                            twitter:   `https://x.com/${parsed.username}`,
                            instagram: `https://www.instagram.com/${parsed.username}`,
                            tiktok:    `https://www.tiktok.com/@${parsed.username}`,
                            twitch:    `https://www.twitch.tv/${parsed.username}`,
                        };
                        const profileUrl = _profileUrls[parsed.platform] || sourceUrl;
                        const avatarUrl  = _mghCreatorAvatar(parsed.platform, parsed.username);
                        const cData = {
                            title: parsed.username, url: profileUrl, type: "creator",
                            category: data.category, username: parsed.username,
                            platform: parsed.platform, thumbUrl: avatarUrl,
                            badgeLabel: "", badgeColor: "", createdAt: serverTimestamp(),
                        };
                        const docRef = await addDoc(refs.galleryLinks(_db, _user.uid), cData);
                        data.creatorId = docRef.id;
                        toast(`Creator @${parsed.username} auto-added.`);
                    }
                }
            }
        }

        // Auto-detect person from title — exact port of workspace logic:
        // 1. Check existing persons by name/alias, 2. Check MGH_PERSON_ALIASES map,
        // 3. Wikipedia lookup with canonical name, 4. Auto-create person entry
        if (!data.personIds.length && data.title) {
            let detectedId = _mghDetectPersonId(data.title);
            if (!detectedId) {
                const lowerTitle = data.title.toLowerCase();
                for (const [alias, canonical] of Object.entries(MGH_PERSON_ALIASES)) {
                    const aliasRe = new RegExp("\\b" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
                    if (aliasRe.test(lowerTitle)) {
                        // Check if a person with this canonical name already exists
                        const existing = _links.find(l =>
                            (l.type === "person" || (l.type === "creator" && l.isCharacter)) &&
                            (l.title || l.name || "").toLowerCase() === canonical.toLowerCase()
                        );
                        if (existing) {
                            detectedId = existing.id;
                        } else {
                            // Wikipedia lookup using the canonical name, then auto-create
                            try {
                                const slug = encodeURIComponent(canonical.replace(/ /g, "_"));
                                const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
                                if (resp.ok) {
                                    const wData = await resp.json();
                                    const avatarUrl = wData.thumbnail?.source || wData.originalimage?.source || "";
                                    const pData = {
                                        title: wData.title || canonical, type: "person",
                                        category: data.category, thumbUrl: avatarUrl,
                                        description: wData.description || "",
                                        createdAt: serverTimestamp(),
                                    };
                                    const docRef = await addDoc(refs.galleryLinks(_db, _user.uid), pData);
                                    detectedId = docRef.id;
                                    toast(`Person "${pData.title}" auto-added.`);
                                }
                            } catch { /* noop */ }
                        }
                        break;
                    }
                }
            }
            if (detectedId) { data.personIds = [detectedId]; data.personId = detectedId; }
        }
    }

    const editId = document.getElementById("link-id-field").value;
    try {
        if (editId) {
            await updateDoc(doc(_db, "users", _user.uid, "gallery-links", editId), data);
            toast("Link updated", "success");
        } else {
            await addDoc(refs.galleryLinks(_db, _user.uid), {
                ...data, pinned: false, sortOrder: Date.now(), createdAt: serverTimestamp(),
            });
            toast("Link added", "success");
        }
        closeModal("modal-link");
        _editId = null;
    } catch (err) { console.error(err); toast("Error saving link", "error"); }
}

/* ══════════ STREAMING LIBRARY ══════════ */

let _openDrawerLinkId = null;
let _shCatName        = "";
let _sdActiveTab      = "all";
let _shActiveTab      = "all"; // streaming hub: "all"|"movie"|"series"
const _streamCache    = {}; // linkId → items[]
const _sdExpandedIds  = new Set(); // series item IDs with expand open
let   _sdDragSrc      = null;      // { kind:'item'|'coll', id?, name? }
const _collapsedColls   = new Set(); // collection names collapsed (drawer)
const _shCollapsedColls = new Set(); // collection names collapsed (hub)
let   _sdInsertAfter    = false;     // true = insert after drop target on drop
let   _hubLastServices  = null;      // services list for hub re-render after drag

function _getTmdbKey() { return _tmdbDefaultKey || ""; }
async function _fetchTmdbMeta(urlStr, title, type) {
    const key = _getTmdbKey();
    if (!key) return null;
    const kind = type === "series" ? "tv" : "movie";
    try {
        let tvId = null;
        let basicTitle = "", basicPoster = null;

        // 1. If a direct TMDB URL was pasted, use the ID lookup
        const m = urlStr && urlStr.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
        if (m) {
            const itemKind = m[1] === "tv" ? "tv" : "movie";
            const res = await fetch(
                `https://api.themoviedb.org/3/${itemKind}/${m[2]}?api_key=${encodeURIComponent(key)}&language=en-US`
            );
            if (res.ok) {
                const data = await res.json();
                basicTitle  = data.title || data.name || "";
                basicPoster = data.poster_path ? `https://image.tmdb.org/t/p/w200${data.poster_path}` : null;
                if (itemKind === "tv") tvId = parseInt(m[2], 10);
            }
        }

        // 2. Fall back to title search
        if (!basicTitle && !tvId) {
            if (!title) return null;
            const res = await fetch(
                `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}&language=en-US&page=1`
            );
            if (!res.ok) return null;
            const data = await res.json();
            const hit  = (data.results || [])[0];
            if (!hit) return null;
            basicTitle  = hit.title || hit.name || "";
            basicPoster = hit.poster_path ? `https://image.tmdb.org/t/p/w200${hit.poster_path}` : null;
            if (kind === "tv") tvId = hit.id;
        }

        const result = { title: basicTitle, posterUrl: basicPoster };

        // 3. For series, fetch full season/episode breakdown
        if (kind === "tv" && tvId) {
            try {
                const tvRes = await fetch(
                    `https://api.themoviedb.org/3/tv/${tvId}?api_key=${encodeURIComponent(key)}&language=en-US`
                );
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    result.seasons = (tvData.seasons || [])
                        .filter(s => s.season_number > 0 && s.episode_count > 0)
                        .map(s => ({ s: s.season_number, eps: s.episode_count, watched: [] }));
                    if (!result.title) result.title = tvData.name || "";
                }
            } catch {}
        }

        return result;
    } catch { return null; }
}

function _streamRef(linkId) {
    return collection(_db, "users", _user.uid, "gallery-links", linkId, "streaming-items");
}

async function _loadStreamItems(linkId) {
    if (_streamCache[linkId]) return _streamCache[linkId];
    const snap  = await getDocs(_streamRef(linkId));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _streamCache[linkId] = items;
    return items;
}

async function _saveStreamItem(linkId, type, title, itemUrl, posterUrl, seasons, collectionName) {
    const item = {
        title, type, watched: false, addedAt: Date.now(), sortOrder: Date.now(),
        ...(itemUrl        ? { url: itemUrl }                  : {}),
        ...(posterUrl      ? { posterUrl }                     : {}),
        ...(collectionName ? { collection: collectionName }    : {}),
        ...(type === "series" ? { seasons: (seasons?.length ? seasons : []) } : {}),
    };
    const ref = await addDoc(_streamRef(linkId), item);
    _streamCache[linkId] = [...(_streamCache[linkId] || []), { id: ref.id, ...item }];
    return { id: ref.id, ...item };
}

/* ══════════ COLLECTIONS & REORDER ══════════ */

function _sdSorted(items) {
    return [...items].sort((a, b) =>
        (a.sortOrder ?? a.addedAt ?? 0) - (b.sortOrder ?? b.addedAt ?? 0)
    );
}

function _buildUnits(items) {
    const sorted = _sdSorted(items);
    const units  = [];
    const seen   = {}; // collection name → unit ref
    for (const item of sorted) {
        if (item.collection) {
            if (!seen[item.collection]) {
                const u = { type: "coll", name: item.collection, items: [] };
                seen[item.collection] = u;
                units.push(u);
            }
            seen[item.collection].items.push(item);
        } else {
            units.push({ type: "solo", item });
        }
    }
    return units;
}

function _sdCardHtml(item, draggable = false) {
    const isSeries  = item.type === "series";
    const rawUrl    = item.url && _isSafeUrl(item.url) ? item.url : null;
    const safeUrl   = rawUrl ? escHtml(rawUrl) : null;
    const dispTitle = item.title || (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : "");
    const dragAttrs  = draggable ? ` draggable="true" data-drag-item="${escHtml(item.id)}"` : "";
    const dragHandle = draggable ? `<span class="sd-drag-handle" title="Drag to reorder">&#8942;</span>` : "";
    const footer = `<div class="sd-card-footer">
                <button class="sd-icon-btn sd-edit-btn" data-edit-item="${escHtml(item.id)}" title="Edit / Group"><span class="material-symbols-outlined" style="font-size:12px">edit</span></button>
                <button class="sd-icon-btn sd-icon-btn--danger sd-del-btn" data-delete-item="${escHtml(item.id)}" title="Remove"><span class="material-symbols-outlined" style="font-size:12px">delete</span></button>
            </div>`;

    if (!isSeries) {
        return `<div class="sd-movie-card${item.watched ? " sd-movie-watched" : ""}" data-sd-item-id="${escHtml(item.id)}"${dragAttrs}>
            ${dragHandle}
            ${safeUrl ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer" draggable="false">` : `<div class="sd-movie-poster">`}
                ${item.posterUrl && _isSafeUrl(item.posterUrl) ? `<img class="sd-movie-poster-img" src="${escHtml(item.posterUrl)}" alt="" loading="lazy" draggable="false">` : `<span class="material-symbols-outlined sd-movie-icon">movie</span>`}
                <div class="sd-movie-watched-overlay"><span class="material-symbols-outlined">check_circle</span></div>
            ${safeUrl ? `</a>` : `</div>`}
            <button class="sd-watched-toggle" data-toggle-watched data-sd-item-id="${escHtml(item.id)}" title="${item.watched ? "Mark unwatched" : "Mark watched"}">
                <span class="material-symbols-outlined">${item.watched ? "check_circle" : "radio_button_unchecked"}</span>
            </button>
            <div class="sd-movie-info">
                ${safeUrl ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>` : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
            </div>
            ${footer}
        </div>`;
    }
    // Series card
    const tot  = (item.seasons || []).reduce((a, se) => a + (se.eps || 0), 0);
    const done = (item.seasons || []).reduce((a, se) => a + (se.watched?.length || 0), 0);
    const pct  = tot ? Math.round(done / tot * 100) : 0;
    const isExpanded = _sdExpandedIds.has(item.id);
    const allDone    = tot > 0 && done === tot;
    const seasonsHtml = item.seasons?.length
        ? `<div class="sd-seasons">${item.seasons.map((se, si) => {
            const sDone    = (se.watched || []).length;
            const sAllDone = sDone === se.eps;
            const epBubbles = Array.from({ length: se.eps }, (_, ei) => {
                const ep = ei + 1, watched = (se.watched || []).includes(ep);
                return `<button class="sd-ep${watched ? " sd-ep-done" : ""}" data-sd-item-id="${escHtml(item.id)}" data-season-idx="${si}" data-ep-n="${ep}" title="E${ep}">${ep}</button>`;
            }).join("");
            return `<div class="sd-season-row">
                <button class="sd-s-label${sAllDone ? " sd-s-done" : ""}" data-toggle-season data-sd-item-id="${escHtml(item.id)}" data-season-idx="${si}" title="Toggle season ${se.s}">S${se.s}</button>
                <div class="sd-ep-wrap">${epBubbles}</div>
                <span class="sd-ep-count">${sDone}/${se.eps}</span>
            </div>`;
        }).join("")}</div>`
        : `<div class="sd-no-seasons">No season data</div>`;

    return `<div class="sd-movie-card sd-series-tile" data-sd-item-id="${escHtml(item.id)}"${dragAttrs}>
        ${dragHandle}
        ${safeUrl ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer" draggable="false">` : `<div class="sd-movie-poster">`}
            ${item.posterUrl && _isSafeUrl(item.posterUrl) ? `<img class="sd-movie-poster-img" src="${escHtml(item.posterUrl)}" alt="" loading="lazy" draggable="false">` : `<span class="material-symbols-outlined sd-movie-icon">tv</span>`}
            ${tot > 0 ? `<div class="sd-tile-prog"><div class="sd-tile-prog-fill" style="width:${pct}%"></div></div>` : ""}
            ${item.seasons?.length ? `<div class="sd-season-badge">${item.seasons.length} S</div>` : ""}
        ${safeUrl ? `</a>` : `</div>`}
        <div class="sd-movie-info">
            ${safeUrl ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>` : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
            <button class="sd-expand-toggle" data-toggle-expand="${escHtml(item.id)}" title="${isExpanded ? "Collapse" : "Expand seasons"}">
                <span class="material-symbols-outlined">${isExpanded ? "expand_less" : "expand_more"}</span>
            </button>
        </div>
        <div class="sd-series-expand${isExpanded ? "" : " sd-hidden"}">
            <div class="sd-expand-hdr">
                <button class="sd-toggle-show${allDone ? " sd-toggle-show--done" : ""}" data-toggle-show data-sd-item-id="${escHtml(item.id)}" title="${allDone ? "Unwatch all" : "Watch all"}">
                    <span class="material-symbols-outlined" style="font-size:14px">${allDone ? "remove_done" : "done_all"}</span>
                    ${allDone ? "Unwatch all" : "Watch all"}
                </button>
            </div>
            ${seasonsHtml}
        </div>
        ${footer}
    </div>`;
}

function _sdCollBlockHtml(unit, draggable = false) {
    const collapsed   = _collapsedColls.has(unit.name);
    const hdDragAttrs = draggable ? ` draggable="true" data-coll-drag="${escHtml(unit.name)}"` : "";
    const dragHandle  = draggable ? `<span class="sd-drag-handle sd-drag-handle--coll" title="Drag to reorder">&#8942;</span>` : "";

    if (collapsed) {
        const firstWithPoster = unit.items.find(i => i.posterUrl && _isSafeUrl(i.posterUrl));
        const posterHtml = firstWithPoster
            ? `<img class="sd-movie-poster-img" src="${escHtml(firstWithPoster.posterUrl)}" alt="" loading="lazy">`
            : `<span class="material-symbols-outlined sd-movie-icon">video_library</span>`;
        return `<div class="sd-movie-card sd-coll-collapsed" data-drag-coll="${escHtml(unit.name)}"${hdDragAttrs}>
            ${dragHandle}
            <button class="sd-movie-poster sd-coll-stack-btn" data-coll-toggle="${escHtml(unit.name)}" title="Expand ${escHtml(unit.name)}">
                <div class="sd-cs-layer sd-cs-back2"></div>
                <div class="sd-cs-layer sd-cs-back1"></div>
                <div class="sd-cs-layer sd-cs-front">${posterHtml}</div>
                <div class="sd-cs-count">${unit.items.length}</div>
            </button>
            <div class="sd-movie-info">
                <span class="sd-movie-title" title="${escHtml(unit.name)}">${escHtml(unit.name)}</span>
                <button class="sd-expand-toggle" data-coll-toggle="${escHtml(unit.name)}" title="Expand">
                    <span class="material-symbols-outlined">expand_more</span>
                </button>
            </div>
        </div>`;
    }

    return `<div class="sd-coll-block" data-drag-coll="${escHtml(unit.name)}">
        <div class="sd-coll-hdr"${hdDragAttrs}>
            ${dragHandle}
            <span class="sd-coll-name">${escHtml(unit.name)}</span>
            <span class="sd-coll-badge">${unit.items.length}</span>
            <button class="sd-icon-btn sd-coll-rename-btn" data-rename-coll="${escHtml(unit.name)}" title="Rename collection"><span class="material-symbols-outlined" style="font-size:12px">edit</span></button>
            <button class="sd-coll-toggle" data-coll-toggle="${escHtml(unit.name)}" title="Collapse">
                <span class="material-symbols-outlined">expand_less</span>
            </button>
        </div>
        <div class="sd-coll-inner">
            ${unit.items.map(i => _sdCardHtml(i, true)).join("")}
        </div>
    </div>`;
}

function _attachSdDrag(grid) {
    if (!grid) return;
    if (grid._sdAbort) grid._sdAbort.abort();
    const ctrl = new AbortController();
    grid._sdAbort = ctrl;
    const sig = ctrl.signal;

    // Ensure remove-zone exists in sd-body (shown only when dragging a collection item)
    const sdBody = document.getElementById("sd-body");
    let removeZone = sdBody?.querySelector(".sd-remove-zone");
    if (!removeZone && sdBody) {
        removeZone = document.createElement("div");
        removeZone.className = "sd-remove-zone sd-hidden";
        removeZone.innerHTML = `<span class="material-symbols-outlined">remove_circle_outline</span>Remove from collection`;
        sdBody.appendChild(removeZone);
    }

    function _cleanup() {
        _sdDragSrc = null;
        _sdInsertAfter = false;
        grid.querySelectorAll(".sd-unit-dragging, .sd-drag-over, .sd-drop-before, .sd-drop-after").forEach(el =>
            el.classList.remove("sd-unit-dragging", "sd-drag-over", "sd-drop-before", "sd-drop-after")
        );
        if (removeZone) { removeZone.classList.add("sd-hidden"); removeZone.classList.remove("sd-drag-over"); }
    }

    grid.addEventListener("dragstart", e => {
        const card = e.target.closest("[data-drag-item]");
        const coll = e.target.closest("[data-coll-drag]");
        if (card) {
            _sdDragSrc = { kind: "item", id: card.dataset.dragItem };
            e.dataTransfer.effectAllowed = "move";
            setTimeout(() => {
                if (!_sdDragSrc) return;
                card.classList.add("sd-unit-dragging");
                const srcItem = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === _sdDragSrc.id);
                if (srcItem?.collection && removeZone) removeZone.classList.remove("sd-hidden");
            }, 0);
        } else if (coll) {
            _sdDragSrc = { kind: "coll", name: coll.dataset.collDrag };
            e.dataTransfer.effectAllowed = "move";
            setTimeout(() => {
                if (!_sdDragSrc) return;
                (coll.closest(".sd-coll-block") || coll.closest(".sd-movie-card"))?.classList.add("sd-unit-dragging");
            }, 0);
        } else {
            e.preventDefault();
        }
    }, { signal: sig });

    grid.addEventListener("dragend", _cleanup, { signal: sig });

    grid.addEventListener("dragover", e => {
        if (!_sdDragSrc) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const card    = e.target.closest("[data-drag-item]");
        const collBlk = e.target.closest(".sd-coll-block:not(.sd-movie-card)");
        const collCC  = e.target.closest(".sd-movie-card.sd-coll-collapsed");
        const dragging = grid.querySelector(".sd-unit-dragging");
        grid.querySelectorAll(".sd-drag-over, .sd-drop-before, .sd-drop-after").forEach(el =>
            el.classList.remove("sd-drag-over", "sd-drop-before", "sd-drop-after")
        );
        if (card) {
            if (dragging && (card === dragging || dragging.contains(card))) return;
            const rect = card.getBoundingClientRect();
            _sdInsertAfter = e.clientX > rect.left + rect.width / 2;
            card.classList.add(_sdInsertAfter ? "sd-drop-after" : "sd-drop-before");
        } else if (collBlk || collCC) {
            const tgt = collBlk || collCC;
            if (!(dragging && (tgt === dragging || dragging.contains(tgt)))) tgt.classList.add("sd-drag-over");
        }
    }, { signal: sig });

    grid.addEventListener("dragleave", e => {
        if (!grid.contains(e.relatedTarget))
            grid.querySelectorAll(".sd-drag-over, .sd-drop-before, .sd-drop-after").forEach(el => el.classList.remove("sd-drag-over", "sd-drop-before", "sd-drop-after"));
    }, { signal: sig });

    grid.addEventListener("drop", async e => {
        e.preventDefault();
        if (!_sdDragSrc) return;
        const src = { ..._sdDragSrc };
        const insertAfter = _sdInsertAfter;
        _cleanup();
        const allItems      = _streamCache[_openDrawerLinkId] || [];
        const targetCard    = e.target.closest("[data-drag-item]");
        const targetBlk     = e.target.closest(".sd-coll-block:not(.sd-movie-card)");
        const targetCC      = e.target.closest(".sd-movie-card.sd-coll-collapsed");
        const targetCollName = targetBlk?.dataset.dragColl || targetCC?.dataset.dragColl;

        if (src.kind === "item") {
            const srcItem = allItems.find(i => i.id === src.id);
            if (targetCard && targetCard.dataset.dragItem !== src.id) {
                const tgtItem = allItems.find(i => i.id === targetCard.dataset.dragItem);
                if (srcItem?.collection && srcItem.collection === tgtItem?.collection) {
                    await _reorderWithinColl(src.id, tgtItem.id, srcItem.collection, insertAfter);
                } else if (srcItem?.collection && !tgtItem?.collection) {
                    await _removeFromCollection(src.id);
                } else if (!srcItem?.collection && !tgtItem?.collection) {
                    await _autoCreateCollection(src.id, tgtItem.id, tgtItem.title || "Collection");
                } else {
                    await _reorderStreamUnit(src, { kind: "item", id: targetCard.dataset.dragItem }, insertAfter);
                }
            } else if (targetCollName && srcItem?.collection !== targetCollName) {
                await _setItemCollection(src.id, targetCollName);
            }
        } else if (src.kind === "coll") {
            if (targetCard) {
                await _reorderStreamUnit(src, { kind: "item", id: targetCard.dataset.dragItem }, insertAfter);
            } else if (targetCollName && targetCollName !== src.name) {
                await _reorderStreamUnit(src, { kind: "coll", name: targetCollName }, insertAfter);
            }
        }
    }, { signal: sig });

    if (removeZone) {
        removeZone.addEventListener("dragover", e => {
            if (!_sdDragSrc) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            removeZone.classList.add("sd-drag-over");
        }, { signal: sig });
        removeZone.addEventListener("dragleave", () => removeZone.classList.remove("sd-drag-over"), { signal: sig });
        removeZone.addEventListener("drop", async e => {
            e.preventDefault();
            if (!_sdDragSrc || _sdDragSrc.kind !== "item") { _cleanup(); return; }
            const srcId = _sdDragSrc.id;
            _cleanup();
            await _removeFromCollection(srcId);
        }, { signal: sig });
    }
}

async function _reorderStreamUnit(src, tgt, insertAfter = false) {
    const allItems = _streamCache[_openDrawerLinkId] || [];
    const units    = _buildUnits(allItems);
    const findIdx  = u => {
        if (u.kind === "item") return units.findIndex(un =>
            (un.type === "solo" && un.item.id === u.id) ||
            (un.type === "coll" && un.items.some(i => i.id === u.id))
        );
        if (u.kind === "coll") return units.findIndex(un => un.type === "coll" && un.name === u.name);
        return -1;
    };
    const srcIdx = findIdx(src);
    if (srcIdx < 0) return;
    const newUnits = [...units];
    const [moved]  = newUnits.splice(srcIdx, 1);
    const tgtIdx   = newUnits.findIndex(un => {
        if (tgt.kind === "item") return (un.type === "solo" && un.item.id === tgt.id) || (un.type === "coll" && un.items.some(i => i.id === tgt.id));
        if (tgt.kind === "coll") return un.type === "coll" && un.name === tgt.name;
        return false;
    });
    if (tgtIdx < 0) return;
    newUnits.splice(insertAfter ? tgtIdx + 1 : tgtIdx, 0, moved);
    const updates = [];
    newUnits.forEach((unit, ui) => {
        const items = unit.type === "solo" ? [unit.item] : unit.items;
        items.forEach((item, ii) => {
            const newSO = ui * 10000 + ii * 100;
            if (item.sortOrder !== newSO) {
                item.sortOrder = newSO;
                updates.push(updateDoc(
                    doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", item.id),
                    { sortOrder: newSO }
                ));
            }
        });
    });
    try {
        await Promise.all(updates);
        _renderLibrary();
    } catch (err) { console.error(err); toast("Error reordering", "error"); }
}

async function _reorderWithinColl(srcId, tgtId, collName, insertAfter = false) {
    const allItems  = _streamCache[_openDrawerLinkId] || [];
    const collItems = _sdSorted(allItems.filter(i => i.collection === collName));
    const srcIdx    = collItems.findIndex(i => i.id === srcId);
    const tgtIdx    = collItems.findIndex(i => i.id === tgtId);
    if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
    const newOrder = [...collItems];
    const [moved]  = newOrder.splice(srcIdx, 1);
    const postTgtIdx = newOrder.findIndex(i => i.id === tgtId);
    if (postTgtIdx < 0) return;
    newOrder.splice(insertAfter ? postTgtIdx + 1 : postTgtIdx, 0, moved);
    const updates = newOrder.map((item, i) => {
        const newSO = i * 100;
        item.sortOrder = newSO;
        return updateDoc(
            doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", item.id),
            { sortOrder: newSO }
        );
    });
    try {
        await Promise.all(updates);
        _renderLibrary();
    } catch (err) { console.error(err); toast("Error reordering", "error"); }
}

async function _hubReorderUnit(srcId, tgtId, allItems, insertAfter = false) {
    const units = _buildUnits(allItems);
    const srcUnitIdx = units.findIndex(u =>
        (u.type === "solo" && u.item.id === srcId) ||
        (u.type === "coll" && u.items.some(i => i.id === srcId))
    );
    if (srcUnitIdx < 0) return;
    const newUnits = [...units];
    const [moved] = newUnits.splice(srcUnitIdx, 1);
    const tgtUnitIdx = newUnits.findIndex(u =>
        (u.type === "solo" && u.item.id === tgtId) ||
        (u.type === "coll" && u.items.some(i => i.id === tgtId))
    );
    if (tgtUnitIdx < 0) return;
    newUnits.splice(insertAfter ? tgtUnitIdx + 1 : tgtUnitIdx, 0, moved);
    const writes = [];
    newUnits.forEach((unit, ui) => {
        const items = unit.type === "solo" ? [unit.item] : unit.items;
        items.forEach((item, ii) => {
            const newSO = ui * 10000 + ii * 100;
            if (item.sortOrder !== newSO) {
                item.sortOrder = newSO;
                const cached = (_streamCache[item._serviceId] || []).find(c => c.id === item.id);
                if (cached) cached.sortOrder = newSO;
                writes.push(updateDoc(
                    doc(_db, "users", _user.uid, "gallery-links", item._serviceId, "streaming-items", item.id),
                    { sortOrder: newSO }
                ));
            }
        });
    });
    try {
        await Promise.all(writes);
    } catch (err) { console.error(err); toast("Error reordering", "error"); }
}

function _attachHubDrag(grid, allItems, container) {
    if (!grid) return;
    if (grid._sdAbort) grid._sdAbort.abort();
    const ctrl = new AbortController();
    grid._sdAbort = ctrl;
    const sig = ctrl.signal;
    let _hubDragSrc = null;

    function _cleanup() {
        _hubDragSrc = null;
        grid.querySelectorAll(".sd-unit-dragging, .sd-drop-before, .sd-drop-after")
            .forEach(el => el.classList.remove("sd-unit-dragging", "sd-drop-before", "sd-drop-after"));
    }

    grid.addEventListener("dragstart", e => {
        const card = e.target.closest("[data-hub-drag-item]");
        if (!card) { e.preventDefault(); return; }
        _hubDragSrc = { id: card.dataset.hubDragItem, svcId: card.dataset.hubSvcId };
        e.dataTransfer.effectAllowed = "move";
        setTimeout(() => { if (_hubDragSrc) card.classList.add("sd-unit-dragging"); }, 0);
    }, { signal: sig });

    grid.addEventListener("dragend", _cleanup, { signal: sig });

    grid.addEventListener("dragover", e => {
        if (!_hubDragSrc) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const card = e.target.closest("[data-hub-drag-item]");
        if (!card) return;
        const dragging = grid.querySelector(".sd-unit-dragging");
        if (dragging && (card === dragging || dragging.contains(card))) return;
        const rect = card.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        grid.querySelectorAll(".sd-drop-before, .sd-drop-after")
            .forEach(el => el.classList.remove("sd-drop-before", "sd-drop-after"));
        card.classList.add(after ? "sd-drop-after" : "sd-drop-before");
    }, { signal: sig });

    grid.addEventListener("dragleave", e => {
        if (!grid.contains(e.relatedTarget))
            grid.querySelectorAll(".sd-drop-before, .sd-drop-after")
                .forEach(el => el.classList.remove("sd-drop-before", "sd-drop-after"));
    }, { signal: sig });

    grid.addEventListener("drop", async e => {
        e.preventDefault();
        if (!_hubDragSrc) return;
        const src = { ..._hubDragSrc };
        const afterEl  = grid.querySelector(".sd-drop-after");
        const beforeEl = grid.querySelector(".sd-drop-before");
        const insertAfter = !!afterEl;
        const tgtCard = afterEl || beforeEl;
        _cleanup();
        if (!tgtCard || tgtCard.dataset.hubDragItem === src.id) return;
        await _hubReorderUnit(src.id, tgtCard.dataset.hubDragItem, allItems, insertAfter);
        if (_hubLastServices) {
            const fresh = _buildHubItems(_hubLastServices);
            _renderHubContent(container, fresh);
        }
    }, { signal: sig });
}

async function _setItemCollection(itemId, collName) {
    const items = _streamCache[_openDrawerLinkId] || [];
    const item  = items.find(i => i.id === itemId);
    if (!item) return;
    const updates    = { collection: collName };
    const collItems  = items.filter(i => i.collection === collName && i.id !== itemId);
    if (collItems.length) {
        const maxSO      = Math.max(...collItems.map(i => i.sortOrder ?? i.addedAt ?? 0));
        updates.sortOrder = maxSO + 100;
        item.sortOrder    = maxSO + 100;
    }
    item.collection = collName;
    try {
        await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), updates);
        _renderLibrary();
        toast(`Added to "${collName}"`, "success");
    } catch (err) { console.error(err); toast("Error updating", "error"); }
}

async function _removeFromCollection(itemId) {
    const items = _streamCache[_openDrawerLinkId] || [];
    const item  = items.find(i => i.id === itemId);
    if (!item || !item.collection) return;
    delete item.collection;
    try {
        await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId),
            { collection: deleteField() });
        _renderLibrary();
    } catch (err) { console.error(err); toast("Error updating", "error"); }
}

async function _autoCreateCollection(srcId, tgtId, name) {
    const items    = _streamCache[_openDrawerLinkId] || [];
    const srcItem  = items.find(i => i.id === srcId);
    const tgtItem  = items.find(i => i.id === tgtId);
    if (!srcItem || !tgtItem) return;
    srcItem.collection = name;
    tgtItem.collection = name;
    try {
        await Promise.all([
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", srcId),  { collection: name }),
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", tgtId),  { collection: name }),
        ]);
        _renderLibrary();
        toast(`Collection "${name}" created`, "success");
    } catch (err) { console.error(err); toast("Error creating collection", "error"); }
}

async function _renameCollection(oldName, newName) {
    const items    = _streamCache[_openDrawerLinkId] || [];
    const affected = items.filter(i => i.collection === oldName);
    if (!affected.length) return;
    affected.forEach(i => { i.collection = newName; });
    if (_collapsedColls.has(oldName)) { _collapsedColls.delete(oldName); _collapsedColls.add(newName); }
    try {
        await Promise.all(affected.map(i =>
            updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", i.id),
                { collection: newName })
        ));
        _renderLibrary();
        toast("Collection renamed", "success");
    } catch (err) { console.error(err); toast("Error renaming", "error"); }
}

function _openCollRename(name) {
    let modal = document.getElementById("sd-coll-rename-modal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "sd-coll-rename-modal";
        modal.className = "sd-iem-overlay sd-hidden";
        modal.innerHTML = `
            <div class="sd-iem-panel">
                <div class="sd-iem-title">Rename Collection</div>
                <label class="sd-iem-field">
                    <span class="sd-iem-lbl">Name</span>
                    <input id="sd-crm-input" class="sd-add-input" autocomplete="off" maxlength="80">
                </label>
                <div class="sd-iem-btns">
                    <button id="sd-crm-cancel" class="sd-cancel-btn">Cancel</button>
                    <button id="sd-crm-save" class="sd-save-btn">Rename</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("sd-hidden"); });
        document.getElementById("sd-crm-cancel").addEventListener("click", () => modal.classList.add("sd-hidden"));
        document.getElementById("sd-crm-save").addEventListener("click", _saveCollRename);
        document.getElementById("sd-crm-input").addEventListener("keydown", e => {
            if (e.key === "Enter")  _saveCollRename();
            if (e.key === "Escape") modal.classList.add("sd-hidden");
        });
    }
    modal._oldName = name;
    document.getElementById("sd-crm-input").value = name;
    modal.classList.remove("sd-hidden");
    setTimeout(() => { const inp = document.getElementById("sd-crm-input"); inp.focus(); inp.select(); }, 40);
}

async function _saveCollRename() {
    const modal   = document.getElementById("sd-coll-rename-modal");
    const oldName = modal?._oldName;
    const newName = document.getElementById("sd-crm-input")?.value.trim();
    if (!newName || newName === oldName) { modal?.classList.add("sd-hidden"); return; }
    modal.classList.add("sd-hidden");
    await _renameCollection(oldName, newName);
}

function _openItemEdit(itemId) {
    const item = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
    if (!item) return;
    let modal = document.getElementById("sd-item-edit-modal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "sd-item-edit-modal";
        modal.className = "sd-iem-overlay";
        modal.innerHTML = `
            <div class="sd-iem-panel">
                <div class="sd-iem-title">Edit item</div>
                <label class="sd-iem-field">
                    <span class="sd-iem-lbl">Title</span>
                    <input id="sd-iem-title" class="sd-add-input" autocomplete="off" maxlength="200">
                </label>
                <label class="sd-iem-field">
                    <span class="sd-iem-lbl">Collection <small style="opacity:.5">(groups related titles together)</small></span>
                    <input id="sd-iem-coll" class="sd-add-input" list="sd-iem-coll-dl" autocomplete="off" placeholder="e.g. Star Wars, MCU…" maxlength="80">
                    <datalist id="sd-iem-coll-dl"></datalist>
                </label>
                <div class="sd-iem-btns">
                    <button id="sd-iem-cancel" class="sd-cancel-btn">Cancel</button>
                    <button id="sd-iem-save" class="sd-save-btn">Save</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("sd-hidden"); });
        document.getElementById("sd-iem-cancel").addEventListener("click", () => modal.classList.add("sd-hidden"));
        document.getElementById("sd-iem-save").addEventListener("click", _saveItemEdit);
        document.getElementById("sd-iem-title").addEventListener("keydown", e => {
            if (e.key === "Enter")  _saveItemEdit();
            if (e.key === "Escape") modal.classList.add("sd-hidden");
        });
    }
    modal._editItemId = itemId;
    document.getElementById("sd-iem-title").value = item.title || "";
    document.getElementById("sd-iem-coll").value  = item.collection || "";
    const allColls = [...new Set(
        Object.values(_streamCache)
            .flat()
            .filter(i => i.collection && i.id !== itemId)
            .map(i => i.collection)
    )];
    document.getElementById("sd-iem-coll-dl").innerHTML = allColls.map(c => `<option value="${escHtml(c)}">`).join("");
    modal.classList.remove("sd-hidden");
    setTimeout(() => document.getElementById("sd-iem-title").focus(), 40);
}

async function _saveItemEdit() {
    const modal  = document.getElementById("sd-item-edit-modal");
    const itemId = modal?._editItemId;
    const item   = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
    if (!item) return;
    const title = document.getElementById("sd-iem-title").value.trim();
    const coll  = document.getElementById("sd-iem-coll").value.trim() || null;
    if (!title) { toast("Title cannot be empty", "error"); return; }
    const changes = {};
    if (title !== (item.title || "")) { changes.title = title; item.title = title; }
    const oldColl = item.collection || null;
    if (coll !== oldColl) {
        changes.collection = coll || deleteField();
        item.collection    = coll;
        if (coll) {
            const collItems = (_streamCache[_openDrawerLinkId] || [])
                .filter(i => i.collection === coll && i.id !== itemId);
            if (collItems.length) {
                const maxSO    = Math.max(...collItems.map(i => i.sortOrder ?? i.addedAt ?? 0));
                changes.sortOrder = maxSO + 100;
                item.sortOrder    = maxSO + 100;
            }
        }
    }
    if (!Object.keys(changes).length) { modal.classList.add("sd-hidden"); return; }
    try {
        await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), changes);
        modal.classList.add("sd-hidden");
        _renderLibrary();
        toast("Saved", "success");
    } catch (err) { console.error(err); toast("Error saving", "error"); }
}

function _openHubItemForm(services) {
    let form = document.getElementById("sh-item-add-form");
    if (!form) {
        form = document.createElement("div");
        form.id = "sh-item-add-form";
        form.className = "sh-item-add-form sd-hidden";
        form.innerHTML = `
            <img id="sh-iaf-poster" class="sd-add-poster-preview" src="" alt="" style="display:none">
            <div class="sd-add-form-fields">
                <select id="sh-iaf-service" class="sd-add-input"></select>
                <input id="sh-iaf-title" class="sd-add-input" placeholder="Search title\u2026">
                <input id="sh-iaf-url" class="sd-add-input" placeholder="Link (optional)\u2026">
                <input id="sh-iaf-coll" class="sd-add-input" list="sh-iaf-coll-dl" autocomplete="off" placeholder="Collection (optional)\u2026" maxlength="80">
                <datalist id="sh-iaf-coll-dl"></datalist>
                <input type="hidden" id="sh-iaf-poster-val">
            </div>
            <div class="sd-add-type-btns">
                <button type="button" id="sh-iaf-movie" class="sd-save-btn sd-type-btn"><span class="material-symbols-outlined">movie</span>Movie</button>
                <button type="button" id="sh-iaf-series" class="sd-save-btn sd-type-btn sd-type-btn--series"><span class="material-symbols-outlined">tv</span>Series</button>
                <button type="button" id="sh-iaf-cancel" class="sd-cancel-btn">\u2715</button>
            </div>`;
        document.body.appendChild(form);

        async function shSaveItem(type) {
            const linkId = document.getElementById("sh-iaf-service").value;
            const rawUrl = document.getElementById("sh-iaf-url").value.trim();
            let   title  = document.getElementById("sh-iaf-title").value.trim();
            if (!title && rawUrl) title = _extractTitleFromUrl(rawUrl) || "";
            if (!title || !linkId) { toast("Enter a title and select a service", "error"); return; }
            const itemUrl = rawUrl && _isSafeUrl(rawUrl) ? rawUrl : null;
            const rawPoster = document.getElementById("sh-iaf-poster-val").value || "";
            let   posterUrl = rawPoster && _isSafeUrl(rawPoster) ? rawPoster : null;
            let   seasons   = [];
            const collectionName = document.getElementById("sh-iaf-coll")?.value.trim() || null;
            if (type === "series") {
                const meta = await _fetchTmdbMeta(rawUrl || null, title, "series");
                if (meta) {
                    if (!posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
                    if (meta.seasons?.length) seasons = meta.seasons;
                }
            }
            try {
                await _saveStreamItem(linkId, type, title, itemUrl, posterUrl, seasons, collectionName);
                form.classList.add("sd-hidden");
                const svcs = _links.filter(l => l.category === _shCatName);
                _renderHubContent(document.getElementById("sh-content"), _buildHubItems(svcs));
                toast(`${type === "movie" ? "Movie" : "Series"} added`, "success");
            } catch (err) { console.error(err); toast("Error adding item", "error"); }
        }

        let _iafTimer = null;
        document.getElementById("sh-iaf-title").addEventListener("input", () => {
            clearTimeout(_iafTimer);
            _iafTimer = setTimeout(async () => {
                const title = document.getElementById("sh-iaf-title").value.trim();
                const url   = document.getElementById("sh-iaf-url").value.trim();
                if (!title && !url) return;
                const meta = await _fetchTmdbMeta(url, title, "movie");
                if (meta?.posterUrl) {
                    document.getElementById("sh-iaf-poster-val").value = meta.posterUrl;
                    const p = document.getElementById("sh-iaf-poster");
                    p.src = meta.posterUrl; p.style.display = "";
                }
                if (meta?.title && !document.getElementById("sh-iaf-title").value.trim()) {
                    document.getElementById("sh-iaf-title").value = meta.title;
                }
            }, 600);
        });
        document.getElementById("sh-iaf-url").addEventListener("input", () => {
            clearTimeout(_iafTimer);
            _iafTimer = setTimeout(async () => {
                const url   = document.getElementById("sh-iaf-url").value.trim();
                const title = document.getElementById("sh-iaf-title").value.trim();
                if (!url) return;
                const meta = await _fetchTmdbMeta(url, title, "movie");
                if (meta?.posterUrl) {
                    document.getElementById("sh-iaf-poster-val").value = meta.posterUrl;
                    const p = document.getElementById("sh-iaf-poster");
                    p.src = meta.posterUrl; p.style.display = "";
                }
                if (meta?.title) document.getElementById("sh-iaf-title").value = meta.title;
            }, 500);
        });
        document.getElementById("sh-iaf-movie").addEventListener("click",  () => shSaveItem("movie"));
        document.getElementById("sh-iaf-series").addEventListener("click", () => shSaveItem("series"));
        document.getElementById("sh-iaf-cancel").addEventListener("click", () => form.classList.add("sd-hidden"));
    }

    const sel = document.getElementById("sh-iaf-service");
    sel.innerHTML = services.map(s =>
        `<option value="${escHtml(s.id)}">${escHtml(_serviceLabel(s))}</option>`
    ).join("");
    document.getElementById("sh-iaf-title").value = "";
    document.getElementById("sh-iaf-url").value = "";
    document.getElementById("sh-iaf-coll").value = "";
    document.getElementById("sh-iaf-poster-val").value = "";
    const p = document.getElementById("sh-iaf-poster"); p.src = ""; p.style.display = "none";
    // Populate collection datalist from all services
    const _allHubColls = [...new Set(
        Object.values(_streamCache).flat().filter(i => i.collection).map(i => i.collection)
    )];
    document.getElementById("sh-iaf-coll-dl").innerHTML =
        _allHubColls.map(c => `<option value="${escHtml(c)}">`).join("");
    form.classList.remove("sd-hidden");
    setTimeout(() => document.getElementById("sh-iaf-title").focus(), 40);
}

function _ensureStreamingDrawer() {
    if (document.getElementById("streaming-drawer")) return;
    const el = document.createElement("div");
    el.id = "streaming-drawer";
    el.className = "streaming-drawer sd-closed";
    el.innerHTML = `
        <div class="sd-overlay"></div>
        <div class="sd-panel">
            <div class="sd-hero">
                <button id="sd-close-btn" class="sd-close-btn" title="Close">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div class="sd-hero-inner">
                    <img id="sd-favicon" class="sd-hero-favicon" src="" alt="" onerror="this.style.display='none'">
                    <div class="sd-hero-text">
                        <div id="sd-title" class="sd-hero-title"></div>
                        <div id="sd-stats" class="sd-hero-stats"></div>
                    </div>
                    <a id="sd-visit-btn" href="#" target="_blank" rel="noopener noreferrer" class="sd-watch-btn" title="Open service">
                        <span class="material-symbols-outlined">play_arrow</span><span>Watch</span>
                    </a>
                </div>
            </div>
            <div class="sd-progress-track"><div id="sd-progress-fill" class="sd-progress-fill"></div></div>
            <div class="sd-toolbar">
                <div class="sd-tabs" id="sd-tabs">
                    <button class="sd-tab sd-tab-active" data-sd-tab="all">All</button>
                    <button class="sd-tab" data-sd-tab="movie">Movies</button>
                    <button class="sd-tab" data-sd-tab="series">Series</button>
                </div>
                <button id="sd-add-fab" class="sd-add-fab" title="Add movie or series">
                    <span class="material-symbols-outlined">add</span>
                </button>
            </div>
            <div id="sd-add-form" class="sd-add-form sd-hidden">
                <img id="sd-add-poster-preview" class="sd-add-poster-preview" src="" alt="">
                <div class="sd-add-form-fields">
                    <input type="text" id="sd-add-title" class="sd-add-input" placeholder="Search title…" maxlength="120" autocomplete="off">
                    <input type="url" id="sd-add-url" class="sd-add-input sd-add-url" placeholder="Link (optional)…" autocomplete="off">
                    <input type="hidden" id="sd-add-poster" value="">
                    <div id="sd-search-results" class="sd-search-results sd-hidden"></div>
                </div>
                <div class="sd-add-type-btns">
                    <button type="button" id="sd-add-save-movie" class="sd-save-btn sd-type-btn"><span class="material-symbols-outlined">movie</span>Movie</button>
                    <button type="button" id="sd-add-save-series" class="sd-save-btn sd-type-btn sd-type-btn--series"><span class="material-symbols-outlined">tv</span>Series</button>
                    <button type="button" id="sd-add-cancel" class="sd-cancel-btn">✕</button>
                </div>
            </div>
            <div id="sd-body" class="sd-body"></div>
        </div>`;
    document.body.appendChild(el);

    el.querySelector(".sd-overlay").addEventListener("click", _closeLibrary);
    document.getElementById("sd-close-btn").addEventListener("click", _closeLibrary);

    // Domain-group link interception: rewrite to first reachable domain before navigating
    el.addEventListener("click", async e => {
        const a = e.target.closest("a[target='_blank']");
        if (!a || !a.href || !_findDomainGroup(a.href)) return;
        e.preventDefault();
        const resolved = await _resolveServiceUrl(a.href);
        window.open(resolved, "_blank", "noopener,noreferrer");
    });
    document.getElementById("sd-tabs").addEventListener("click", e => {
        const tab = e.target.closest("[data-sd-tab]");
        if (!tab) return;
        _sdActiveTab = tab.dataset.sdTab;
        el.querySelectorAll(".sd-tab").forEach(t => t.classList.toggle("sd-tab-active", t === tab));
        _renderLibrary();
    });


    let _pendingType    = null;
    let _selectedResult = null;

    function _hideSearchResults() {
        const el = document.getElementById("sd-search-results");
        if (el) { el.innerHTML = ""; el.classList.add("sd-hidden"); }
    }

    function _pickResult(result) {
        _selectedResult = result;
        const titleInp = document.getElementById("sd-add-title");
        const prevImg  = document.getElementById("sd-add-poster-preview");
        titleInp.value = result.title;
        document.getElementById("sd-add-poster").value = result.posterUrl || "";
        if (prevImg) {
            if (result.posterUrl) { prevImg.src = result.posterUrl; prevImg.style.display = ""; }
            else { prevImg.src = ""; prevImg.style.display = "none"; }
        }
        _hideSearchResults();
    }

    async function _searchTmdbMulti(query) {
        const key = _getTmdbKey();
        if (!key || !query) return [];
        try {
            const [mvRes, tvRes] = await Promise.all([
                fetch(`https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&language=en-US&page=1`),
                fetch(`https://api.themoviedb.org/3/search/tv?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&language=en-US&page=1`),
            ]);
            const mvData = mvRes.ok ? (await mvRes.json()).results || [] : [];
            const tvData = tvRes.ok ? (await tvRes.json()).results || [] : [];
            const movies = mvData.slice(0, 5).map(r => ({
                title:      r.title || "",
                year:       r.release_date?.slice(0, 4) || "",
                posterUrl:  r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
                kind:       "movie",
                tmdbId:     r.id,
                popularity: r.popularity || 0,
            }));
            const shows = tvData.slice(0, 5).map(r => ({
                title:      r.name || "",
                year:       r.first_air_date?.slice(0, 4) || "",
                posterUrl:  r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
                kind:       "series",
                tmdbId:     r.id,
                popularity: r.popularity || 0,
            }));
            return [...movies, ...shows]
                .sort((a, b) => b.popularity - a.popularity)
                .slice(0, 8);
        } catch { return []; }
    }

    let _searchTimer = null;
    function _triggerSearch() {
        clearTimeout(_searchTimer);
        const titleInp = document.getElementById("sd-add-title");
        const query = titleInp.value.trim();
        if (!query) { _hideSearchResults(); return; }
        if (_selectedResult && _selectedResult.title === query) return;
        _selectedResult = null;
        document.getElementById("sd-add-poster").value = "";
        const prevImg = document.getElementById("sd-add-poster-preview");
        if (prevImg) { prevImg.src = ""; prevImg.style.display = "none"; }
        _searchTimer = setTimeout(async () => {
            const results = await _searchTmdbMulti(query);
            const el = document.getElementById("sd-search-results");
            if (!el) return;
            if (!results.length) { _hideSearchResults(); return; }
            el.innerHTML = results.map((r, i) => `
                <button class="sd-sr-item" data-sr-idx="${i}" type="button">
                    ${r.posterUrl
                        ? `<img class="sd-sr-poster" src="${escHtml(r.posterUrl)}" alt="" loading="lazy">`
                        : `<div class="sd-sr-poster sd-sr-poster--empty"><span class="material-symbols-outlined">${r.kind === "series" ? "tv" : "movie"}</span></div>`
                    }
                    <div class="sd-sr-info">
                        <span class="sd-sr-title">${escHtml(r.title)}</span>
                        <span class="sd-sr-meta">${r.year ? escHtml(r.year) + " \u00b7 " : ""}${r.kind === "series" ? "Series" : "Movie"}</span>
                    </div>
                </button>
            `).join("");
            el.classList.remove("sd-hidden");
            el._results = results;
        }, 500);
    }

    function showAddForm() {
        _pendingType    = null;
        _selectedResult = null;
        document.getElementById("sd-add-form").classList.remove("sd-hidden");
        const titleInp = document.getElementById("sd-add-title");
        const prevImg  = document.getElementById("sd-add-poster-preview");
        document.getElementById("sd-add-url").value   = "";
        titleInp.value = "";
        document.getElementById("sd-add-poster").value = "";
        _hideSearchResults();
        if (prevImg) { prevImg.src = ""; prevImg.style.display = "none"; }
        titleInp.placeholder = "Search title\u2026";
        titleInp.focus();
    }
    document.getElementById("sd-add-title").addEventListener("input", _triggerSearch);
    let _pageTitleTimer = null;
    document.getElementById("sd-add-url").addEventListener("input", () => {
        const url      = document.getElementById("sd-add-url").value.trim();
        const titleInp = document.getElementById("sd-add-title");
        if (url && !titleInp.value.trim()) {
            const ex = _extractTitleFromUrl(url);
            if (ex) {
                titleInp.value = ex;
                _triggerSearch();
            } else if (_isSafeUrl(url)) {
                titleInp.placeholder = "Fetching title\u2026";
                clearTimeout(_pageTitleTimer);
                _pageTitleTimer = setTimeout(async () => {
                    const fetched = await _fetchTitleFromStreamingPage(url);
                    if (fetched && !titleInp.value.trim()) {
                        titleInp.value = fetched;
                        titleInp.placeholder = "Search title\u2026";
                        _triggerSearch();
                    } else if (!titleInp.value.trim()) {
                        titleInp.placeholder = "Type title to search\u2026";
                    }
                }, 400);
            }
        }
    });
    document.getElementById("sd-add-title").addEventListener("focus", () => {
        document.getElementById("sd-add-title").placeholder = "Search title\u2026";
    });
    document.getElementById("sd-search-results").addEventListener("click", e => {
        const btn = e.target.closest(".sd-sr-item");
        if (!btn) return;
        const idx = parseInt(btn.dataset.srIdx, 10);
        const results = document.getElementById("sd-search-results")._results;
        if (!results?.[idx]) return;
        _pickResult(results[idx]);
        _pendingType = results[idx].kind;
    });

    document.getElementById("sd-add-fab").addEventListener("click", showAddForm);
    document.getElementById("sd-add-cancel").addEventListener("click", () => {
        document.getElementById("sd-add-form").classList.add("sd-hidden");
        _pendingType    = null;
        _selectedResult = null;
        _hideSearchResults();
    });

    async function saveItem(type) {
        _pendingType = type;
        _hideSearchResults();
        const rawUrl = document.getElementById("sd-add-url").value.trim();
        let   title  = document.getElementById("sd-add-title").value.trim();
        if (!title && rawUrl) title = _extractTitleFromUrl(rawUrl) || "";
        if (!title) { toast("Enter a title to search", "error"); return; }
        if (!_openDrawerLinkId) return;
        const itemUrl = rawUrl && _isSafeUrl(rawUrl) ? rawUrl : null;
        let   posterUrl = null;
        let   seasons   = [];
        if (_selectedResult) {
            posterUrl = _selectedResult.posterUrl || null;
            title     = _selectedResult.title || title;
            if (type === "series" && _selectedResult.tmdbId) {
                const meta = await _fetchTmdbMeta(
                    `https://www.themoviedb.org/tv/${_selectedResult.tmdbId}`, title, "series"
                );
                if (meta) {
                    if (meta.posterUrl) posterUrl = meta.posterUrl;
                    if (meta.seasons?.length) seasons = meta.seasons;
                }
            }
        } else {
            const rawPoster = document.getElementById("sd-add-poster")?.value || "";
            posterUrl = rawPoster && _isSafeUrl(rawPoster) ? rawPoster : null;
            if (type === "series") {
                const meta = await _fetchTmdbMeta(rawUrl || null, title, "series");
                if (meta) {
                    if (!posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
                    if (meta.seasons?.length) seasons = meta.seasons;
                }
            } else {
                const meta = await _fetchTmdbMeta(rawUrl || null, title, "movie");
                if (meta) {
                    if (!posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
                }
            }
        }
        try {
            await _saveStreamItem(_openDrawerLinkId, type, title, itemUrl, posterUrl, seasons);
            document.getElementById("sd-add-form").classList.add("sd-hidden");
            _pendingType    = null;
            _selectedResult = null;
            _renderLibrary();
        } catch (err) { console.error(err); toast("Error adding item", "error"); }
    }
    const _setHint = type => { _pendingType = type; };
    document.getElementById("sd-add-save-movie").addEventListener("mouseenter", () => _setHint("movie"));
    document.getElementById("sd-add-save-series").addEventListener("mouseenter", () => _setHint("series"));
    document.getElementById("sd-add-save-movie").addEventListener("click",  () => saveItem("movie"));
    document.getElementById("sd-add-save-series").addEventListener("click", () => saveItem("series"));
    document.getElementById("sd-add-title").addEventListener("keydown", e => {
        if (e.key === "Escape") document.getElementById("sd-add-cancel").click();
    });
    document.getElementById("sd-add-url").addEventListener("keydown", e => {
        if (e.key === "Escape") document.getElementById("sd-add-cancel").click();
    });
    document.getElementById("sd-body").addEventListener("click", _onLibraryBodyClick);
}

/* ══════════ LIBRARY OPEN / CLOSE / RENDER ══════════ */

// Multi-domain groups: domains listed in priority order (first = preferred)
// When a stored URL uses any domain in the group, the system tries them in
// order and rewrites the URL to the first reachable one before navigating.
const _SD_DOMAIN_GROUPS = {
    "pstream": ["pstream.net", "pstream.to", "pstream.org", "pstream.com"],
};

function _findDomainGroup(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        for (const [, domains] of Object.entries(_SD_DOMAIN_GROUPS)) {
            if (domains.some(d => hostname === d || hostname.endsWith("." + d))) {
                return domains;
            }
        }
    } catch { /* noop */ }
    return null;
}

async function _isDomainReachable(domain) {
    const key = `sd_domain_ok_${domain}`;
    const cached = localStorage.getItem(key);
    if (cached) {
        try {
            const { ok, ts } = JSON.parse(cached);
            if (Date.now() - ts < 3_600_000) return ok;
        } catch { /* stale */ }
    }
    try {
        await fetch(`https://${domain}/`, { method: "HEAD", mode: "no-cors", signal: AbortSignal.timeout(5000) });
        localStorage.setItem(key, JSON.stringify({ ok: true, ts: Date.now() }));
        return true;
    } catch {
        localStorage.setItem(key, JSON.stringify({ ok: false, ts: Date.now() }));
        return false;
    }
}

function _swapDomain(url, newDomain) {
    try {
        const u = new URL(url);
        u.hostname = newDomain;
        return u.toString();
    } catch { return url; }
}

async function _resolveServiceUrl(url) {
    const domains = _findDomainGroup(url);
    if (!domains) return url;
    for (const domain of domains) {
        if (await _isDomainReachable(domain)) return _swapDomain(url, domain);
    }
    return url; // all domains unreachable, return original
}

const _SD_BRAND_COLORS = {
    "netflix.com":           "#e50914",
    "primevideo.com":        "#00a8e1",
    "amazon.com":            "#00a8e1",
    "disneyplus.com":        "#0063e5",
    "hulu.com":              "#1ce783",
    "max.com":               "#002be7",
    "hbomax.com":            "#5822b4",
    "appletv.apple.com":     "#595959",
    "tv.apple.com":          "#595959",
    "peacocktv.com":         "#e8c84a",
    "paramountplus.com":     "#0064ff",
    "discoveryplus.com":     "#2175d9",
    "crunchyroll.com":       "#f47521",
    "funimation.com":        "#5b0bb5",
    "mubi.com":              "#00b4b4",
    "tubi.tv":               "#fa4040",
    "pluto.tv":              "#fff200",
    "dazn.com":              "#f8ff00",
    "britbox.com":           "#1d4d7e",
    "acorn.tv":              "#518b34",
    "viaplay.com":           "#09f",
    "svtplay.se":            "#1a6ab2",
    "nrk.no":                "#00b9f2",
    "tv2.no":                "#e8000d",
    "areena.yle.fi":         "#00a0dc",
    "plex.tv":               "#e5a00d",
    "pstream.net":           "#8288fe",
    "pstream.to":            "#8288fe",
};

function _sdBrandColor(url) {
    if (!url) return null;
    try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        for (const [k, v] of Object.entries(_SD_BRAND_COLORS)) {
            if (h === k || h.endsWith("." + k)) return v;
        }
    } catch { /* noop */ }
    return null;
}

function _applyBrandColor(color) {
    document.documentElement.style.setProperty("--sd-brand", color || "#e50914");
}

async function _resolveBrandColor(url) {
    if (!url) return "#e50914";
    // 1. Hardcoded map (instant)
    const hardcoded = _sdBrandColor(url);
    if (hardcoded) return hardcoded;
    // 2. localStorage cache
    const domain = _domain(url);
    if (domain) {
        const cached = localStorage.getItem(`sd_brand_${domain}`);
        if (cached) return cached;
    }
    // 3. Async: fetch the page and read <meta name="theme-color">
    try {
        const res = await fetch(
            `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (res.ok) {
            const json = await res.json();
            const html = json.contents || "";
            const m = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
            if (m) {
                const color = m[1].trim();
                if (/^#[0-9a-f]{3,8}$/i.test(color) || /^rgba?\(/.test(color) || /^hsl/.test(color)) {
                    if (domain) localStorage.setItem(`sd_brand_${domain}`, color);
                    return color;
                }
            }
        }
    } catch { /* noop — offline or CORS */ }
    return "#e50914";
}

async function _openLibrary(linkId) {
    _openDrawerLinkId = linkId;
    _ensureStreamingDrawer();
    const link = _links.find(l => l.id === linkId);
    if (!link) return;

    const titleEl  = document.getElementById("sd-title");
    const faviconEl = document.getElementById("sd-favicon");
    const visitBtn = document.getElementById("sd-visit-btn");
    if (titleEl)  titleEl.textContent = link.title || _domain(link.url) || "Streaming";
    if (faviconEl) {
        const d = _domain(link.url);
        faviconEl.src = d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : "";
        faviconEl.style.display = d ? "" : "none";
    }
    if (visitBtn && _isSafeUrl(link.url)) visitBtn.href = link.url;

    // Apply brand colour: instant from map/cache, then update async for unknown services
    const domain = _domain(link.url);
    const immediateColor = _sdBrandColor(link.url)
        || (domain ? localStorage.getItem(`sd_brand_${domain}`) : null)
        || "#e50914";
    _applyBrandColor(immediateColor);
    _resolveBrandColor(link.url).then(color => { if (color !== immediateColor) _applyBrandColor(color); });

    _sdActiveTab = "all";
    const drawer = document.getElementById("streaming-drawer");
    drawer.querySelectorAll(".sd-tab").forEach(t =>
        t.classList.toggle("sd-tab-active", t.dataset.sdTab === "all")
    );
    drawer.classList.remove("sd-closed");
    requestAnimationFrame(() => drawer.classList.add("sd-open"));
    document.body.style.overflow = "hidden";

    await _loadStreamItems(linkId);
    _renderLibrary();
}

function _closeLibrary() {
    const drawer = document.getElementById("streaming-drawer");
    if (drawer) { drawer.classList.remove("sd-open"); drawer.classList.add("sd-closed"); }
    document.body.style.overflow = "";
    _openDrawerLinkId = null;
}

function _renderLibrary() {
    const body = document.getElementById("sd-body");
    if (!body || !_openDrawerLinkId) return;
    const allItems    = _streamCache[_openDrawerLinkId] || [];
    const movies      = allItems.filter(i => i.type !== "series");
    const series      = allItems.filter(i => i.type === "series");
    const totalMovies = movies.length;
    const watchedMov  = movies.filter(m => m.watched).length;
    const totalEps    = series.reduce((a, s) => a + (s.seasons || []).reduce((b, se) => b + (se.eps || 0), 0), 0);
    const watchedEps  = series.reduce((a, s) => a + (s.seasons || []).reduce((b, se) => b + (se.watched?.length || 0), 0), 0);

    const statsEl = document.getElementById("sd-stats");
    if (statsEl) {
        const parts = [];
        if (totalMovies) parts.push(`${watchedMov}/${totalMovies} movie${totalMovies !== 1 ? "s" : ""}`);
        if (series.length) parts.push(`${watchedEps}/${totalEps} ep${totalEps !== 1 ? "s" : ""}`);
        statsEl.textContent = parts.join(" · ");
    }
    const progFill = document.getElementById("sd-progress-fill");
    if (progFill) {
        const total = totalMovies + totalEps;
        const done  = watchedMov + watchedEps;
        progFill.style.width = total ? `${Math.round(done / total * 100)}%` : "0%";
    }

    if (!allItems.length) {
        body.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">video_library</span><p>No movies or series added yet.</p></div>`;
        return;
    }

    let filtered = allItems;
    if (_sdActiveTab === "movie")  filtered = movies;
    if (_sdActiveTab === "series") filtered = series;

    const canDrag = _sdActiveTab === "all";
    const units   = _buildUnits(filtered);

    if (!units.length) {
        const label = _sdActiveTab === "movie" ? "movies" : "series";
        body.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">${_sdActiveTab === "movie" ? "movie" : "tv"}</span><p>No ${label} tracked yet.</p></div>`;
        return;
    }

    body.innerHTML = `<div class="sd-unified-grid" id="sd-unified-grid">${
        units.map(u => u.type === "solo"
            ? _sdCardHtml(u.item, canDrag)
            : _sdCollBlockHtml(u, canDrag)
        ).join("")
    }</div>`;

    if (canDrag) _attachSdDrag(body.querySelector("#sd-unified-grid"));
}

async function _onLibraryBodyClick(e) {
    // Rename collection
    const renameCollBtn = e.target.closest("[data-rename-coll]");
    if (renameCollBtn) { _openCollRename(renameCollBtn.dataset.renameColl); return; }

    // Edit item
    const editBtn = e.target.closest("[data-edit-item]");
    if (editBtn) { _openItemEdit(editBtn.dataset.editItem); return; }

    // Toggle collection expand/collapse
    const collToggle = e.target.closest("[data-coll-toggle]");
    if (collToggle) {
        const name = collToggle.dataset.collToggle;
        if (_collapsedColls.has(name)) _collapsedColls.delete(name);
        else _collapsedColls.add(name);
        _renderLibrary();
        return;
    }

    // Toggle watched (movie)
    const toggleWatched = e.target.closest("[data-toggle-watched]");
    if (toggleWatched) {
        const itemId = toggleWatched.dataset.sdItemId;
        const item   = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
        if (!item) return;
        item.watched = !item.watched;
        try {
            await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { watched: item.watched });
            _renderLibrary();
        } catch (err) { console.error(err); item.watched = !item.watched; }
        return;
    }

    // Toggle single episode
    const epBtn = e.target.closest(".sd-ep");
    if (epBtn) {
        const itemId = epBtn.dataset.sdItemId;
        const si     = parseInt(epBtn.dataset.seasonIdx, 10);
        const ep     = parseInt(epBtn.dataset.epN, 10);
        const item   = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
        if (!item || !item.seasons?.[si]) return;
        const watched = [...(item.seasons[si].watched || [])];
        const idx = watched.indexOf(ep);
        if (idx === -1) watched.push(ep); else watched.splice(idx, 1);
        item.seasons[si].watched = watched;
        try {
            await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
            _renderLibrary();
        } catch (err) { console.error(err); }
        return;
    }

    // Toggle season (all eps in one season)
    const seasonToggle = e.target.closest("[data-toggle-season]");
    if (seasonToggle) {
        const itemId = seasonToggle.dataset.sdItemId;
        const si     = parseInt(seasonToggle.dataset.seasonIdx, 10);
        const item   = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
        if (!item || !item.seasons?.[si]) return;
        const se      = item.seasons[si];
        const allDone = (se.watched || []).length === se.eps;
        se.watched    = allDone ? [] : Array.from({ length: se.eps }, (_, i) => i + 1);
        try {
            await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
            _renderLibrary();
        } catch (err) { console.error(err); }
        return;
    }

    // Toggle show (all seasons)
    const showToggle = e.target.closest("[data-toggle-show]");
    if (showToggle) {
        const itemId = showToggle.dataset.sdItemId;
        const item   = (_streamCache[_openDrawerLinkId] || []).find(i => i.id === itemId);
        if (!item) return;
        const tot     = (item.seasons || []).reduce((a, se) => a + (se.eps || 0), 0);
        const done    = (item.seasons || []).reduce((a, se) => a + (se.watched?.length || 0), 0);
        const allDone = tot > 0 && done === tot;
        item.seasons  = (item.seasons || []).map(se => ({
            ...se, watched: allDone ? [] : Array.from({ length: se.eps }, (_, i) => i + 1),
        }));
        try {
            await updateDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
            _renderLibrary();
        } catch (err) { console.error(err); }
        return;
    }

    // Expand/collapse series seasons
    const expandToggle = e.target.closest("[data-toggle-expand]");
    if (expandToggle) {
        const itemId = expandToggle.dataset.toggleExpand;
        if (_sdExpandedIds.has(itemId)) _sdExpandedIds.delete(itemId);
        else _sdExpandedIds.add(itemId);
        _renderLibrary();
        return;
    }

    // Delete item
    const delBtn = e.target.closest("[data-delete-item]");
    if (delBtn) {
        const itemId = delBtn.dataset.deleteItem;
        const items  = _streamCache[_openDrawerLinkId] || [];
        const item   = items.find(i => i.id === itemId);
        if (!await confirm(`Remove "${item?.title || "this item"}"?`)) return;
        try {
            await deleteDoc(doc(_db, "users", _user.uid, "gallery-links", _openDrawerLinkId, "streaming-items", itemId));
            _streamCache[_openDrawerLinkId] = items.filter(i => i.id !== itemId);
            _sdExpandedIds.delete(itemId);
            _renderLibrary();
        } catch (err) { console.error(err); toast("Error removing item", "error"); }
    }
}

/* ══════════ I'M FEELING LUCKY ══════════ */

function _getNextEpisode(item) {
    for (const se of (item.seasons || [])) {
        for (let ep = 1; ep <= se.eps; ep++) {
            if (!(se.watched || []).includes(ep)) {
                return { season: se.s, episode: ep };
            }
        }
    }
    return null;
}

async function _fetchLuckyTmdbDetails(item, nextEp) {
    const key = _getTmdbKey();
    if (!key || !item.title) return {};
    const kind = item.type === "series" ? "tv" : "movie";
    try {
        // Try to extract TMDB ID from the item's url
        let tmdbId = null;
        if (item.url) {
            const m = item.url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
            if (m) tmdbId = parseInt(m[2], 10);
        }
        // Search if no ID from URL
        if (!tmdbId) {
            const searchRes = await fetch(
                `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(item.title)}&language=en-US&page=1`
            );
            if (!searchRes.ok) return {};
            const searchData = await searchRes.json();
            const hit = (searchData.results || [])[0];
            if (!hit) return {};
            tmdbId = hit.id;
        }
        if (kind === "movie") {
            const res = await fetch(
                `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${encodeURIComponent(key)}&language=en-US`
            );
            if (!res.ok) return {};
            const data = await res.json();
            return {
                overview:  data.overview || "",
                posterUrl: data.poster_path ? `https://image.tmdb.org/t/p/w300${data.poster_path}` : null,
            };
        }
        // Series — fetch episode details
        if (nextEp) {
            const epRes = await fetch(
                `https://api.themoviedb.org/3/tv/${tmdbId}/season/${nextEp.season}/episode/${nextEp.episode}?api_key=${encodeURIComponent(key)}&language=en-US`
            );
            const showRes = await fetch(
                `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(key)}&language=en-US`
            );
            const showData = showRes.ok ? await showRes.json() : {};
            const posterUrl = showData.poster_path ? `https://image.tmdb.org/t/p/w300${showData.poster_path}` : null;
            if (epRes.ok) {
                const epData = await epRes.json();
                return {
                    overview:     epData.overview || showData.overview || "",
                    episodeName:  epData.name || "",
                    stillUrl:     epData.still_path ? `https://image.tmdb.org/t/p/w300${epData.still_path}` : null,
                    posterUrl,
                    airDate:      epData.air_date || null,
                };
            }
            return { overview: showData.overview || "", posterUrl, airDate: null };
        }
        const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(key)}&language=en-US`);
        const showData = showRes.ok ? await showRes.json() : {};
        return {
            overview: showData.overview || "",
            posterUrl: showData.poster_path ? `https://image.tmdb.org/t/p/w300${showData.poster_path}` : null,
        };
    } catch { return {}; }
}

let _luckyServices = null;
let _luckyFullPool = [];   // original pool for infinite cycling
let _luckyShownIds = new Set(); // IDs shown this cycle

async function _showLuckyPick(services) {
    _luckyServices = services;
    _luckyShownIds = new Set(); // fresh cycle on each button press

    // Ensure all items are loaded
    await Promise.all(services.map(l => _loadStreamItems(l.id)));
    const allItems = _buildHubItems(services);

    // Candidates: unwatched movies + series with remaining episodes
    const candidates = allItems.filter(item =>
        item.type === "series" ? _getNextEpisode(item) !== null : !item.watched
    );
    _luckyFullPool = candidates.length ? candidates : allItems;
    if (!_luckyFullPool.length) { toast("No movies or shows tracked yet!", "error"); return; }

    _pickAndShowLucky(_luckyFullPool, allItems, services);
}

async function _pickAndShowLucky(fullPool, allItems, services) {
    _ensureLuckyModal();

    // Build unseen pool; reset cycle when all have been shown
    let unseen = fullPool.filter(i => !_luckyShownIds.has(i.id));
    if (!unseen.length) {
        _luckyShownIds = new Set();
        unseen = [...fullPool];
    }

    // Shuffle unseen for random order
    const shuffled = [...unseen].sort(() => Math.random() - 0.5);
    const today    = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    // Show loading state using the first candidate as preview
    const firstItem   = shuffled[0];
    const firstNextEp = firstItem.type === "series" ? _getNextEpisode(firstItem) : null;
    const firstSvc    = services.find(s => s.id === firstItem._serviceId);
    _setLuckyLoading(true, firstItem, firstNextEp, firstSvc ? _serviceLabel(firstSvc) : "");

    // Iterate through shuffled pool looking for an already-aired pick
    for (const item of shuffled) {
        const nextEp   = item.type === "series" ? _getNextEpisode(item) : null;
        const svc      = services.find(s => s.id === item._serviceId);
        const svcLabel = svc ? _serviceLabel(svc) : "";
        const details  = await _fetchLuckyTmdbDetails(item, nextEp);

        // Skip unaired next episodes
        if (nextEp && details.airDate && details.airDate > today) continue;

        _luckyShownIds.add(item.id);
        _setLuckyContent(item, nextEp, svcLabel, details, fullPool, allItems, services);
        return;
    }

    // All candidates had unaired next episodes — show the first one with a badge
    const fallbackItem    = shuffled[0];
    const fallbackNextEp  = fallbackItem.type === "series" ? _getNextEpisode(fallbackItem) : null;
    const fallbackSvc     = services.find(s => s.id === fallbackItem._serviceId);
    const fallbackLabel   = fallbackSvc ? _serviceLabel(fallbackSvc) : "";
    const fallbackDetails = await _fetchLuckyTmdbDetails(fallbackItem, fallbackNextEp);
    _luckyShownIds.add(fallbackItem.id);
    _setLuckyContent(fallbackItem, fallbackNextEp, fallbackLabel, { ...fallbackDetails, allUnaired: true }, fullPool, allItems, services);
}

function _ensureLuckyModal() {
    if (document.getElementById("sh-lucky-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "sh-lucky-overlay";
    overlay.className = "sh-lucky-overlay";
    overlay.innerHTML = `
        <div class="sh-lucky-modal" role="dialog" aria-modal="true" aria-label="I'm Feeling Lucky">
            <button class="sh-lucky-close" id="sh-lucky-close" title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="sh-lucky-header">
                <span class="material-symbols-outlined sh-lucky-dice-icon">casino</span>
                <span class="sh-lucky-header-text">I&#8217;m Feeling Lucky</span>
            </div>
            <div class="sh-lucky-body" id="sh-lucky-body">
                <div class="sh-lucky-spinner"><span class="material-symbols-outlined sh-lucky-spin-icon">autorenew</span></div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) _closeLuckyModal(); });
    document.getElementById("sh-lucky-close").addEventListener("click", _closeLuckyModal);
    document.addEventListener("keydown", _luckyKeyClose);
}

function _luckyKeyClose(e) {
    if (e.key === "Escape") _closeLuckyModal();
}

function _closeLuckyModal() {
    const ov = document.getElementById("sh-lucky-overlay");
    if (ov) { ov.classList.remove("sh-lucky-visible"); }
    document.removeEventListener("keydown", _luckyKeyClose);
}

function _setLuckyLoading(loading, item, nextEp, svcLabel) {
    const ov = document.getElementById("sh-lucky-overlay");
    if (!ov) return;
    if (loading) {
        const isSeries = item.type === "series";
        const title = item.title || "";
        const epLabel = nextEp
            ? `S${nextEp.season}E${nextEp.episode}`
            : isSeries ? "Series" : "Movie";
        document.getElementById("sh-lucky-body").innerHTML = `
            <div class="sh-lucky-card sh-lucky-loading-state">
                <div class="sh-lucky-poster-wrap">
                    ${item.posterUrl && _isSafeUrl(item.posterUrl)
                        ? `<img class="sh-lucky-poster-img" src="${escHtml(item.posterUrl)}" alt="">`
                        : `<div class="sh-lucky-poster-blank"><span class="material-symbols-outlined">${isSeries ? "tv" : "movie"}</span></div>`}
                </div>
                <div class="sh-lucky-info">
                    <div class="sh-lucky-type-badge">${isSeries ? "Series" : "Movie"}</div>
                    <div class="sh-lucky-title">${escHtml(title)}</div>
                    ${nextEp ? `<div class="sh-lucky-ep-label">Next up: ${escHtml(epLabel)}</div>` : ""}
                    <div class="sh-lucky-desc sh-lucky-desc--loading">
                        <span class="material-symbols-outlined sh-lucky-spin-icon">autorenew</span>
                        Fetching details&#8230;
                    </div>
                    ${svcLabel ? `<div class="sh-lucky-svc">${escHtml(svcLabel)}</div>` : ""}
                </div>
            </div>`;
        ov.classList.add("sh-lucky-visible");
    }
}

function _setLuckyContent(item, nextEp, svcLabel, details, pool, allItems, services) {
    const body = document.getElementById("sh-lucky-body");
    if (!body) return;
    const isSeries   = item.type === "series";
    const rawUrl     = item.url && _isSafeUrl(item.url) ? item.url : null;
    const safeUrl    = rawUrl ? escHtml(rawUrl) : null;
    const title      = item.title || "";
    const epLabel    = nextEp ? `S${nextEp.season}E${nextEp.episode}` : "";
    const epName     = details.episodeName || "";
    const overview   = details.overview || "";
    const posterSrc  = details.stillUrl || details.posterUrl || (item.posterUrl && _isSafeUrl(item.posterUrl) ? item.posterUrl : null);

    body.innerHTML = `
        <div class="sh-lucky-card">
            <div class="sh-lucky-poster-wrap">
                ${posterSrc
                    ? `<img class="sh-lucky-poster-img" src="${escHtml(posterSrc)}" alt="">`
                    : `<div class="sh-lucky-poster-blank"><span class="material-symbols-outlined">${isSeries ? "tv" : "movie"}</span></div>`}
            </div>
            <div class="sh-lucky-info">
                <div class="sh-lucky-type-badge">${isSeries ? "Series" : "Movie"}</div>
                <div class="sh-lucky-title">${escHtml(title)}</div>
                ${epLabel ? `<div class="sh-lucky-ep-label">Next up: <strong>${escHtml(epLabel)}</strong>${epName ? ` &mdash; ${escHtml(epName)}` : ""}</div>` : ""}
                ${overview
                    ? `<p class="sh-lucky-desc">${escHtml(overview)}</p>`
                    : `<p class="sh-lucky-desc sh-lucky-desc--empty">No description available.</p>`}
                ${svcLabel ? `<div class="sh-lucky-svc">${escHtml(svcLabel)}</div>` : ""}
                <div class="sh-lucky-actions">
                    ${details.allUnaired
                        ? `<span class="sh-lucky-unaired-badge"><span class="material-symbols-outlined">schedule</span>Not aired yet</span>`
                        : safeUrl
                            ? `<a class="sh-lucky-watch-btn" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
                                <span class="material-symbols-outlined">play_arrow</span>Watch Now
                               </a>`
                            : `<span class="sh-lucky-watch-btn sh-lucky-watch-btn--disabled">
                                <span class="material-symbols-outlined">link_off</span>No link
                               </span>`}
                    <button class="sh-lucky-retry-btn" id="sh-lucky-retry">
                        <span class="material-symbols-outlined">casino</span>Try Another
                    </button>
                </div>
            </div>
        </div>`;

    document.getElementById("sh-lucky-retry")?.addEventListener("click", () => {
        _pickAndShowLucky(_luckyFullPool, allItems, services);
    });
}
