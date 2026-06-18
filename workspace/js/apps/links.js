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
    collection, getDocs, setDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { refs }                from "../db.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml }    from "../ui.js";
import { materialIcons }       from "../icons.js";
import { isGalleryFeatureEnabled } from "../features.js";

/* Shorthand: is a Link-Gallery sub-feature enabled for the current user? */
const _gf = (key) => isGalleryFeatureEnabled(key);

/* ══════════ CONSTANTS ══════════ */

const TYPES = {
    "website":            { label: "Website",          icon: "public" },
    "youtube-channel":    { label: "YT Channel",        icon: "live_tv" },
    "youtube-playlist":   { label: "YT Playlist",       icon: "playlist_play" },
    "youtube-video":      { label: "YT Video",          icon: "play_circle" },
    "streaming-service":  { label: "Streaming Service", icon: "smart_display" },
    "image":              { label: "Image",             icon: "image" },
    "image-group":        { label: "Image Group",       icon: "grid_on" },
    "3d-model":           { label: "3D Model",          icon: "view_in_ar" },
    "file":               { label: "File",              icon: "attach_file" },
    "video":              { label: "Video",             icon: "videocam" },
    "video-group":        { label: "Video Group",       icon: "video_library" },
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
let _settingsUnsub  = null;
let _adminOwnerUid  = null;  // when set, all reads/writes target this uid (admin browse mode)
let _serviceDomains = {}; // serviceName → override hostname (set by admin)

/** Returns the effective uid for all Firestore operations. */
function _uid() { return _adminOwnerUid || _user?.uid; }
let _links          = [];
let _search         = "";
let _activeCat      = "all";   // "all" | category name | "_uncat"
let _sortMode       = localStorage.getItem("links_sort_mode") || "newest";
let _editId         = null;
let _editCatId      = null;
let _dragId         = null;
let _layout         = localStorage.getItem("links_layout") || "grid"; // "grid" | "compact" | "list"
let _catPrefs       = (() => { try { return JSON.parse(localStorage.getItem("links_cat_prefs") || "{}"); } catch { return {}; } })();
let _showThumbs     = localStorage.getItem("links_show_thumbs") !== "0";
let _showDesc       = localStorage.getItem("links_show_desc") !== "0";
let _settingsLoaded = false;   // true after first Firestore settings snapshot

/* ── Drag auto-scroll state ── */
let _asRaf   = null;   // requestAnimationFrame handle
let _asSpeed = 0;      // px per frame (negative = up, positive = down)
let _asEl    = null;   // scrollable container being watched

function _asStart(scrollEl) { _asEl = scrollEl; }
function _asStop()  { _asEl = null; _asSpeed = 0; if (_asRaf) { cancelAnimationFrame(_asRaf); _asRaf = null; } }
function _asMove(clientY) {
    if (!_asEl) return;
    const r = _asEl.getBoundingClientRect(), zone = 80;
    const rel = clientY - r.top;
    if      (rel < zone)           _asSpeed = -(1 - rel / zone) * 18;
    else if (rel > r.height - zone) _asSpeed =  (1 - (r.height - rel) / zone) * 18;
    else                            _asSpeed = 0;
    if (_asSpeed && !_asRaf) _asRaf = requestAnimationFrame(_asFrame);
}
function _asFrame() {
    _asRaf = null;
    if (!_asEl || !_asSpeed) return;
    _asEl.scrollTop += _asSpeed;
    _asRaf = requestAnimationFrame(_asFrame);
}
const _mediaThumbs = {}; // url → imgUrl | null  (undefined = not yet tried)

// Fullscreen viewer state
let _mghViewItems = [];
let _mghViewCur   = 0;

// Coverflow ("stage") view — active keyboard handler & autoplay timer so we
// never leak/duplicate them across re-renders.
let _mghCfKeyHandler = null;
let _mghCfAutoTimer  = null;

// Avatar crop state
let _acmCx   = 50;   // x-center 0–100
let _acmCy   = 50;   // y-center 0–100
let _acmZoom = 1;    // scale 1–4
let _acmInited = false;

/* ── Bulk select state ── */
let _selectMode  = false;
let _selectedIds = new Set();

// Box-select drag state
let _boxDrag = false;
let _boxStartX = 0, _boxStartY = 0;
let _boxEl = null;

let _cats = [];   // [{ id, name, icon }]
const _CATS_KEY = () => `linksCats_${_uid()}`;
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
    if (_settingsLoaded && _db && _user?.uid && !_adminOwnerUid) {
        setDoc(refs.linkSettings(_db, _uid()), { categories: _cats }, { merge: true })
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
            deleteDoc(doc(_db, "users", _uid(), "gallery-links", id))
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
    // Restore the last active category from the previous session
    try { const _sc = sessionStorage.getItem("links_active_cat"); if (_sc) _activeCat = _sc; } catch {}

    // Load admin-configured service domain overrides
    getDoc(refs.serviceConfig(db)).then(snap => {
        if (snap.exists() && snap.data().serviceDomains) {
            _serviceDomains = snap.data().serviceDomains;
        }
    }).catch(() => {});

    _loadCats();

    _startSubscriptions();

    document.getElementById("btn-links-select-mode")
        ?.addEventListener("click", () => _selectMode ? _exitSelectMode() : _enterSelectMode());

    const _linksBody = document.getElementById("links-body");
    if (_linksBody) _initBoxSelect(_linksBody);

    document.getElementById("btn-add-link")
        .addEventListener("click", () => {
            if (_activeCat === "all" && !_search) _openCatForm(null);
            else _openForm(null);
        });
    document.getElementById("btn-links-settings")
        ?.addEventListener("click", () => _openLinksSettings());

    // Sidebar collapse / mobile drawer toggle
    const _sbToggleBtn = document.getElementById("btn-links-sb-toggle");
    const _isLinksMobile = () => window.matchMedia("(max-width: 768px)").matches;
    const _closeLinksDrawer = () => {
        document.getElementById("app-links")?.classList.remove("links-sidebar-mobile-open");
    };
    if (_sbToggleBtn) {
        const _applyCollapse = (collapsed) => {
            document.getElementById("app-links")?.classList.toggle("links-sidebar-collapsed", collapsed);
            _sbToggleBtn.classList.toggle("rotated", collapsed);
            try { localStorage.setItem("links_sidebar_collapsed", collapsed ? "1" : ""); } catch {}
        };
        _sbToggleBtn.addEventListener("click", () => {
            const appLinks = document.getElementById("app-links");
            if (_isLinksMobile()) {
                // Mobile: toggle off-canvas drawer
                appLinks?.classList.toggle("links-sidebar-mobile-open");
            } else {
                // Desktop: collapse sidebar width
                _applyCollapse(!appLinks?.classList.contains("links-sidebar-collapsed"));
            }
        });
        if (localStorage.getItem("links_sidebar_collapsed") === "1") _applyCollapse(true);
    }
    // Overlay click closes the mobile drawer
    document.getElementById("links-cat-overlay")?.addEventListener("click", _closeLinksDrawer);
    document.getElementById("links-search")
        .addEventListener("input", e => { _search = e.target.value.toLowerCase(); _render(); });
    const _sortSel = document.getElementById("links-sort-select");
    if (_sortSel) {
        _sortSel.value = _sortMode;
        _sortSel.addEventListener("change", e => { _sortMode = e.target.value; _render(); });
    }

    document.getElementById("links-cat-select")
        ?.addEventListener("change", e => { _switchCat(e.target.value); });

    document.getElementById("links-cat-bar")
        .addEventListener("click", e => {
            const addBtn = e.target.closest("[data-cat-action='add-cat']");
            if (addBtn) { _openCatForm(null); return; }
            const catBtn = e.target.closest("[data-cat-name]");
            if (catBtn) { _switchCat(catBtn.dataset.catName); if (_isLinksMobile()) _closeLinksDrawer(); }
        });

    document.getElementById("links-body")
        .addEventListener("click", _onBodyClick);
    document.getElementById("form-add-link")
        .addEventListener("submit", _onFormSubmit);
    document.getElementById("link-url-field")
        .addEventListener("input", _autoDetectType);
    const batchField = document.getElementById("link-batch-field");
    batchField?.addEventListener("input", _updateBatchHint);
    batchField?.addEventListener("dragover", (e) => {
        e.preventDefault();
        batchField.classList.add("is-dragover");
    });
    batchField?.addEventListener("dragleave", () => {
        batchField.classList.remove("is-dragover");
    });
    batchField?.addEventListener("drop", (e) => {
        e.preventDefault();
        batchField.classList.remove("is-dragover");
        const dropped = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
        if (!dropped) return;
        batchField.value = [batchField.value.trim(), dropped.trim()].filter(Boolean).join("\n");
        _updateBatchHint();
    });
    document.getElementById("link-type-field")
        .addEventListener("change", e => _updateTypeHint(e.target.value));
    document.getElementById("link-title-field")
        .addEventListener("input", _mghOnNameInput);

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

    // Init avatar crop modal
    initAvatarCrop();

    // Inject video-group type option and form section
    _initImageGroupForm();
    _initVideoGroupForm();

    // Admin: restore own links when called from admin panel
    window.addEventListener("ws:restoreOwnLinks", () => setLinksAdminOwner(null));
}

/* ── Admin: switch the Link Gallery to show any user's links ── */

function _startSubscriptions() {
    if (_settingsUnsub) { _settingsUnsub(); _settingsUnsub = null; }
    if (_unsub)         { _unsub();         _unsub         = null; }

    _settingsUnsub = onSnapshot(refs.linkSettings(_db, _uid()), snap => {
        if (snap.exists()) {
            const d = snap.data();
            if (d?.dicebearStyle && DICEBEAR_STYLES.some(s => s.id === d.dicebearStyle)) {
                _dicebearStyle = d.dicebearStyle;
                try { localStorage.setItem("links_dicebear_style", _dicebearStyle); } catch {}
            }
            const remoteCats = d?.categories;
            if (Array.isArray(remoteCats) && remoteCats.length > 0) {
                _cats = remoteCats;
                try { localStorage.setItem(_CATS_KEY(), JSON.stringify(_cats)); } catch {}
            } else if (!_settingsLoaded && _cats.length > 0 && !_adminOwnerUid) {
                setDoc(refs.linkSettings(_db, _uid()), { categories: _cats }, { merge: true })
                    .catch(console.error);
            }
        } else if (!_settingsLoaded && _cats.length > 0 && !_adminOwnerUid) {
            setDoc(refs.linkSettings(_db, _uid()), { categories: _cats }, { merge: true })
                .catch(console.error);
        }
        _settingsLoaded = true;
        _render();
    }, err => console.error("[links] settings snapshot error:", err));

    const q = query(refs.galleryLinks(_db, _uid()), orderBy("createdAt", "desc"));
    _unsub = onSnapshot(q, snap => {
        _links = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _render();
    });
}

/**
 * Switch the Link Gallery to show another user's links (admin browse mode).
 * Pass null to restore the signed-in user's own links.
 */
export function setLinksAdminOwner(uid) {
    _adminOwnerUid = uid || null;
    _links         = [];
    _cats          = [];
    _settingsLoaded = false;
    _activeCat     = "all";
    _search        = "";
    _editId        = null;
    if (_selectMode) _exitSelectMode?.();
    _selectedIds?.clear?.();
    /* Reset search input */
    const searchEl = document.getElementById("links-search");
    if (searchEl) searchEl.value = "";
    _loadCats();
    _startSubscriptions();
}

/** Called by admin panel to apply service domain overrides without a page reload. */
export function setServiceDomains(domains) {
    _serviceDomains = domains && typeof domains === "object" ? { ...domains } : {};
}

/** Returns the known streaming services list (for admin panel display). */
export function getKnownServices() {
    return _KNOWN_STREAM_SERVICES.map(s => ({ ...s }));
}




/* ══════════ RENDER ══════════ */

/* Default display order when sort mode is "manual":
   websites → images → videos → other → characters → creators */
const TYPE_ORDER = {
    "website":           0,
    "youtube-channel":   1,
    "youtube-playlist":  1,
    "youtube-video":     1,
    "streaming-service": 2,
    "image":             3,
    "image-group":       3,
    "3d-model":          4,
    "video":             5,
    "video-group":       5,
    "file":              6,
    "other":             7,
    "person":            8,
    "creator":           9,
};

function _activeCatPref(key) {
    if (_activeCat === "all") return null;
    return _catPrefs[_activeCat]?.[key] ?? null;
}
function _activeLayout() { return _activeCatPref("layout") || _layout; }
function _activeSort()   { return _activeCatPref("sort")   || _sortMode; }
function _saveCatPrefs() { try { localStorage.setItem("links_cat_prefs", JSON.stringify(_catPrefs)); } catch {} }

function _sorted(list) {
    const arr = [...list];
    const sort = _activeSort();
    switch (sort) {
        case "a-z":    return arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        case "z-a":    return arr.sort((a, b) => (b.title || "").localeCompare(a.title || ""));
        case "newest": return arr.sort((a, b) => ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
        case "oldest": return arr.sort((a, b) => ((a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
        case "shuffle": return arr.sort(() => Math.random() - 0.5);
        default:
            return arr.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                const ta = TYPE_ORDER[a.type] ?? 7;
                const tb = TYPE_ORDER[b.type] ?? 7;
                if (ta !== tb) return ta - tb;
                /* Same type group: use manual sortOrder or creation time */
                const ap = a.sortOrder ?? a.createdAt?.seconds ?? 0;
                const bp = b.sortOrder ?? b.createdAt?.seconds ?? 0;
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

    // Mobile: sync the <select> dropdown
    const sel = document.getElementById("links-cat-select");
    if (sel) {
        sel.innerHTML = [
            `<option value="all"${_activeCat === "all" ? " selected" : ""}>All</option>`,
            ..._cats.map(c => `<option value="${escHtml(c.name)}"${_activeCat === c.name ? " selected" : ""}>${escHtml(c.name)}</option>`),
            ...(hasUncat ? [`<option value="_uncat"${_activeCat === "_uncat" ? " selected" : ""}>Uncategorised</option>`] : [])
        ].join("");
    }
}

/* Switch to a category, showing the confirm screen if it's personal and not yet unlocked */
function _switchCat(name) {
    const catObj = _cats.find(c => c.name === name);
    if (catObj?.locked && !_unlockedCats.has(catObj.id)) {
        _showConfirmScreen(catObj);
        return;
    }
    _activeCat = name;
    try { sessionStorage.setItem("links_active_cat", name); } catch {}
    _render();
}

/* ── Category lock helpers ── */
const _unlockedCats = new Set(); // in-memory; cleared on page reload

async function _showConfirmScreen(cat) {
    const body = document.getElementById("links-body");
    if (!body) return;
    const _doOpen = () => { _unlockedCats.add(cat.id); _activeCat = cat.name; try { sessionStorage.setItem("links_active_cat", cat.name); } catch {} _render(); };
    body.innerHTML = `
        <div class="link-lockscreen">
            <div class="link-ls-folder-icon">
                <span class="material-symbols-outlined">${escHtml(cat.icon || "folder")}</span>
            </div>
            <div class="link-ls-name">${escHtml(cat.name)}</div>
            <div class="link-ls-sub">This is a personal folder</div>
            <div class="link-ls-actions">
                <button class="ws-btn ws-btn-accent" id="ls-open-btn">Open folder</button>
                <button class="ws-btn ws-btn-ghost" id="ls-back-btn">Go back</button>
            </div>
        </div>`;
    body.querySelector("#ls-open-btn").addEventListener("click", _doOpen);
    body.querySelector("#ls-back-btn").addEventListener("click", () => { _activeCat = null; _render(); });
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

/* Canonical play-button SVG — used everywhere so they all look identical */
function _playSvg(size = 44) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="rgba(0,0,0,0.55)"/><path d="M13.5 10l9 6-9 6V10z" fill="white"/></svg>`;
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

function _resolveSafeUrl(baseUrl, maybeUrl) {
    const raw = String(maybeUrl || "").trim();
    if (!raw) return "";
    try {
        const resolved = new URL(raw, baseUrl).toString();
        return _isSafeUrl(resolved) ? resolved : "";
    } catch {
        return "";
    }
}

async function _fetchHtmlThroughProxy(url, timeoutMs = 8000) {
    const loaders = [
        async () => {
            const res = await fetch(
                `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
                { signal: AbortSignal.timeout(timeoutMs) }
            );
            if (!res.ok) return "";
            return await res.text();
        },
        async () => {
            const res = await fetch(
                `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
                { signal: AbortSignal.timeout(timeoutMs) }
            );
            if (!res.ok) return "";
            const json = await res.json().catch(() => null);
            return json?.contents || "";
        },
    ];

    for (const load of loaders) {
        try {
            const html = String(await load() || "").trim();
            if (html) return html;
        } catch {
            // Try the next proxy.
        }
    }

    return "";
}

function _extractUrlsFromText(raw) {
    const matches = String(raw || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    return [...new Set(matches.map(url => url.replace(/[),.;!?]+$/, "")))];
}

function _updateBatchHint() {
    const field = document.getElementById("link-batch-field");
    const hint = document.getElementById("link-batch-hint");
    if (!field || !hint) return;
    const count = _extractUrlsFromText(field.value).length;
    hint.textContent = count
        ? `${count} URL${count === 1 ? "" : "s"} ready to import.`
        : "Drop text, link selections, or paste many URLs at once.";
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
            <button class="sh-pill sh-pill-add" id="sh-add-service-btn" title="Add a streaming service">
                <span class="material-symbols-outlined" style="font-size:1rem">add</span>
                <span class="sh-pill-name">Add Service</span>
            </button>
        </div>
        <div class="sh-tab-bar" id="sh-tab-bar">
            <button class="sh-tab${_shActiveTab==="all"?" sh-tab-active":""}" data-sh-tab="all">All</button>
            <button class="sh-tab${_shActiveTab==="movie"?" sh-tab-active":""}" data-sh-tab="movie">Movies</button>
            <button class="sh-tab${_shActiveTab==="series"?" sh-tab-active":""}" data-sh-tab="series">Series</button>
            <button class="sh-add-item-btn" id="sh-add-item-btn" title="Add a movie or show to a service">
                <span class="material-symbols-outlined">add</span>
            </button>
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
                await deleteDoc(doc(_db, "users", _uid(), "gallery-links", linkId));
                delete _streamCache[linkId];
            } catch (err) { console.error(err); toast("Error removing service", "error"); }
            return;
        }
        const pill = e.target.closest("[data-sh-link-id]");
        if (pill) { _openLibrary(pill.dataset.shLinkId); return; }
        if (e.target.closest("#sh-add-service-btn")) {
            _openServicePicker(cat);
            return;
        }
    });

    hub.querySelector("#sh-tab-bar").addEventListener("click", e => {
        if (e.target.closest("#sh-lucky-btn")) { _showLuckyPick(services); return; }
        if (e.target.closest("#sh-add-item-btn")) { _openHubItemForm(services); return; }
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
                await updateDoc(doc(_db, "users", _uid(), "gallery-links", svcId, "streaming-items", itemId), { watched: item.watched });
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
const _CORP_VIDEO_HOSTS = new Set([]);

function _mghEmbed(url) {
    if (!url) return null;
    try { if (_CORP_VIDEO_HOSTS.has(new URL(url).hostname)) return null; } catch {}
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i.test(url)) return { type: "direct", src: url };
    try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, "");
        // Any YouTube host (youtube.com, m./music./gaming.youtube.com, youtube-nocookie.com)
        if (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtube-nocookie.com") {
            if (u.searchParams.has("v")) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${u.searchParams.get("v")}` };
            const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
            if (m) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${m[2]}` };
            // Playlist URL (no single video) → embed the playlist
            const list = u.searchParams.get("list");
            if (list) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}` };
        }
        if (h === "youtu.be") {
            const id = u.pathname.slice(1).split("/")[0];
            if (id) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` };
        }
        if (h === "vimeo.com" || h === "player.vimeo.com") {
            const id = u.pathname.split("/").filter(Boolean).find(seg => /^\d+$/.test(seg));
            if (id) return { type: "vimeo", src: `https://player.vimeo.com/video/${id}` };
        }
        if (h === "dailymotion.com") {
            const id = u.pathname.match(/\/video\/([^/?#_]+)/)?.[1];
            if (id) return { type: "iframe", src: `https://www.dailymotion.com/embed/video/${id}` };
        }
        if (h === "dai.ly") {
            const id = u.pathname.slice(1).split("/")[0];
            if (id) return { type: "iframe", src: `https://www.dailymotion.com/embed/video/${id}` };
        }
        if (h === "streamable.com") {
            const id = u.pathname.replace(/^\/(e\/)?/, "").split("/")[0];
            if (id) return { type: "iframe", src: `https://streamable.com/e/${id}` };
        }
        // Pornhub embed URL — use as iframe src directly (no autoplay param added)
        if (h === "pornhub.com" && u.pathname.includes("/embed/")) return { type: "iframe", src: url };
    } catch { /* noop */ }
    return null;
}

/* ── Platform badge (with peer-lookup) ── */
function _mghPlatBadge(link) {
    let lbl = link.badgeLabel || "";
    let col = link.badgeColor || "";
    const linkUrl = link.url || link.profileUrl || "";
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
    if (!link || (link.type !== "image" && link.type !== "image-group" &&
                  link.type !== "3d-model" && link.type !== "youtube-video" &&
                  link.type !== "youtube-playlist" && link.type !== "video" &&
                  link.type !== "video-group")) return null;
    if (link.creatorId) return _links.find(l => l.id === link.creatorId) ?? null;
    const _matchUrl = (testUrl) => {
        if (!testUrl) return null;
        for (const c of _links.filter(l => l.type === "creator" || l.type === "youtube-channel")) {
            if (!c.url && !c.profileUrl) continue;
            const _cUrl = c.url || c.profileUrl;
            try {
                const cu = new URL(_cUrl); const mu = new URL(testUrl);
                if (cu.hostname === mu.hostname) {
                    const cp = cu.pathname.replace(/\/$/, ""); const mp = mu.pathname.replace(/\/$/, "");
                    if (cp && (mp === cp || mp.startsWith(cp + "/"))) return c;
                }
            } catch { /* noop */ }
        }
        return null;
    };
    return _matchUrl(link.url) ?? _matchUrl(link.sourceUrl) ?? null;
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
/* ── DiceBear glyph fallback — deterministic per username seed ── */
let _dicebearStyle = localStorage.getItem("links_dicebear_style") || "glyphs";
const DICEBEAR_STYLES = [
    { id: "glyphs",     label: "Glyphs"      },
    { id: "bottts",     label: "Robots"      },
    { id: "pixel-art",  label: "Pixel Art"   },
    { id: "fun-emoji",  label: "Emoji"       },
    { id: "lorelei",    label: "Lorelei"     },
    { id: "micah",      label: "Micah"       },
    { id: "thumbs",     label: "Thumbs"      },
    { id: "identicon",  label: "Identicon"   },
    { id: "shapes",     label: "Shapes"      },
];
function _mghDiceBearUrl(seed) {
    return `https://api.dicebear.com/10.x/${_dicebearStyle}/svg?seed=${encodeURIComponent(seed || "anon")}`;
}

/* Session-level in-memory cache — avoids re-fetching the same creator within one page load */
const _mghProfileCache   = new Map(); // key → thumbUrl
const _mghDicebearCleaned = new Set(); // link IDs whose DiceBear thumbUrl has been cleared this session

function _mghProfileKey(platform, username) {
    return `${platform || "other"}_${(username || "anon").toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`;
}

/**
 * Fetch a creator's avatar. Results are cached in memory for the session only — nothing
 * is written to the database.
 *
 * Priority: YouTube oEmbed → GitHub → Twitch DecAPI → og:image via proxy → DiceBear glyph
 */
async function _mghCreatorAvatar(platform, username, fullUrl = "") {
    const key = _mghProfileKey(platform, username || fullUrl);

    /* Session cache — free re-use within the same page load */
    if (_mghProfileCache.has(key)) return _mghProfileCache.get(key);

    let thumbUrl = "";
    try {
        if (platform === "youtube") {
            const chUrl = fullUrl || `https://www.youtube.com/@${encodeURIComponent(username)}`;
            const resp = await Promise.race([
                fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(chUrl)}&format=json`),
                new Promise((_, rj) => setTimeout(rj, 4000)),
            ]);
            if (resp.ok) { const d = await resp.json(); if (d.thumbnail_url) thumbUrl = d.thumbnail_url; }
        }
        if (!thumbUrl && platform === "github") {
            thumbUrl = `https://github.com/${encodeURIComponent(username)}.png?size=100`;
        }
        if (!thumbUrl && platform === "twitch") {
            const resp = await Promise.race([
                fetch(`https://decapi.me/twitch/avatar/${encodeURIComponent(username)}`),
                new Promise((_, rj) => setTimeout(rj, 4000)),
            ]);
            if (resp.ok) { const t = (await resp.text()).trim(); if (t.startsWith("http")) thumbUrl = t; }
        }
        if (!thumbUrl && fullUrl) {
            const html = await _fetchHtmlThroughProxy(fullUrl, 5000);
            if (html) {
                const m =
                    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
                    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
                if (m?.[1]?.startsWith("http")) thumbUrl = m[1];
            }
        }
    } catch {}

    // Don't store DiceBear in cache or Firestore — it's display-only
    _mghProfileCache.set(key, thumbUrl);
    return thumbUrl;
}

/** Background-refresh a creator card rendered with a stale/broken avatar.
 *  Fetches the avatar (or returns from session cache) and patches the card in place. */
async function _mghRefreshAvatarBackground(link, cardEl, parsed) {
    const realThumb = await _mghCreatorAvatar(
        parsed.platform, parsed.username, link.url || link.profileUrl || ""
    );
    if (!cardEl.isConnected) return;

    // Display: real URL if found, otherwise DiceBear as display-only fallback
    const displaySrc = realThumb || _mghDiceBearUrl(link.title || link.username || link.id || "anon");

    const clip  = cardEl.querySelector(".creator-avatar-clip");
    const fb    = cardEl.querySelector(".creator-avatar-fallback");
    const imgEl = clip?.querySelector(".creator-avatar");
    if (clip && imgEl) {
        imgEl.src = displaySrc; clip.style.display = "";
        if (fb) fb.style.display = "none";
    } else {
        const newClip = document.createElement("div"); newClip.className = "creator-avatar-clip";
        newClip.innerHTML = `<img class="creator-avatar" src="${escHtml(displaySrc)}" alt="">`;
        if (fb) { cardEl.insertBefore(newClip, fb); fb.style.display = "none"; }
    }

    // Only persist to Firestore if we found a real URL — never store DiceBear
    if (realThumb && _db && _uid?.() && !_adminOwnerUid && link.id) {
        updateDoc(doc(_db, "users", _uid(), "gallery-links", link.id), { thumbUrl: realThumb })
            .catch(() => {});
    }
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

/* ══════════ SortableJS per-item ordering (media-hub grids) ══════════ */

let _Sortable = null;
async function _getSortable() {
    if (_Sortable) return _Sortable;
    const mod = await import("https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/modular/sortable.esm.js");
    _Sortable = mod.Sortable;
    return _Sortable;
}

/* Make a media-hub section grid drag-sortable. Persists `sortOrder` per item
   to gallery-links. Only active under manual sort. */
async function _mghMakeSortable(grid) {
    const Sortable = await _getSortable();
    Sortable.create(grid, {
        animation:   150,
        draggable:   "[data-id]",
        filter:      "button, a, input, textarea, select, .sd-movie-poster, .sd-movie-poster *, .sd-card-footer, .sd-watched-toggle, .sd-expand-toggle, .sd-toggle-show, .sd-ep, .sd-s-label, .sd-coll-toggle, .sd-coll-stack-btn",
        ghostClass:  "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd: () => {
            const ids = [...grid.querySelectorAll("[data-id]")].map(el => el.dataset.id);
            if (!ids.length || !_db || !_uid?.()) return;
            const batch = writeBatch(_db);
            ids.forEach((id, i) => {
                const link = _links.find(l => l.id === id);
                if (link) link.sortOrder = i;        // keep local cache in sync
                batch.update(doc(_db, "users", _uid(), "gallery-links", id), { sortOrder: i });
            });
            batch.commit().catch(err => { console.error("[links] reorder error:", err); toast("Could not save new order.", "error"); });
        }
    });
}

/* ══════════ AVATAR CROP MODAL ══════════ */

export function initAvatarCrop() {
    if (_acmInited) return;
    _acmInited = true;

    const thumbField  = document.getElementById("link-thumb-field");
    const cropBtn     = document.getElementById("btn-crop-avatar");
    const prevDiv     = document.getElementById("link-thumb-preview");
    const prevCircle  = document.getElementById("link-thumb-preview-circle");
    const prevImg     = document.getElementById("link-thumb-preview-img");
    const modal       = document.getElementById("avatar-crop-modal");
    const acmCircle   = document.getElementById("acm-circle");
    const acmImg      = document.getElementById("acm-img");
    const zSlider     = document.getElementById("acm-zoom");

    function _isAvatarType() {
        const t = document.getElementById("link-type-field")?.value;
        return t === "creator" || t === "person" || t === "youtube-channel";
    }

    function _updatePreview() {
        const url = thumbField?.value.trim();
        if (url && _isAvatarType()) {
            if (prevImg) { prevImg.src = url; _acmApplyCSS(prevCircle, _acmCx, _acmCy, _acmZoom); }
            if (prevDiv) prevDiv.style.display = "";
        } else {
            if (prevDiv) prevDiv.style.display = "none";
        }
    }

    // Update preview whenever URL changes (also resets crop to default)
    thumbField?.addEventListener("input", () => {
        _acmCx = 50; _acmCy = 50; _acmZoom = 1;
        if (zSlider) zSlider.value = 100;
        _updatePreview();
    });

    // Open modal
    cropBtn?.addEventListener("click", () => {
        const url = thumbField?.value.trim();
        if (!url) { toast("Paste an image URL first.", "info"); return; }
        if (!_isAvatarType()) return;
        _acmOpen(url);
    });

    // Modal: close / cancel
    document.getElementById("acm-close")?.addEventListener("click",  _acmClose);
    document.getElementById("acm-cancel")?.addEventListener("click", _acmClose);
    modal?.addEventListener("click", e => { if (e.target === modal) _acmClose(); });

    // Modal: reset
    document.getElementById("acm-reset")?.addEventListener("click", () => {
        _acmCx = 50; _acmCy = 50; _acmZoom = 1;
        if (zSlider) zSlider.value = 100;
        _acmLayout();
    });

    // Modal: apply
    document.getElementById("acm-apply")?.addEventListener("click", () => {
        _acmApplyCSS(prevCircle, _acmCx, _acmCy, _acmZoom);
        if (prevDiv) prevDiv.style.display = "";
        _acmClose();
    });

    // Zoom slider
    zSlider?.addEventListener("input", () => {
        _acmZoom = zSlider.value / 100;
        _acmClampAndLayout();
    });

    // Scroll-to-zoom on the circle
    acmCircle?.addEventListener("wheel", e => {
        e.preventDefault();
        _acmZoom = Math.max(1, Math.min(4, _acmZoom - e.deltaY * 0.004));
        if (zSlider) zSlider.value = Math.round(_acmZoom * 100);
        _acmClampAndLayout();
    }, { passive: false });

    // Mouse drag
    let dragging = false, lastMouseX = 0, lastMouseY = 0;
    acmCircle?.addEventListener("mousedown", e => {
        dragging = true; lastMouseX = e.clientX; lastMouseY = e.clientY;
        e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
        if (!dragging || !acmImg?.naturalWidth) return;
        _acmPan(e.clientX - lastMouseX, e.clientY - lastMouseY);
        lastMouseX = e.clientX; lastMouseY = e.clientY;
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    // Touch drag + pinch
    let lastTX = 0, lastTY = 0, lastPinchDist = 0;
    acmCircle?.addEventListener("touchstart", e => {
        if (e.touches.length === 1) { lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY; }
        if (e.touches.length === 2) {
            lastPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
        }
        e.preventDefault();
    }, { passive: false });
    acmCircle?.addEventListener("touchmove", e => {
        if (e.touches.length === 1 && acmImg?.naturalWidth) {
            _acmPan(e.touches[0].clientX - lastTX, e.touches[0].clientY - lastTY);
            lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
        }
        if (e.touches.length === 2) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (lastPinchDist) {
                _acmZoom = Math.max(1, Math.min(4, _acmZoom * (dist / lastPinchDist)));
                if (zSlider) zSlider.value = Math.round(_acmZoom * 100);
                _acmClampAndLayout();
            }
            lastPinchDist = dist;
        }
        e.preventDefault();
    }, { passive: false });

    function _acmOpen(url) {
        if (!acmImg) return;
        acmImg.onload = () => { _acmClampAndLayout(); };
        acmImg.src = url;
        if (zSlider) zSlider.value = Math.round(_acmZoom * 100);
        if (modal) modal.style.display = "flex";
    }

    function _acmClose() { if (modal) modal.style.display = "none"; }

    function _acmLayout() {
        if (!acmImg?.naturalWidth) return;
        const C = 220;
        const cs = Math.max(C / acmImg.naturalWidth, C / acmImg.naturalHeight);
        const rW = acmImg.naturalWidth  * cs * _acmZoom;
        const rH = acmImg.naturalHeight * cs * _acmZoom;
        acmImg.style.width  = rW + "px";
        acmImg.style.height = rH + "px";
        acmImg.style.left   = (C / 2 - (_acmCx / 100) * rW) + "px";
        acmImg.style.top    = (C / 2 - (_acmCy / 100) * rH) + "px";
    }

    function _acmClampAndLayout() {
        if (!acmImg?.naturalWidth) return;
        const C = 220;
        const cs = Math.max(C / acmImg.naturalWidth, C / acmImg.naturalHeight);
        const rW = acmImg.naturalWidth  * cs * _acmZoom;
        const rH = acmImg.naturalHeight * cs * _acmZoom;
        const minX = (C / 2 / rW) * 100, maxX = 100 - minX;
        const minY = (C / 2 / rH) * 100, maxY = 100 - minY;
        _acmCx = Math.max(minX, Math.min(maxX, _acmCx));
        _acmCy = Math.max(minY, Math.min(maxY, _acmCy));
        _acmLayout();
    }

    function _acmPan(dx, dy) {
        if (!acmImg?.naturalWidth) return;
        const C = 220;
        const cs = Math.max(C / acmImg.naturalWidth, C / acmImg.naturalHeight);
        const rW = acmImg.naturalWidth  * cs * _acmZoom;
        const rH = acmImg.naturalHeight * cs * _acmZoom;
        _acmCx -= (dx / rW) * 100;
        _acmCy -= (dy / rH) * 100;
        _acmClampAndLayout();
    }

    // expose open for external use
    window._acmOpen = _acmOpen;
    window._acmClose = _acmClose;
}

// Apply crop using the same pixel formula as the modal — works at any container size.
// containerSize: pixel width/height of the square clip circle (48 for cards, 52 for preview, 64 for panel).
function _acmApplyToClip(clipEl, cx, cy, zoom, containerSize) {
    if (!clipEl) return;
    const imgEl = clipEl.querySelector("img");
    if (!imgEl) return;
    const C = containerSize || 48;

    function layout() {
        const natW = imgEl.naturalWidth;
        const natH = imgEl.naturalHeight;
        if (!natW || !natH) return;
        const cs = Math.max(C / natW, C / natH);
        const rW = natW * cs * zoom;
        const rH = natH * cs * zoom;
        imgEl.style.position  = "absolute";
        imgEl.style.width     = rW + "px";
        imgEl.style.height    = rH + "px";
        imgEl.style.left      = (C / 2 - (cx / 100) * rW) + "px";
        imgEl.style.top       = (C / 2 - (cy / 100) * rH) + "px";
        imgEl.style.maxWidth  = "none";
        imgEl.style.maxHeight = "none";
        imgEl.style.objectFit = "unset";
    }

    if (imgEl.complete && imgEl.naturalWidth) {
        layout();
    } else {
        imgEl.addEventListener("load", layout, { once: true });
    }
}

// Legacy alias (used in a few places)
function _acmApplyCSS(containerEl, cx, cy, zoom) {
    const C = containerEl?.id === "mgh-cp-avatar-clip" ? 64
            : containerEl?.id === "link-thumb-preview-circle" ? 52 : 48;
    _acmApplyToClip(containerEl, cx, cy, zoom, C);
}

/* ══════════ END AVATAR CROP ══════════ */

/* ── Fullscreen viewer (images + thumb videos) ── */

function _mghLightbox(src) {
    _mghOpenViewer([{ type: "image", src, name: "" }], 0);
}

function _mghOpenViewer(items, idx) {
    if (!items.length) return;
    _mghViewItems = items;
    _mghViewCur   = ((idx ?? 0) + items.length) % items.length;

    let el = document.getElementById("mgh-viewer");
    if (!el) {
        el = document.createElement("div");
        el.id        = "mgh-viewer";
        el.className = "mgh-viewer";
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-modal", "true");
        el.innerHTML = `
            <button class="wslb-close" id="mgh-viewer-close" title="Close (Esc)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="wslb-stage" id="mgh-viewer-stage"></div>
            <button class="wslb-nav wslb-prev" id="mgh-viewer-prev" aria-label="Previous">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="wslb-nav wslb-next" id="mgh-viewer-next" aria-label="Next">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
            </button>
            <div class="wslb-foot">
                <div class="wslb-dots" id="mgh-viewer-dots"></div>
                <div class="wslb-cap"  id="mgh-viewer-cap"></div>
            </div>`;
        document.body.appendChild(el);

        document.getElementById("mgh-viewer-close").addEventListener("click", _mghCloseViewer);
        el.addEventListener("click", e => { if (e.target === el) _mghCloseViewer(); });

        document.getElementById("mgh-viewer-prev").addEventListener("click", () => {
            _mghViewCur = (_mghViewCur - 1 + _mghViewItems.length) % _mghViewItems.length;
            _mghRenderViewer();
        });
        document.getElementById("mgh-viewer-next").addEventListener("click", () => {
            _mghViewCur = (_mghViewCur + 1) % _mghViewItems.length;
            _mghRenderViewer();
        });
        document.getElementById("mgh-viewer-dots").addEventListener("click", e => {
            const d = e.target.closest("[data-vi]");
            if (d) { _mghViewCur = Number(d.dataset.vi); _mghRenderViewer(); }
        });

        document.addEventListener("keydown", e => {
            if (!document.getElementById("mgh-viewer")?.classList.contains("open")) return;
            if (e.key === "Escape")     _mghCloseViewer();
            if (e.key === "ArrowLeft")  { _mghViewCur = (_mghViewCur - 1 + _mghViewItems.length) % _mghViewItems.length; _mghRenderViewer(); }
            if (e.key === "ArrowRight") { _mghViewCur = (_mghViewCur + 1) % _mghViewItems.length; _mghRenderViewer(); }
        });

        let _tx0 = 0, _ty0 = 0;
        el.addEventListener("touchstart", e => { _tx0 = e.touches[0].clientX; _ty0 = e.touches[0].clientY; }, { passive: true });
        el.addEventListener("touchend", e => {
            const dx = e.changedTouches[0].clientX - _tx0;
            const dy = e.changedTouches[0].clientY - _ty0;
            if (dy > 88 && Math.abs(dy) > Math.abs(dx)) { _mghCloseViewer(); return; }
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 42) {
                _mghViewCur = (dx < 0 ? _mghViewCur + 1 : _mghViewCur - 1 + _mghViewItems.length) % _mghViewItems.length;
                _mghRenderViewer();
            }
        }, { passive: true });
    }

    el.classList.add("open");
    document.body.classList.add("mgh-viewer-active");
    _mghRenderViewer();
}

function _mghRenderViewer() {
    const el    = document.getElementById("mgh-viewer");
    const stage = document.getElementById("mgh-viewer-stage");
    const dots  = document.getElementById("mgh-viewer-dots");
    const cap   = document.getElementById("mgh-viewer-cap");
    if (!el || !stage) return;

    const item = _mghViewItems[_mghViewCur];
    if (!item) { _mghCloseViewer(); return; }

    const hasMult = _mghViewItems.length > 1;
    document.getElementById("mgh-viewer-prev").style.display = hasMult ? "" : "none";
    document.getElementById("mgh-viewer-next").style.display = hasMult ? "" : "none";

    if (item.type === "image") {
        stage.innerHTML = `<img class="wslb-img" src="${escHtml(item.src)}" alt="${escHtml(item.name)}">`;
    } else if (item.type === "video" || item.type === "thumb-video") {
        stage.innerHTML = "";
        const thumbSrc = item.thumb || item.src || "";
        const embed = _mghEmbed(item.url);
        const _showThumbFallback = () => {
            stage.innerHTML = "";
            const wrap = document.createElement("div"); wrap.className = "wslb-thumb-wrap";
            if (thumbSrc) { const img = document.createElement("img"); img.className = "wslb-img"; img.src = thumbSrc; img.alt = item.name || ""; wrap.appendChild(img); }
            if (item.url) {
                const a = document.createElement("a"); a.className = "wslb-play-btn"; a.href = item.url; a.target = "_blank"; a.rel = "noopener noreferrer";
                a.addEventListener("click", e => e.stopPropagation());
                a.innerHTML = _playSvg(52);
                wrap.appendChild(a);
            }
            stage.appendChild(wrap);
        };
        if (embed?.type === "direct") {
            const vid = document.createElement("video");
            vid.src = embed.src; vid.controls = true; vid.autoplay = true; vid.playsInline = true;
            if (thumbSrc) vid.poster = thumbSrc;
            vid.style.cssText = "max-width:100%;max-height:100%;";
            vid.addEventListener("error", _showThumbFallback, { once: true });
            stage.appendChild(vid);
        } else if (embed) {
            const wrap = document.createElement("div"); wrap.className = "wslb-video-wrap";
            const iframe = document.createElement("iframe");
            iframe.src = embed.type === "iframe"
                ? embed.src
                : embed.src + (embed.src.includes("?") ? "&" : "?") + "autoplay=1";
            iframe.allowFullscreen = true; iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            wrap.appendChild(iframe); stage.appendChild(wrap);
        } else {
            _showThumbFallback();
        }
    } else {
        stage.innerHTML = item.url
            ? `<a class="wslb-link-placeholder" href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${_playSvg(72)}<span>${escHtml(item.name || "Open")}</span></a>`
            : `<span style="color:rgba(255,255,255,0.3)">No media</span>`;
    }

    if (cap) { cap.textContent = item.name || ""; cap.style.display = item.name ? "" : "none"; }

    if (dots) {
        dots.innerHTML = "";
        const total = _mghViewItems.length;
        if (total > 1 && total <= 12) {
            _mghViewItems.forEach((_, i) => {
                const d = document.createElement("button");
                d.className = "wslb-dot" + (i === _mghViewCur ? " active" : "");
                d.dataset.vi = i;
                d.setAttribute("aria-label", `Item ${i + 1}`);
                dots.appendChild(d);
            });
        }
    }
}

function _mghCloseViewer() {
    const el    = document.getElementById("mgh-viewer");
    const stage = document.getElementById("mgh-viewer-stage");
    el?.classList.remove("open");
    document.body.classList.remove("mgh-viewer-active");
    if (stage) stage.innerHTML = "";
}

/* ── Fullscreen feed (TikTok-style) ── */

function _openMghFeed(allMedia) {
    document.getElementById("mgh-feed-fullscreen")?.remove();

    const ol = document.createElement("div");
    ol.id        = "mgh-feed-fullscreen";
    ol.className = "mgh-feed-fullscreen";
    ol.setAttribute("role", "dialog");
    ol.setAttribute("aria-modal", "true");
    ol.setAttribute("aria-label", "Feed viewer");

    const closeBtn = document.createElement("button");
    closeBtn.className = "mgh-feed-fs-close";
    closeBtn.setAttribute("aria-label", "Close feed");
    closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    const _close = () => {
        observer.disconnect();
        grid.querySelectorAll(".feed-card-video").forEach(v => v.pause());
        ol.remove();
        document.body.classList.remove("mgh-feed-open");
    };
    closeBtn.addEventListener("click", _close);

    const shuffled = [...allMedia].sort(() => Math.random() - 0.5);
    const grid = document.createElement("div");
    grid.className = "shorts-grid";
    shuffled.forEach(l => {
        const c = l.type === "image-group" ? _mghImageGroupFeedCard(l) : (l.type === "video-group" ? _mghVideoGroupFeedCard(l) : _mghFeedCard(l));
        if (c) grid.appendChild(c);
    });

    ol.appendChild(closeBtn);
    ol.appendChild(grid);
    document.body.appendChild(ol);
    document.body.classList.add("mgh-feed-open");

    // ── Auto-play/pause via IntersectionObserver ──
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const vid = entry.target.querySelector(".feed-card-video");
            if (!vid) return;
            if (entry.intersectionRatio >= 0.7) {
                vid.play().catch(() => {});
            } else {
                vid.pause();
            }
        });
    }, { root: grid, threshold: 0.7 });
    grid.querySelectorAll(".feed-card").forEach(card => observer.observe(card));

    // ── One-card-per-swipe touch handling ──
    let _touchStartY = 0;
    let _swipeLocked = false;
    grid.addEventListener("touchstart", e => {
        _touchStartY = e.touches[0].clientY;
    }, { passive: true });
    grid.addEventListener("touchend", e => {
        if (_swipeLocked) return;
        const dy = _touchStartY - e.changedTouches[0].clientY;
        if (Math.abs(dy) < 40) return; // ignore tiny swipes
        _swipeLocked = true;
        const cards = Array.from(grid.querySelectorAll(".feed-card"));
        const visible = cards.find(c => {
            const r = c.getBoundingClientRect();
            const gr = grid.getBoundingClientRect();
            return r.top >= gr.top - 20 && r.top <= gr.top + 20;
        }) || cards.find(c => {
            const r = c.getBoundingClientRect();
            const gr = grid.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            return mid >= gr.top && mid <= gr.bottom;
        });
        if (visible) {
            const idx = cards.indexOf(visible);
            const target = dy > 0 ? cards[idx + 1] : cards[idx - 1];
            if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        setTimeout(() => { _swipeLocked = false; }, 600);
    }, { passive: true });

    const escH = e => {
        if (e.key === "Escape") { _close(); document.removeEventListener("keydown", escH); }
    };
    document.addEventListener("keydown", escH);
}

/* ── Creator panel ── */
let _mghCpInited = false;
function _mghOpenCreatorPanel(creator) {
    if (!creator) return;
    const panel = document.getElementById("mgh-creator-panel");
    if (!panel) return;
    const isChar = creator.type === "person";
    const matched = _mghMatchLinked(creator);
    const _rawThumb  = creator.thumbUrl || "";
    const _isBroken  = _rawThumb.includes("unavatar.io") || _rawThumb.includes("ui-avatars.com") || _rawThumb.includes("dicebear.com");
    const avatarSrc  = (_rawThumb && !_isBroken) ? _rawThumb
                     : _mghDiceBearUrl(creator.title || creator.username || creator.id || "anon");

    const avatarEl    = document.getElementById("mgh-cp-avatar");
    const fallbackEl  = document.getElementById("mgh-cp-avatar-fallback");
    const clipEl      = document.getElementById("mgh-cp-avatar-clip");
    avatarEl.src = avatarSrc;
    if (clipEl) clipEl.style.display = "";
    fallbackEl.style.display = "none";
    // Apply pixel-accurate crop (scaled to 64px panel avatar)
    _acmApplyToClip(clipEl, creator.thumbCropCx ?? 50, creator.thumbCropCy ?? 50, creator.thumbCropZoom ?? 1, 64);

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
    if (!isChar && (creator.url || creator.profileUrl)) { profBtn.style.display = ""; profBtn.onclick = () => window.open(creator.url || creator.profileUrl, "_blank", "noopener,noreferrer"); }
    else profBtn.style.display = "none";

    const body = document.getElementById("mgh-cp-body");
    body.innerHTML = "";

    // Action bar: feed + auto-link buttons
    const MEDIA_TYPES_CP = ["image", "3d-model", "image-group", "youtube-video", "youtube-playlist", "video", "video-group"];
    const mediaMatched = matched.filter(l => MEDIA_TYPES_CP.includes(l.type));
    const actionsRow = document.createElement("div");
    actionsRow.className = "cp-actions-row";
    if (mediaMatched.length) {
        const feedBtn = document.createElement("button");
        feedBtn.className = "ws-btn ws-btn-ghost ws-btn-sm cp-action-btn";
        feedBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> View in feed`;
        feedBtn.addEventListener("click", () => _openMghFeed(mediaMatched));
        actionsRow.appendChild(feedBtn);
    }
    if (isChar) {
        const tagBtn = document.createElement("button");
        tagBtn.className = "ws-btn ws-btn-ghost ws-btn-sm cp-action-btn cp-action-btn--teal";
        tagBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Auto-link by name`;
        tagBtn.addEventListener("click", () => _mghAutoLinkPerson(creator));
        actionsRow.appendChild(tagBtn);
    }
    if (actionsRow.children.length) body.appendChild(actionsRow);

    if (!matched.length) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "creator-panel-empty";
        emptyDiv.innerHTML = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.25"><rect x="6" y="10" width="36" height="28" rx="2" stroke="white" stroke-width="2"/><path d="M14 24h20M14 30h12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
            <p>No saved items ${isChar ? "tagged with this character" : "linked to this creator"} yet.</p>`;
        body.appendChild(emptyDiv);
    } else {
        const countEl = document.createElement("p"); countEl.className = "creator-panel-count";
        countEl.textContent = `${matched.length} saved item${matched.length !== 1 ? "s" : ""}`;
        body.appendChild(countEl);
        const grid = document.createElement("div"); grid.className = "media-grid";
        matched.forEach(l => {
            const VTYPES = ["youtube-video", "youtube-playlist", "video", "video-group"];
            if (l.type === "video-group")       grid.appendChild(_mghVideoGroupCard(l));
            else if (VTYPES.includes(l.type))   grid.appendChild(_mghVideoCard(l));
            else if (l.type === "image-group")  grid.appendChild(_mghImageGroupCard(l));
            else                                grid.appendChild(_mghImageCard(l));
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
    const card = document.createElement("div"); card.className = "db-site-card"; card.dataset.id = link.id;
    const fav   = _mghFav(link.url);
    const fav64 = fav.replace("sz=32", "sz=128");
    /* Only use thumbUrls that are user-supplied or og:image captures.
       Skip thum.io and unavatar.io: those services return HTML for blocked/adult content
       which triggers browser OpaqueResponseBlocking errors. */
    const _rawThumb = link.thumbUrl || "";
    const thumb = (_rawThumb && !_rawThumb.includes("thum.io") && !_rawThumb.includes("unavatar.io"))
        ? _rawThumb : "";
    const label = link.title || _mghPretty(link.url);
    const iconHtml = thumb
        ? `<div class="db-site-icon db-site-icon--thumb">
               <img class="db-site-thumb-img" src="${escHtml(thumb)}" alt="" onerror="this.classList.add('db-site-thumb-img--err')">
               <img class="db-site-fav-badge" src="${escHtml(fav)}" alt="" onerror="this.style.display='none'">
           </div>`
        : `<div class="db-site-icon">
               <img class="db-site-fav-lg" src="${escHtml(fav64)}" alt="" onerror="this.style.opacity='0'">
           </div>`;
    card.innerHTML = `
        <a class="db-site-link" href="${escHtml(link.url || "#")}" target="_blank" rel="noopener noreferrer">
            ${iconHtml}
            <div class="db-site-name">${escHtml(label)}</div>
        </a>`;
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Video card ── */
function _mghVideoCard(link, opts = {}) {
    const card = document.createElement("div"); card.className = "video-card"; card.dataset.id = link.id;
    const embed = _mghEmbed(link.url);
    const creator = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);
    // Effective static thumbnail (used in tiles view so we don't embed many iframes/videos)
    let _effThumb = link.thumbUrl || "";
    if (!_effThumb && embed?.type === "youtube") {
        const ytId = embed.src.split("/embed/")[1]?.split("?")[0];
        if (ytId) _effThumb = `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;
    }
    let mediaHtml, isThumb = false, isLink = false, isDirect = false;
    if (opts.thumbnailOnly) {
        // Force a static thumbnail instead of an embed/iframe
        if (_effThumb) {
            isThumb = true;
            mediaHtml = `<img src="${escHtml(_effThumb)}" alt="${escHtml(link.title || "")}" style="width:100%;height:auto;display:block">
                <div class="video-thumb-play-overlay">${_playSvg(40)}</div>`;
        } else if (link.url) {
            isLink = true;
            mediaHtml = `<div class="video-link-placeholder">${_playSvg(36)}<span class="video-link-domain">${escHtml(_domain(link.url))}</span></div>`;
        } else {
            mediaHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:80px;color:#555;font-size:0.8rem">No video</div>`;
        }
    } else if (embed) {
        if (embed.type === "direct") {
            isDirect = true;
            mediaHtml = `<video src="${escHtml(embed.src)}"${link.thumbUrl ? ` poster="${escHtml(link.thumbUrl)}"` : ""} controls preload="none"></video>`;
        } else {
            mediaHtml = `<iframe src="${escHtml(embed.src)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe>`;
        }
    } else if (link.thumbUrl) {
        isThumb = true;
        mediaHtml = `<img src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.title || "")}" style="width:100%;height:auto;display:block">
            <div class="video-thumb-play-overlay">${_playSvg(40)}</div>`;
    } else if (link.url) {
        isLink = true;
        const domain = _domain(link.url);
        mediaHtml = `<div class="video-link-placeholder">${_playSvg(36)}<span class="video-link-domain">${escHtml(domain)}</span></div>`;
    } else {
        mediaHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:80px;color:#555;font-size:0.8rem">No video</div>`;
    }
    const badge = embed ? (embed.type === "youtube" ? "YT" : embed.type === "vimeo" ? "VIMEO" : "VIDEO") : (link.thumbUrl ? "IMG" : "LINK");
    card.innerHTML = `
        <div class="video-iframe-wrap${isThumb ? " video-iframe-wrap--thumb" : ""}${isDirect ? " video-iframe-wrap--direct" : ""}">${mediaHtml}</div>
        <div class="video-card-body">
            <span class="video-type-badge">${badge}</span>
            <span class="video-card-name">${escHtml(link.title || "")}</span>
            ${(link.sourceUrl || link.url) ? `<a class="card-source-link" href="${escHtml(link.sourceUrl || link.url)}" target="_blank" rel="noopener noreferrer" title="${link.sourceUrl ? "Go to source" : "Go to video"}" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
        </div>
        ${creator ? `<div class="image-card-creator" title="Creator: ${escHtml(creator.title || "")}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(creator.title || "")}</span></div>` : ""}
        ${persons.length ? `<div class="image-card-person"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(persons.map(p => p.title).join(", "))}</span></div>` : ""}`;
    if (isThumb && link.url) {
        let _isCorpHost = false;
        try { _isCorpHost = _CORP_VIDEO_HOSTS.has(new URL(link.url).hostname); } catch {}
        if (_isCorpHost) {
            const openNew = e => { e.stopPropagation(); window.open(link.url, "_blank", "noopener,noreferrer"); };
            card.querySelector(".video-thumb-play-overlay")?.addEventListener("click", openNew);
            card.querySelector(".video-iframe-wrap img")?.addEventListener("click", openNew);
        } else {
            const _vi = _mghViewItems.length;
            _mghViewItems.push({ type: "thumb-video", src: _effThumb || "", name: link.title || "", url: link.url });
            const openLb = e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi); };
            card.querySelector(".video-thumb-play-overlay")?.addEventListener("click", openLb);
            card.querySelector(".video-iframe-wrap img")?.addEventListener("click", openLb);
        }
    }
    // For direct video embeds without thumbnail: fall back to thumbnail (or link) on error (403, CORS, etc.)
    const _inlineVid = card.querySelector(".video-iframe-wrap video");
    if (_inlineVid) {
        _inlineVid.addEventListener("error", () => {
            const wrap = _inlineVid.closest(".video-iframe-wrap");
            if (!wrap) return;
            if (link.thumbUrl) {
                wrap.className = "video-iframe-wrap video-iframe-wrap--thumb";
                wrap.innerHTML = `<img src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.title || "")}" style="width:100%;height:auto;display:block"><div class="video-thumb-play-overlay">${_playSvg(40)}</div>`;
                if (link.url) {
                    let _isCorpHost2 = false;
                    try { _isCorpHost2 = _CORP_VIDEO_HOSTS.has(new URL(link.url).hostname); } catch {}
                    if (_isCorpHost2) {
                        const openNew2 = e => { e.stopPropagation(); window.open(link.url, "_blank", "noopener,noreferrer"); };
                        wrap.querySelector(".video-thumb-play-overlay")?.addEventListener("click", openNew2);
                        wrap.querySelector("img")?.addEventListener("click", openNew2);
                    } else {
                        const _vi2 = _mghViewItems.length;
                        _mghViewItems.push({ type: "thumb-video", src: link.thumbUrl, name: link.title || "", url: link.url });
                        const openLb2 = e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi2); };
                        wrap.querySelector(".video-thumb-play-overlay")?.addEventListener("click", openLb2);
                        wrap.querySelector("img")?.addEventListener("click", openLb2);
                    }
                }
            } else if (link.url) {
                wrap.className = "video-iframe-wrap";
                wrap.innerHTML = `<div class="video-link-placeholder">${_playSvg(36)}<span class="video-link-domain">${escHtml(_domain(link.url))}</span></div>`;
                const _vi2 = _mghViewItems.length;
                _mghViewItems.push({ type: "video", url: link.url, thumb: "", name: link.title || "" });
                wrap.querySelector(".video-link-placeholder")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi2); });
            }
        }, { once: true });
    }
    if (isLink && link.url) {
        try {
            if (_CORP_VIDEO_HOSTS.has(new URL(link.url).hostname)) {
                // CORP-blocked CDN: one click → open directly in new tab, skip the viewer
                card.querySelector(".video-link-placeholder")?.addEventListener("click", e => { e.stopPropagation(); window.open(link.url, "_blank", "noopener,noreferrer"); });
            } else {
                const _vi = _mghViewItems.length;
                _mghViewItems.push({ type: "link-video", src: "", name: link.title || "", url: link.url });
                card.querySelector(".video-link-placeholder")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi); });
            }
        } catch {
            const _vi = _mghViewItems.length;
            _mghViewItems.push({ type: "link-video", src: "", name: link.title || "", url: link.url });
            card.querySelector(".video-link-placeholder")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi); });
        }
    }
    card.querySelector(".image-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.querySelector(".image-card-person")?.addEventListener("click", e => { e.stopPropagation(); if (persons[0]) _mghOpenCreatorPanel(persons[0]); });
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Image card ── */
function _mghImageCard(link) {
    const card = document.createElement("div"); card.className = "image-card"; card.dataset.id = link.id;
    const src = link.url || link.thumbUrl || "";
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
    if (imgEl && src) {
        const _vi = _mghViewItems.length;
        _mghViewItems.push({ type: "image", src, name: link.title || "" });
        imgEl.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], _vi); });
    }
    card.querySelector(".image-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.querySelector(".image-card-person")?.addEventListener("click", e => { e.stopPropagation(); if (persons[0]) _mghOpenCreatorPanel(persons[0]); });
    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Image group card ── */
function _mghImageGroupCard(link) {
    const card = document.createElement("div"); card.className = "image-group-card"; card.dataset.id = link.id;
    const imgs = Array.isArray(link.images) ? link.images.filter(i => i?.url) : [];
    const count = imgs.length;
    const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'%3E%3Crect fill='%231a1a1a' width='4' height='3'/%3E%3C/svg%3E";
    const creator   = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons   = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);

    if (count === 0) {
        card.innerHTML = `<div style="background:#111;min-height:80px;display:flex;align-items:center;justify-content:center;color:#444;font-size:0.72rem">No images</div><div class="image-card-body"><span class="image-type-badge">GROUP</span><span class="image-card-name">${escHtml(link.title || "")}</span></div>`;
        card.appendChild(_mghCardActions(link));
        return card;
    }

    // Register all images in the global viewer list
    const viStart = _mghViewItems.length;
    imgs.forEach(img => _mghViewItems.push({ type: "image", src: img.url, name: img.name || link.title || "" }));

    if (count <= 4) {
        // Grid layout — first image sets height, others cover their cells
        const grid = document.createElement("div");
        grid.className = "image-group-grid";
        grid.dataset.count = count;
        imgs.forEach((img, i) => {
            const item = document.createElement("div"); item.className = "ig-item";
            const imgEl = document.createElement("img");
            imgEl.src = img.url; imgEl.alt = img.name || link.title || "";
            imgEl.loading = "lazy";
            imgEl.onerror = function() { this.src = fallback; };
            imgEl.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], viStart + i); });
            item.appendChild(imgEl);
            grid.appendChild(item);
        });
        // After first image loads, lock grid height so 1fr rows work and others fill with cover
        if (count > 1) {
            const firstImg = grid.querySelector("img");
            const lockHeight = () => {
                const h = firstImg.offsetHeight;
                if (h > 0) {
                    // count=4 is 2×2 equal: first image is in one row, so grid needs 2× that height
                    grid.style.height = `${h * (count === 4 ? 2 : 1)}px`;
                } else requestAnimationFrame(lockHeight);
            };
            firstImg.complete ? requestAnimationFrame(lockHeight)
                              : firstImg.addEventListener("load", () => requestAnimationFrame(lockHeight), { once: true });
        }
        card.appendChild(grid);
    } else {
        // Cycling layout for > 4 images — one image at a time with prev/next
        let curIdx = 0;
        let heightLocked = false;
        const wrap = document.createElement("div"); wrap.className = "ig-cycle-wrap";
        const imgEl = document.createElement("img"); imgEl.className = "ig-cycle-img";
        imgEl.src = imgs[0].url; imgEl.alt = imgs[0].name || link.title || ""; imgEl.loading = "lazy";
        imgEl.onerror = function() { this.src = fallback; };
        const counter = document.createElement("div"); counter.className = "ig-cycle-counter";
        counter.textContent = `1 / ${count}`;
        const goTo = (idx) => {
            curIdx = (idx + count) % count;
            imgEl.src = imgs[curIdx].url; imgEl.alt = imgs[curIdx].name || link.title || "";
            counter.textContent = `${curIdx + 1} / ${count}`;
        };
        const prev = document.createElement("button"); prev.className = "ig-cycle-btn ig-cycle-prev"; prev.innerHTML = "&#8249;"; prev.title = "Previous";
        const next = document.createElement("button"); next.className = "ig-cycle-btn ig-cycle-next"; next.innerHTML = "&#8250;"; next.title = "Next";
        prev.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx - 1); });
        next.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx + 1); });
        imgEl.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], viStart + curIdx); });
        // After first image loads, lock wrap height; all subsequent images fill with cover
        const lockWrap = () => {
            const h = imgEl.offsetHeight;
            if (h > 0 && !heightLocked) {
                heightLocked = true;
                wrap.style.height = `${h}px`;
                imgEl.style.height = "100%";
                imgEl.style.objectFit = "cover";
            } else if (!heightLocked) { requestAnimationFrame(lockWrap); }
        };
        imgEl.complete ? requestAnimationFrame(lockWrap)
                       : imgEl.addEventListener("load", () => requestAnimationFrame(lockWrap), { once: true });
        wrap.appendChild(imgEl); wrap.appendChild(prev); wrap.appendChild(next); wrap.appendChild(counter);
        card.appendChild(wrap);
        // Auto-cycle; pause on hover, clean up when card is removed
        let _autoTimer = setInterval(() => goTo(curIdx + 1), 3000);
        wrap.addEventListener("mouseenter", () => clearInterval(_autoTimer));
        wrap.addEventListener("mouseleave", () => { _autoTimer = setInterval(() => goTo(curIdx + 1), 3000); });
        new MutationObserver((_, obs) => { if (!document.contains(card)) { clearInterval(_autoTimer); obs.disconnect(); } })
            .observe(document.body, { childList: true, subtree: true });
    }

    const body = document.createElement("div"); body.className = "image-card-body";
    body.innerHTML = `<span class="image-type-badge">GROUP</span><span class="image-card-name">${escHtml(link.title || `Group · ${count} image${count !== 1 ? "s" : ""}`)}</span>${link.sourceUrl ? `<a class="card-source-link" href="${escHtml(link.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}`;
    card.appendChild(body);

    if (creator) {
        const creatorEl = document.createElement("div");
        creatorEl.className = "image-card-creator";
        creatorEl.title = `Creator: ${creator.title || ""}`;
        creatorEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(creator.title || "")}</span>`;
        creatorEl.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
        card.appendChild(creatorEl);
    }
    if (persons.length) {
        const personEl = document.createElement("div");
        personEl.className = "image-card-person";
        personEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(persons.map(p => p.title).join(", "))}</span>`;
        personEl.addEventListener("click", e => { e.stopPropagation(); if (persons[0]) _mghOpenCreatorPanel(persons[0]); });
        card.appendChild(personEl);
    }

    card.appendChild(_mghCardActions(link));
    return card;
}

/* ── Creator card ── */
function _mghCreatorCard(link) {
    const card = document.createElement("div"); card.className = "creator-card"; card.dataset.id = link.id;
    const isChar = link.type === "person";

    /* Determine avatar to display synchronously:
       - Use stored thumbUrl if it's a valid, non-broken URL
       - Otherwise show DiceBear immediately (no network request, no ORB error)
       - A background refresh will patch the card once a real/cached avatar is found */
    const _raw          = link.thumbUrl || "";
    const _isOldService = _raw.includes("unavatar.io") || _raw.includes("ui-avatars.com");
    const _isDicebear   = _raw.includes("dicebear.com");
    const _isBroken     = _isOldService || _isDicebear;
    const avatarSrc     = (_raw && !_isBroken) ? _raw : _mghDiceBearUrl(link.title || link.username || link.id || "anon");
    const needsRefresh  = !_raw || _isOldService;
    // Clear any stored DiceBear URL — it should not be in the database (once per session)
    if (_isDicebear && _db && _uid?.() && !_adminOwnerUid && link.id && !_mghDicebearCleaned.has(link.id)) {
        _mghDicebearCleaned.add(link.id);
        updateDoc(doc(_db, "users", _uid(), "gallery-links", link.id), { thumbUrl: deleteField() }).catch(() => {});
    }

    const { cls, label: bdgLabel, color, isCustom } = _mghPlatBadge(link);
    const badgeStyle    = (isCustom && color) ? ` style="color:${escHtml(color)};border-color:${escHtml(color)}66"` : "";
    const linkedCount   = _mghMatchLinked(link).length;
    const _cx = link.thumbCropCx   ?? 50;
    const _cy = link.thumbCropCy   ?? 50;
    const _cz = link.thumbCropZoom ?? 1;

    card.innerHTML = `
        <div class="creator-avatar-clip">
            <img class="creator-avatar" src="${escHtml(avatarSrc)}" alt="${escHtml(link.title || "")}"
                 onerror="this.closest('.creator-avatar-clip').style.display='none';this.closest('.creator-avatar-clip').nextElementSibling.style.removeProperty('display')">
        </div>
        <div class="creator-avatar-fallback" style="display:none">${escHtml((link.title || "?")[0].toUpperCase())}</div>
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
        ${(link.url || link.profileUrl) ? `<a class="creator-card-link" href="${escHtml(link.url || link.profileUrl)}" target="_blank" rel="noopener noreferrer" title="Open profile" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}`;

    /* Crop only when using an explicit manually-set avatar */
    if (!_isBroken && _raw) _acmApplyToClip(card.querySelector(".creator-avatar-clip"), _cx, _cy, _cz, 48);

    /* Background refresh for missing/broken avatars — patches card + Firestore when resolved */
    if (needsRefresh) {
        const creatorUrl = link.url || link.profileUrl || "";
        const parsed     = creatorUrl ? _mghParseCreatorUrl(creatorUrl) : null;
        if (parsed?.username) {
            const key = _mghProfileKey(parsed.platform, parsed.username);
            /* Use session cache to avoid duplicate fetches for the same creator */
            if (_mghProfileCache.has(key)) {
                /* Already resolved this session — patch immediately */
                const cached = _mghProfileCache.get(key);
                if (cached) card.querySelector(".creator-avatar").src = cached;
            } else {
                _mghRefreshAvatarBackground(link, card, parsed);
            }
        }
    }

    card.addEventListener("click", e => {
        if (e.target.closest(".db-card-actions,.creator-card-link")) return;
        _mghOpenCreatorPanel(link);
    });
    card.appendChild(_mghCardActions(link));
    return card;
}

async function _mghAutoLinkAll(catLinks) {
    const MEDIA_TYPES = ["image","3d-model","image-group","youtube-video","youtube-playlist","video","video-group"];
    const persons = catLinks.filter(l => l.type === "person");
    const media   = catLinks.filter(l => MEDIA_TYPES.includes(l.type));

    // updates[id] = { l, data: { personIds?, personId?, creatorId? } }
    const updates = {};
    function getEntry(l) {
        if (!updates[l.id]) updates[l.id] = { l, data: {} };
        return updates[l.id];
    }

    // 1. Person matching by title (existing logic)
    persons.forEach(person => {
        const name = (person.title || "").toLowerCase().trim();
        if (!name) return;
        media.forEach(l => {
            if (!(l.title || "").toLowerCase().includes(name)) return;
            const cur = l.personIds || (l.personId ? [l.personId] : []);
            if (cur.includes(person.id)) return;
            const entry = getEntry(l);
            if (!entry.data.personIds) entry.data.personIds = [...cur];
            if (!entry.data.personIds.includes(person.id)) entry.data.personIds.push(person.id);
        });
    });
    Object.values(updates).forEach(entry => {
        if (entry.data.personIds) entry.data.personId = entry.data.personIds[0] ?? null;
    });

    // 2. URL-based creator matching / creation
    const _profileUrlFor = (platform, username) => ({
        youtube:   `https://www.youtube.com/@${username}`,
        twitter:   `https://x.com/${username}`,
        instagram: `https://www.instagram.com/${username}`,
        tiktok:    `https://www.tiktok.com/@${username}`,
        twitch:    `https://www.twitch.tv/${username}`,
    }[platform] || null);
    const newCreatorCache = {}; // "platform:username:category" -> id

    const VIDEO_TYPES = ["youtube-video", "youtube-playlist", "video", "video-group"];
    for (const l of media) {
        // Skip only if creatorId points to a real existing creator (stale IDs should be re-resolved)
        if (l.creatorId && _links.some(c => c.id === l.creatorId)) continue;
        // Videos: try url first (may be a twitter/social video URL); images: try sourceUrl first
        const isVid = VIDEO_TYPES.includes(l.type);
        let parsed = null;
        let parsedFromUrl = "";
        for (const u of isVid ? [l.url, l.sourceUrl] : [l.sourceUrl, l.url]) {
            if (!u) continue;
            const p = _mghParseCreatorUrl(u);
            if (p && p.platform !== "other" && p.username) { parsed = p; parsedFromUrl = u; break; }
        }
        if (!parsed) continue;

        const existing = _links.find(c => {
            if (c.type !== "creator" && c.type !== "youtube-channel") return false;
            // prefer stored username/platform fields; fall back to parsing the creator's own URL
            const cu = c.username && c.platform
                ? { username: c.username, platform: c.platform }
                : _mghParseCreatorUrl(c.url || c.profileUrl || "");
            if (!cu?.username) return false;
            return cu.username.toLowerCase() === parsed.username.toLowerCase() && cu.platform === parsed.platform;
        });

        if (existing) {
            getEntry(l).data.creatorId = existing.id;
        } else {
            const cacheKey = `${parsed.platform}:${parsed.username.toLowerCase()}:${l.category}`;
            if (!newCreatorCache[cacheKey]) {
                const profileUrl = _profileUrlFor(parsed.platform, parsed.username) || parsedFromUrl;
                const cData = {
                    title: parsed.username, url: profileUrl,
                    type: "creator", category: l.category,
                    username: parsed.username, platform: parsed.platform,
                    thumbUrl: await _mghCreatorAvatar(parsed.platform, parsed.username, profileUrl),
                    badgeLabel: "", badgeColor: "", createdAt: serverTimestamp(),
                };
                const cRef = await addDoc(refs.galleryLinks(_db, _uid()), cData);
                newCreatorCache[cacheKey] = cRef.id;
            }
            getEntry(l).data.creatorId = newCreatorCache[cacheKey];
        }
    }

    const entries = Object.values(updates);
    if (!entries.length) { toast("No new matches found.", "info"); return; }
    try {
        await Promise.all(entries.map(({ l, data }) =>
            updateDoc(doc(_db, "users", _uid(), "gallery-links", l.id), data)
        ));
        const createdCount  = Object.keys(newCreatorCache).length;
        const personCount   = entries.filter(e => e.data.personIds).length;
        const creatorCount  = entries.filter(e => e.data.creatorId).length;
        const parts = [];
        if (personCount)  parts.push(`linked ${personCount} item${personCount !== 1 ? "s" : ""} to character${personCount !== 1 ? "s" : ""}`);
        if (creatorCount) parts.push(`linked ${creatorCount} item${creatorCount !== 1 ? "s" : ""} to creator${creatorCount !== 1 ? "s" : ""}`);
        if (createdCount) parts.push(`created ${createdCount} new creator${createdCount !== 1 ? "s" : ""}`);
        toast((parts.join(", ") || "Done") + ".", "success");
    } catch (err) {
        console.error("[links] auto-link all error:", err);
        toast("Error linking some items.", "error");
    }
}

async function _mghAutoLinkPerson(person) {
    const name = (person.title || "").toLowerCase().trim();
    if (!name) { toast("Person has no name to match against.", "info"); return; }

    const MEDIA_TYPES = ["image", "3d-model", "image-group", "youtube-video", "youtube-playlist", "video", "video-group"];
    const catMedia = _links.filter(l => l.category === person.category && MEDIA_TYPES.includes(l.type));

    const unlinked = catMedia.filter(l => {
        if (!(l.title || "").toLowerCase().includes(name)) return false;
        const pIds = l.personIds || (l.personId ? [l.personId] : []);
        return !pIds.includes(person.id);
    });

    if (!unlinked.length) {
        toast(`No unlinked items with "${person.title}" in the title.`, "info");
        return;
    }

    try {
        await Promise.all(unlinked.map(l => {
            const existing = l.personIds || (l.personId ? [l.personId] : []);
            const newIds   = [...existing, person.id];
            return updateDoc(doc(_db, "users", _uid(), "gallery-links", l.id), {
                personIds: newIds,
                personId:  newIds[0],
            });
        }));
        toast(`Linked ${unlinked.length} item${unlinked.length !== 1 ? "s" : ""} to "${person.title}".`, "success");
    } catch (err) {
        console.error("[links] auto-link error:", err);
        toast("Error linking some items.", "error");
    }
}

/* ── Feed card (YouTube Shorts style) ── */
function _mghFeedCard(link) {
    const isVideo = ["youtube-video", "youtube-playlist", "video"].includes(link.type);
    const creator = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);

    const card = document.createElement("div");
    card.className = "feed-card";
    card.dataset.id = link.id;

    let mediaHtml = "";
    let isDirectVideo = false;
    let directSrc = "";
    if (isVideo) {
        const embed = _mghEmbed(link.url);
        if (embed) {
            if (embed.type === "direct") {
                isDirectVideo = true;
                directSrc = embed.src;
                mediaHtml = `<video class="feed-card-media feed-card-video" src="${escHtml(embed.src)}"${link.thumbUrl ? ` poster="${escHtml(link.thumbUrl)}"` : ""} playsinline preload="none"></video>`;
            } else {
                const apiSrc = embed.src + (embed.src.includes("?") ? "&" : "?") + "enablejsapi=1";
                mediaHtml = `<iframe class="feed-card-media" src="${escHtml(apiSrc)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe>`;
            }
        } else if (link.thumbUrl) {
            mediaHtml = `<img class="feed-card-media" src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.title || "")}"><div class="feed-card-play-btn">${_playSvg(44)}</div>`;
        } else {
            mediaHtml = `<div class="feed-card-placeholder">${_playSvg(44)}</div>`;
        }
    } else {
        const src = link.thumbUrl || link.url;
        mediaHtml = src
            ? `<img class="feed-card-media" src="${escHtml(src)}" alt="${escHtml(link.title || "")}">`
            : `<div class="feed-card-placeholder"></div>`;
    }

    const avatarHtml = creator?.thumbUrl
        ? `<img class="feed-card-avatar" src="${escHtml(creator.thumbUrl)}" alt="${escHtml(creator.title || "")}">`
        : `<div class="feed-card-avatar feed-card-avatar--fb"><svg viewBox="0 0 14 14" fill="none" width="14" height="14"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></div>`;

    card.innerHTML = `
        <div class="feed-card-media-wrap">${mediaHtml}</div>
        <div class="feed-card-overlay">
            <div class="feed-card-info">
                ${link.title ? `<div class="feed-card-title">${escHtml(link.title)}</div>` : ""}
                ${creator ? `<div class="feed-card-creator">${avatarHtml}<span class="feed-card-creator-name">${escHtml(creator.title || "")}</span></div>` : ""}
                ${persons.length ? `<div class="feed-card-persons">${persons.map(p => `<span class="feed-card-person-tag">${escHtml(p.title || "")}</span>`).join("")}</div>` : ""}
            </div>
        </div>`;

    if (isDirectVideo) {
        _attachFeedVideoControls(card);
    } else if (isVideo && link.thumbUrl && link.url) {
        card.querySelector(".feed-card-play-btn")?.addEventListener("click", e => { e.stopPropagation(); window.open(link.url, "_blank", "noopener"); });
    } else if (!isVideo && (link.thumbUrl || link.url)) {
        const _feedImgEl = card.querySelector(".feed-card-media");
        const _feedWrap  = card.querySelector(".feed-card-media-wrap");
        if (_feedImgEl) _feedImgEl.addEventListener("click", e => {
            e.stopPropagation();
            const fitting = _feedImgEl.classList.toggle("feed-card-media--fit");
            _feedWrap?.classList.toggle("feed-card-media-wrap--fit", fitting);
        });
    }
    card.querySelector(".feed-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.querySelectorAll(".feed-card-person-tag").forEach((el, i) => el.addEventListener("click", e => { e.stopPropagation(); if (persons[i]) _mghOpenCreatorPanel(persons[i]); }));
    card.appendChild(_mghCardActions(link));
    return card;
}

function _attachFeedVideoControls(card) {
    const vid = card.querySelector(".feed-card-video");
    const wrap = card.querySelector(".feed-card-media-wrap");
    if (!vid || !wrap) return;

    // ── Controls container ──
    const ctrl = document.createElement("div");
    ctrl.className = "feed-card-video-ctrl";

    // Tap zone (top area — single/double tap)
    const tapZone = document.createElement("div");
    tapZone.className = "feed-card-tap-zone";
    const tapL = document.createElement("div"); tapL.className = "feed-card-tap-left";
    const tapR = document.createElement("div"); tapR.className = "feed-card-tap-right";
    tapZone.appendChild(tapL);
    tapZone.appendChild(tapR);
    ctrl.appendChild(tapZone);

    // Seek flash — left
    const flashL = document.createElement("div");
    flashL.className = "feed-card-seek-flash feed-card-seek-flash--left";
    flashL.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg><span>5s</span>`;

    // Seek flash — right
    const flashR = document.createElement("div");
    flashR.className = "feed-card-seek-flash feed-card-seek-flash--right";
    flashR.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg><span>5s</span>`;
    ctrl.appendChild(flashL);
    ctrl.appendChild(flashR);

    // Pause icon (center, shown briefly on single tap)
    const pauseIcon = document.createElement("div");
    pauseIcon.className = "feed-card-pause-icon";
    pauseIcon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
    ctrl.appendChild(pauseIcon);

    // Bottom bar: progress + mute
    const bottom = document.createElement("div");
    bottom.className = "feed-card-video-bottom";

    const progressWrap = document.createElement("div");
    progressWrap.className = "feed-card-progress-wrap";
    const progressBar = document.createElement("div");
    progressBar.className = "feed-card-progress-bar";
    progressWrap.appendChild(progressBar);

    let _muted = false;
    const _muteHtml = () => _muted
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
    const muteBtn = document.createElement("button");
    muteBtn.className = "feed-card-mute-btn";
    muteBtn.setAttribute("aria-label", "Toggle mute");
    muteBtn.innerHTML = _muteHtml();
    muteBtn.addEventListener("click", e => {
        e.stopPropagation();
        _muted = !_muted;
        vid.muted = _muted;
        muteBtn.innerHTML = _muteHtml();
    });

    let _isFit = false;
    const _fitSvgFit  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 4 20 10 20"/><polyline points="20 10 20 4 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    const _fitSvgFill = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    const fitBtn = document.createElement("button");
    fitBtn.className = "feed-card-mute-btn";
    fitBtn.setAttribute("aria-label", "Toggle fit");
    fitBtn.innerHTML = _fitSvgFit;
    fitBtn.addEventListener("click", e => {
        e.stopPropagation();
        _isFit = !_isFit;
        vid.classList.toggle("feed-card-media--fit", _isFit);
        wrap.classList.toggle("feed-card-media-wrap--fit", _isFit);
        fitBtn.innerHTML = _isFit ? _fitSvgFill : _fitSvgFit;
    });

    bottom.appendChild(progressWrap);
    bottom.appendChild(fitBtn);
    bottom.appendChild(muteBtn);
    ctrl.appendChild(bottom);
    wrap.appendChild(ctrl);

    // ── Progress bar update ──
    vid.addEventListener("timeupdate", () => {
        if (vid.duration) progressBar.style.width = `${(vid.currentTime / vid.duration) * 100}%`;
    });
    // Seek on progress bar click
    progressWrap.addEventListener("click", e => {
        e.stopPropagation();
        const r = progressWrap.getBoundingClientRect();
        if (vid.duration) vid.currentTime = ((e.clientX - r.left) / r.width) * vid.duration;
    });

    // ── Tap helpers ──
    let _tapTimer = null;
    let _tapCount = 0;
    const _flashSeek = (dir) => {
        const el = dir === "left" ? flashL : flashR;
        el.classList.add("active");
        setTimeout(() => el.classList.remove("active"), 650);
    };
    const _flashPause = (paused) => {
        pauseIcon.innerHTML = paused
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
        pauseIcon.classList.add("visible");
        setTimeout(() => pauseIcon.classList.remove("visible"), 550);
    };

    const _handleTap = (side) => {
        _tapCount++;
        if (_tapTimer) { clearTimeout(_tapTimer); _tapTimer = null; }
        if (_tapCount >= 2) {
            _tapCount = 0;
            if (side === "left") {
                vid.currentTime = Math.max(0, vid.currentTime - 5);
                _flashSeek("left");
            } else {
                vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 5);
                _flashSeek("right");
            }
        } else {
            _tapTimer = setTimeout(() => {
                _tapCount = 0;
                _tapTimer = null;
                if (vid.paused) { vid.play().catch(() => {}); _flashPause(false); }
                else { vid.pause(); _flashPause(true); }
            }, 230);
        }
    };

    tapL.addEventListener("click", e => { e.stopPropagation(); _handleTap("left"); });
    tapR.addEventListener("click", e => { e.stopPropagation(); _handleTap("right"); });
}

/* ── Image-group feed card (TikTok slideshow) ── */
function _mghImageGroupFeedCard(link) {
    const imgs = Array.isArray(link.images) ? link.images.filter(i => i?.url) : [];
    if (!imgs.length) return null;

    let curIdx = 0;
    const card = document.createElement("div");
    card.className = "feed-card feed-card--group";
    card.dataset.id = link.id;

    const mediaWrap = document.createElement("div");
    mediaWrap.className = "feed-card-media-wrap";

    const imgEl = document.createElement("img");
    imgEl.className = "feed-card-media";
    imgEl.src = imgs[0].url;
    imgEl.alt = link.title || "";
    mediaWrap.appendChild(imgEl);
    card.appendChild(mediaWrap);

    // Slideshow dots
    const dotsEl = document.createElement("div");
    dotsEl.className = "feed-card-slideshow-dots";
    if (imgs.length > 1) {
        imgs.forEach((_, i) => {
            const dot = document.createElement("span");
            dot.className = "feed-card-slideshow-dot" + (i === 0 ? " active" : "");
            dotsEl.appendChild(dot);
        });
        card.appendChild(dotsEl);
    }

    const goTo = (idx) => {
        curIdx = (idx + imgs.length) % imgs.length;
        imgEl.src = imgs[curIdx].url;
        dotsEl.querySelectorAll(".feed-card-slideshow-dot").forEach((d, i) => d.classList.toggle("active", i === curIdx));
    };

    // Tap left/right half to navigate
    if (imgs.length > 1) {
        const prevHit = document.createElement("div");
        prevHit.className = "feed-card-slide-prev";
        prevHit.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx - 1); });
        const nextHit = document.createElement("div");
        nextHit.className = "feed-card-slide-next";
        nextHit.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx + 1); });
        card.appendChild(prevHit);
        card.appendChild(nextHit);
    }

    // Tap image to zoom to fit / back to cover
    imgEl.addEventListener("click", e => {
        e.stopPropagation();
        const fitting = imgEl.classList.toggle("feed-card-media--fit");
        mediaWrap.classList.toggle("feed-card-media-wrap--fit", fitting);
    });

    // Swipe left/right to navigate between slides
    let _sx = 0;
    card.addEventListener("touchstart", e => { _sx = e.touches[0].clientX; }, { passive: true });
    card.addEventListener("touchend", e => {
        const dx = e.changedTouches[0].clientX - _sx;
        if (Math.abs(dx) > 40) goTo(dx < 0 ? curIdx + 1 : curIdx - 1);
    }, { passive: true });

    const creator = _mghFindCreatorFor(link);
    const overlay = document.createElement("div");
    overlay.className = "feed-card-overlay";
    overlay.innerHTML = `<div class="feed-card-info">
        ${link.title ? `<div class="feed-card-title">${escHtml(link.title)}</div>` : ""}
        ${creator ? `<div class="feed-card-creator"><span class="feed-card-creator-name">${escHtml(creator.title || "")}</span></div>` : ""}
    </div>`;
    overlay.querySelector(".feed-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.appendChild(overlay);

    card.appendChild(_mghCardActions(link));
    return card;
}

/* ══════════ VIDEO GROUP ══════════ */

/* Grid card — shows thumbnails/count for a video collection */
function _mghVideoGroupCard(link) {
    const card  = document.createElement("div"); card.className = "image-group-card"; card.dataset.id = link.id;
    const vids  = Array.isArray(link.videos) ? link.videos.filter(v => v?.url) : [];
    const count = vids.length;
    if (!count) {
        const _vgSrc0 = link.sourceUrl || link.url || "";
        card.innerHTML = `<div style="background:#111;min-height:80px;display:flex;align-items:center;justify-content:center;color:#444;font-size:0.72rem">No videos</div>
            <div class="image-card-body"><span class="image-type-badge">VIDEO GROUP</span><span class="image-card-name">${escHtml(link.title || "")}</span>${_vgSrc0 ? `<a class="card-source-link" href="${escHtml(_vgSrc0)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}</div>`;
        card.appendChild(_mghCardActions(link));
        return card;
    }
    const creator   = _mghFindCreatorFor(link);
    const personIds = link.personIds || (link.personId ? [link.personId] : []);
    const persons   = personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);

    // Register ALL videos in the global viewer list so navigation isn't isolated
    const viStart = _mghViewItems.length;
    vids.forEach(v => _mghViewItems.push({ type: "video", url: v.url, thumb: v.thumb || "", name: link.title || "" }));

    const _vThumb = (v) => {
        const embed = _mghEmbed(v.url);
        return v.thumb || (embed?.type === "youtube"
            ? `https://i.ytimg.com/vi/${embed.src.split("/embed/")[1]?.split("?")[0]}/mqdefault.jpg`
            : "");
    };

    if (count <= 4) {
        /* Grid of up to 4 thumbnails */
        const grid = document.createElement("div"); grid.className = "image-group-grid"; grid.dataset.count = count;
        vids.forEach((v, idx) => {
            const item = document.createElement("div"); item.className = "ig-item";
            item.style.position = "relative";
            const thumbSrc = _vThumb(v);
            if (thumbSrc) {
                const imgEl = document.createElement("img");
                imgEl.src = thumbSrc; imgEl.alt = link.title || ""; imgEl.loading = "lazy";
                item.appendChild(imgEl);
            } else {
                const ph = document.createElement("div"); ph.style.cssText = "width:100%;height:100%;background:#1a1a1a;display:flex;align-items:center;justify-content:center";
                ph.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
                item.appendChild(ph);
            }
            const play = document.createElement("div"); play.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
            play.innerHTML = _playSvg(36);
            item.appendChild(play);
            item.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], viStart + idx); });
            grid.appendChild(item);
        });
        if (count > 1) {
            const firstImg = grid.querySelector("img");
            if (firstImg) {
                const lockHeight = () => {
                    const h = firstImg.offsetHeight;
                    if (h > 0) grid.style.height = `${h * (count === 4 ? 2 : 1)}px`;
                    else requestAnimationFrame(lockHeight);
                };
                firstImg.complete ? requestAnimationFrame(lockHeight)
                                  : firstImg.addEventListener("load", () => requestAnimationFrame(lockHeight), { once: true });
            }
        }
        card.appendChild(grid);
    } else {
        /* Cycling slideshow for > 4 videos — same as image groups */
        let curIdx = 0;
        let heightLocked = false;
        const wrap = document.createElement("div"); wrap.className = "ig-cycle-wrap";
        const imgEl = document.createElement("img"); imgEl.className = "ig-cycle-img";
        const firstThumb = _vThumb(vids[0]);
        imgEl.src = firstThumb; imgEl.alt = link.title || ""; imgEl.loading = "lazy";
        const playOverlay = document.createElement("div");
        playOverlay.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
        playOverlay.innerHTML = _playSvg(44);
        const counter = document.createElement("div"); counter.className = "ig-cycle-counter";
        counter.textContent = `1 / ${count}`;
        const goTo = (idx) => {
            curIdx = (idx + count) % count;
            imgEl.src = _vThumb(vids[curIdx]); imgEl.alt = link.title || "";
            counter.textContent = `${curIdx + 1} / ${count}`;
        };
        const prev = document.createElement("button"); prev.className = "ig-cycle-btn ig-cycle-prev"; prev.innerHTML = "&#8249;"; prev.title = "Previous";
        const next = document.createElement("button"); next.className = "ig-cycle-btn ig-cycle-next"; next.innerHTML = "&#8250;"; next.title = "Next";
        prev.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx - 1); });
        next.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx + 1); });
        wrap.addEventListener("click", e => { e.stopPropagation(); _mghOpenViewer([..._mghViewItems], viStart + curIdx); });
        const lockWrap = () => {
            const h = imgEl.offsetHeight;
            if (h > 0 && !heightLocked) {
                heightLocked = true; wrap.style.height = `${h}px`;
                imgEl.style.height = "100%"; imgEl.style.objectFit = "cover";
            } else if (!heightLocked) requestAnimationFrame(lockWrap);
        };
        imgEl.complete ? requestAnimationFrame(lockWrap)
                       : imgEl.addEventListener("load", () => requestAnimationFrame(lockWrap), { once: true });
        wrap.appendChild(imgEl); wrap.appendChild(playOverlay); wrap.appendChild(prev); wrap.appendChild(next); wrap.appendChild(counter);
        card.appendChild(wrap);
        let _autoTimer = setInterval(() => goTo(curIdx + 1), 3000);
        wrap.addEventListener("mouseenter", () => clearInterval(_autoTimer));
        wrap.addEventListener("mouseleave", () => { _autoTimer = setInterval(() => goTo(curIdx + 1), 3000); });
        new MutationObserver((_, obs) => { if (!document.contains(card)) { clearInterval(_autoTimer); obs.disconnect(); } })
            .observe(document.body, { childList: true, subtree: true });
    }
    const body = document.createElement("div"); body.className = "image-card-body";
    const _vgSrc = link.sourceUrl || link.url || "";
    body.innerHTML = `<span class="image-type-badge">VIDEO GROUP</span><span class="image-card-name">${escHtml(link.title || `${count} video${count !== 1 ? "s" : ""}`)}</span>${_vgSrc ? `<a class="card-source-link" href="${escHtml(_vgSrc)}" target="_blank" rel="noopener noreferrer" title="${link.sourceUrl ? "Go to source" : "Go to URL"}" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}`;
    card.appendChild(body);
    if (creator) { const el = document.createElement("div"); el.className = "image-card-creator"; el.title = `Creator: ${creator.title||""}`; el.innerHTML = `<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(creator.title||"")}</span>`; el.addEventListener("click", e=>{e.stopPropagation();_mghOpenCreatorPanel(creator);}); card.appendChild(el); }
    if (persons.length) { const el = document.createElement("div"); el.className = "image-card-person"; el.innerHTML = `<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(persons.map(p=>p.title).join(", "))}</span>`; el.addEventListener("click", e=>{e.stopPropagation();if(persons[0])_mghOpenCreatorPanel(persons[0]);}); card.appendChild(el); }
    card.appendChild(_mghCardActions(link));
    return card;
}

/* Feed card — TikTok-style swipeable video player */
function _mghVideoGroupFeedCard(link) {
    const vids = Array.isArray(link.videos) ? link.videos.filter(v => v?.url) : [];
    if (!vids.length) return null;

    let curIdx = 0;
    const card = document.createElement("div"); card.className = "feed-card feed-card--group"; card.dataset.id = link.id;

    const mediaWrap = document.createElement("div"); mediaWrap.className = "feed-card-media-wrap";

    const _buildThumbFallback = (v) => {
        const a = document.createElement("a");
        a.className = "feed-card-media feed-vg-player feed-vg-thumb-fallback";
        a.href = v.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.addEventListener("click", e => e.stopPropagation());
        if (v.thumb) {
            const img = document.createElement("img"); img.src = v.thumb; img.alt = "";
            img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            a.appendChild(img);
        }
        const play = document.createElement("div");
        play.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
        play.innerHTML = _playSvg(56);
        a.appendChild(play);
        return a;
    };

    function _buildPlayer(v) {
        const embed = _mghEmbed(v.url);
        if (embed?.type === "direct") {
            const vid = document.createElement("video");
            vid.className = "feed-card-media feed-vg-player"; vid.src = embed.src; vid.controls = true; vid.preload = "metadata"; vid.playsInline = true;
            vid.addEventListener("error", () => {
                vid.parentNode?.replaceChild(_buildThumbFallback(v), vid);
            }, { once: true });
            return vid;
        }
        if (embed) {
            const src = embed.src + (embed.src.includes("?") ? "&" : "?") + "enablejsapi=1";
            const iframe = document.createElement("iframe");
            iframe.className = "feed-card-media feed-vg-player"; iframe.src = src; iframe.allowFullscreen = true;
            iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            iframe.loading = "lazy"; iframe.dataset.embedType = embed.type;
            return iframe;
        }
        return _buildThumbFallback(v);
    }

    let playerEl = _buildPlayer(vids[0]);
    mediaWrap.appendChild(playerEl);
    card.appendChild(mediaWrap);

    /* Dot nav */
    const dotsEl = document.createElement("div"); dotsEl.className = "feed-card-slideshow-dots";
    if (vids.length > 1) {
        vids.forEach((_, i) => { const d = document.createElement("span"); d.className = "feed-card-slideshow-dot" + (i === 0 ? " active" : ""); dotsEl.appendChild(d); });
        card.appendChild(dotsEl);
    }

    const goTo = (idx) => {
        curIdx = (idx + vids.length) % vids.length;
        /* Pause current before switching */
        if (playerEl.tagName === "VIDEO") { playerEl.pause(); }
        else if (playerEl.tagName === "IFRAME") { _iframePause(playerEl); }
        mediaWrap.innerHTML = "";
        playerEl = _buildPlayer(vids[curIdx]);
        mediaWrap.appendChild(playerEl);
        dotsEl.querySelectorAll(".feed-card-slideshow-dot").forEach((d, i) => d.classList.toggle("active", i === curIdx));
    };

    if (vids.length > 1) {
        const prev = document.createElement("button"); prev.className = "ig-cycle-btn ig-cycle-prev"; prev.innerHTML = "&#8249;"; prev.title = "Previous";
        const next = document.createElement("button"); next.className = "ig-cycle-btn ig-cycle-next"; next.innerHTML = "&#8250;"; next.title = "Next";
        prev.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx - 1); });
        next.addEventListener("click", e => { e.stopPropagation(); goTo(curIdx + 1); });
        card.appendChild(prev); card.appendChild(next);
        let _sx = 0;
        card.addEventListener("touchstart", e => { _sx = e.touches[0].clientX; }, { passive: true });
        card.addEventListener("touchend", e => { const dx = e.changedTouches[0].clientX - _sx; if (Math.abs(dx) > 40) goTo(dx < 0 ? curIdx + 1 : curIdx - 1); }, { passive: true });
    }

    const creator = _mghFindCreatorFor(link);
    const overlay = document.createElement("div"); overlay.className = "feed-card-overlay";
    overlay.innerHTML = `<div class="feed-card-info">
        ${link.title ? `<div class="feed-card-title">${escHtml(link.title)}</div>` : ""}
        ${creator ? `<div class="feed-card-creator"><span class="feed-card-creator-name">${escHtml(creator.title||"")}</span></div>` : ""}
        <div class="feed-card-vg-count"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">video_library</span> ${vids.length} video${vids.length!==1?"s":""}</div>
    </div>`;
    overlay.querySelector(".feed-card-creator")?.addEventListener("click", e => { e.stopPropagation(); _mghOpenCreatorPanel(creator); });
    card.appendChild(overlay);
    card.appendChild(_mghCardActions(link));
    return card;
}

/* Open the shared viewer for video groups — reuses all nav, keyboard, dots */
function _mghOpenVideoGroupViewer(link, startIdx) {
    const vids = Array.isArray(link.videos) ? link.videos.filter(v => v?.url) : [];
    if (!vids.length) return;
    const items = vids.map(v => ({ type: "video", url: v.url, thumb: v.thumb || "", name: link.title || "" }));
    _mghOpenViewer(items, startIdx || 0);
}

/* ══════════ FEED VIDEO AUTOPLAY ══════════ */

function _iframePause(iframe) {
    const src = iframe.src || "";
    if (src.includes("youtube") || src.includes("youtu.be") || src.includes("youtube-nocookie")) {
        iframe.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":""}', "*");
    } else if (src.includes("vimeo")) {
        iframe.contentWindow?.postMessage('{"method":"pause"}', "*");
    }
}
function _iframePlay(iframe) {
    const src = iframe.src || "";
    if (src.includes("youtube") || src.includes("youtu.be") || src.includes("youtube-nocookie")) {
        iframe.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":""}', "*");
    } else if (src.includes("vimeo")) {
        iframe.contentWindow?.postMessage('{"method":"play"}', "*");
    }
}

/**
 * Sets up IntersectionObserver-based autoplay for all video/iframe elements
 * in a feed container. Videos play when ≥50% visible, pause when they leave.
 * Everything pauses when the tab loses focus.
 */
function _initFeedAutoplay(container) {
    if (!container) return;
    const obs = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const el = entry.target;
            if (entry.isIntersecting) {
                if (el.tagName === "VIDEO")  { el.play().catch(() => {}); }
                else if (el.tagName === "IFRAME") { _iframePlay(el); }
            } else {
                if (el.tagName === "VIDEO")  { el.pause(); }
                else if (el.tagName === "IFRAME") { _iframePause(el); }
            }
        });
    }, { threshold: 0.5 });

    container.querySelectorAll("video, iframe.feed-card-media, iframe.feed-vg-player").forEach(el => obs.observe(el));

    /* Also pause everything when the browser tab is hidden */
    const onVisibility = () => {
        if (document.hidden) {
            container.querySelectorAll("video").forEach(v => v.pause());
            container.querySelectorAll("iframe").forEach(f => _iframePause(f));
        }
    };
    document.addEventListener("visibilitychange", onVisibility);
    /* Clean up observer if the container is removed from the DOM */
    new MutationObserver((_, mo) => {
        if (!container.isConnected) { obs.disconnect(); mo.disconnect(); document.removeEventListener("visibilitychange", onVisibility); }
    }).observe(document.body, { childList: true, subtree: true });
}

/* ══════════ VIDEO-GROUP FORM HELPERS ══════════ */

function _addIgImageField(urlVal = "", nameVal = "") {
    const list = document.getElementById("link-ig-list"); if (!list) return;
    const row = document.createElement("div"); row.className = "link-vg-row";
    row.innerHTML = `
        <div class="link-vg-fields">
            <input type="url"  class="link-ig-url"  placeholder="https://…" value="${escHtml(urlVal)}">
            <input type="text" class="link-ig-name" placeholder="Caption (optional)" value="${escHtml(nameVal)}">
        </div>
        <button type="button" class="link-vg-remove ws-icon-btn" title="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    row.querySelector(".link-vg-remove").addEventListener("click", () => row.remove());
    list.appendChild(row);
}

function _initImageGroupForm() {
    document.getElementById("btn-add-ig-image")?.addEventListener("click", () => _addIgImageField());
}

function _openLinksSettings() {
    const inCat = _activeCat !== "all";
    const catName = inCat ? _activeCat : null;
    const cat = inCat ? _cats.find(c => c.name === catName) : null;
    const isMediaHub = cat?.prefab === "media";

    // ── Category context chip ──
    const ctxEl = document.getElementById("lgs-cat-context");
    const ctxReset = document.getElementById("lgs-cat-reset");
    if (ctxEl) {
        ctxEl.style.display = inCat ? "flex" : "none";
        ctxEl.querySelector(".lgs-cat-ctx-name").textContent = catName || "";
    }
    function _hasCatOverride() {
        return inCat && (_catPrefs[catName]?.layout || _catPrefs[catName]?.sort);
    }
    if (ctxReset) {
        ctxReset.style.display = _hasCatOverride() ? "" : "none";
        ctxReset.onclick = () => {
            if (inCat) {
                delete _catPrefs[catName];
                _saveCatPrefs();
            }
            ctxReset.style.display = "none";
            _applyLayout();
            document.querySelectorAll(".lgs-view-btn").forEach(b =>
                b.classList.toggle("active", b.dataset.layout === _activeLayout()));
            document.querySelectorAll(".lgs-sort-btn").forEach(b =>
                b.classList.toggle("active", b.dataset.sort === _activeSort()));
            _render();
        };
    }

    // ── View mode buttons ──
    // Media hubs support grid/list/feed; normal categories support grid/compact/list/rows.
    const MEDIA_MODES  = ["grid", "tiles", "list", "coverflow", "feed"];
    const NORMAL_MODES = ["grid", "compact", "list", "rows"];
    const currentMghLayout = isMediaHub && cat?.id ? (localStorage.getItem(`mghLayout_${cat.id}`) || "grid") : null;
    const currentLayout = isMediaHub ? currentMghLayout : _activeLayout();
    document.querySelectorAll(".lgs-view-btn").forEach(btn => {
        const mode = btn.dataset.layout;
        const allowed = isMediaHub ? MEDIA_MODES : NORMAL_MODES;
        btn.style.display = allowed.includes(mode) ? "" : "none";
        // "feed" is a transient fullscreen action, never the persisted active state
        btn.classList.toggle("active", mode !== "feed" && mode === currentLayout);
        btn.onclick = () => {
            if (isMediaHub && cat?.id) {
                if (mode === "feed") {
                    // Open shuffled fullscreen feed (doesn't persist as a layout)
                    const MEDIA_TYPES = ["image","3d-model","image-group","youtube-video","youtube-playlist","video","video-group"];
                    const allMedia = _links.filter(l => l.category === cat.name && MEDIA_TYPES.includes(l.type));
                    if (!allMedia.length) { toast("No images or videos to show in feed.", "info"); return; }
                    closeModal("modal-links-settings");
                    _openMghFeed(allMedia);
                    return;
                }
                localStorage.setItem(`mghLayout_${cat.id}`, mode);
            } else if (inCat) {
                _catPrefs[catName] = { ..._catPrefs[catName], layout: mode };
                _saveCatPrefs();
            } else {
                _layout = mode;
                try { localStorage.setItem("links_layout", _layout); } catch {}
            }
            if (ctxReset) ctxReset.style.display = _hasCatOverride() ? "" : "none";
            _applyLayout();
            document.querySelectorAll(".lgs-view-btn").forEach(b => b.classList.toggle("active", b === btn));
            _render();
        };
    });

    // ── Sort buttons ──
    document.querySelectorAll(".lgs-sort-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.sort === _activeSort());
        btn.onclick = () => {
            if (inCat) {
                _catPrefs[catName] = { ..._catPrefs[catName], sort: btn.dataset.sort };
                _saveCatPrefs();
            } else {
                _sortMode = btn.dataset.sort;
                try { localStorage.setItem("links_sort_mode", _sortMode); } catch {}
                // Sync hidden select element
                const sel = document.getElementById("links-sort-select");
                if (sel) sel.value = _sortMode;
            }
            if (ctxReset) ctxReset.style.display = _hasCatOverride() ? "" : "none";
            document.querySelectorAll(".lgs-sort-btn").forEach(b =>
                b.classList.toggle("active", b.dataset.sort === _activeSort()));
            _render();
        };
    });

    // ── DiceBear avatar style grid ──
    const grid = document.getElementById("links-dicebear-grid");
    if (grid) {
        grid.innerHTML = "";
        DICEBEAR_STYLES.forEach(s => {
            const btn = document.createElement("button");
            btn.className = "dicebear-style-btn" + (s.id === _dicebearStyle ? " active" : "");
            btn.title = s.label;
            btn.dataset.style = s.id;
            const previewUrl = `https://api.dicebear.com/10.x/${s.id}/svg?seed=preview`;
            btn.innerHTML = `<img src="${previewUrl}" width="48" height="48" loading="lazy" alt="${escHtml(s.label)}"><span>${escHtml(s.label)}</span>`;
            btn.addEventListener("click", async () => {
                _dicebearStyle = s.id;
                try { localStorage.setItem("links_dicebear_style", s.id); } catch {}
                grid.querySelectorAll(".dicebear-style-btn").forEach(b => b.classList.toggle("active", b.dataset.style === s.id));
                if (!_db || !_user?.uid || _adminOwnerUid) return;
                setDoc(refs.linkSettings(_db, _uid()), { dicebearStyle: s.id }, { merge: true }).catch(console.error);
                const toClean = _links.filter(l => (l.thumbUrl || "").includes("dicebear.com"));
                if (!toClean.length) return;
                const batch = writeBatch(_db);
                toClean.forEach(l => {
                    batch.update(doc(_db, "users", _uid(), "gallery-links", l.id), { thumbUrl: deleteField() });
                });
                await batch.commit().catch(console.error);
            });
            grid.appendChild(btn);
        });
    }

    // ── Section order (media hubs only) ──
    const soWrap    = document.getElementById("lgs-section-order-wrap");
    const soDivider = document.getElementById("lgs-section-order-divider");
    const soList    = document.getElementById("lgs-section-order");
    if (soWrap && soDivider && soList) {
        const show = isMediaHub && cat?.id;
        soWrap.style.display    = show ? "" : "none";
        soDivider.style.display = show ? "" : "none";
        if (show) {
            const _soCatId = cat.id;
            const SECTION_LABELS = {
                site: "Sites & Files", image: "Images & 3D", video: "Videos", people: "Creators & Characters",
            };
            const DEFAULT_ORDER = ["site", "image", "video", "people"];
            let order = (() => { try { return JSON.parse(localStorage.getItem(`mghOrder_${_soCatId}`) || "null"); } catch { return null; } })();
            if (!Array.isArray(order) || !order.length) order = DEFAULT_ORDER;
            order = order.map(k => (k === "creator" || k === "person") ? "people" : k);   // migrate legacy keys
            order = [...new Set([...order, ...DEFAULT_ORDER])];   // ensure all keys present

            const hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(`mghHidden_${_soCatId}`) || "[]")); } catch { return new Set(); } })();
            const _saveHidden = () => localStorage.setItem(`mghHidden_${_soCatId}`, JSON.stringify([...hidden]));

            let peopleOrder = (() => {
                try { const a = JSON.parse(localStorage.getItem(`mghPeopleOrder_${_soCatId}`) || "null");
                    return (Array.isArray(a) && a.length === 2 && a.includes("creator") && a.includes("person")) ? a : ["creator", "person"];
                } catch { return ["creator", "person"]; }
            })();
            const _savePeopleOrder = () => localStorage.setItem(`mghPeopleOrder_${_soCatId}`, JSON.stringify(peopleOrder));

            const PEOPLE_LABELS = { creator: "Creators", person: "Characters" };
            const _eyeSvg = isHidden => isHidden
                ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
                : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            const _toggleHidden = (k, paint) => () => {
                if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
                _saveHidden(); paint(); _render();
            };

            soList.innerHTML = "";
            order.forEach(key => {
                const isPeople = key === "people";
                const row = document.createElement("div");
                row.className = "lgs-so-row" + (hidden.has(key) ? " lgs-so-row--hidden" : "");
                row.dataset.key = key;
                row.innerHTML = `
                    <div class="lgs-so-main">
                        <span class="lgs-so-grip"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="15" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="19" r="1" fill="currentColor"/><circle cx="15" cy="19" r="1" fill="currentColor"/></svg></span>
                        <span class="lgs-so-name">${escHtml(SECTION_LABELS[key] || key)}</span>
                        <button class="lgs-so-eye" type="button" title="Show or hide"></button>
                    </div>
                    ${isPeople ? `<div class="lgs-so-people"></div>` : ""}`;

                const eyeBtn = row.querySelector(".lgs-so-eye");
                const paintEye = () => { row.classList.toggle("lgs-so-row--hidden", hidden.has(key)); eyeBtn.innerHTML = _eyeSvg(hidden.has(key)); };
                paintEye();
                eyeBtn.addEventListener("click", _toggleHidden(key, paintEye));

                if (isPeople) {
                    const sub = row.querySelector(".lgs-so-people");
                    peopleOrder.forEach(pk => {
                        const chip = document.createElement("div");
                        chip.className = "lgs-pc-chip" + (hidden.has(pk) ? " lgs-pc-chip--hidden" : "");
                        chip.dataset.key = pk;
                        chip.innerHTML = `<span class="lgs-pc-name">${PEOPLE_LABELS[pk]}</span><button class="lgs-pc-eye" type="button" title="Show or hide"></button>`;
                        const pcEye = chip.querySelector(".lgs-pc-eye");
                        const paintPc = () => { chip.classList.toggle("lgs-pc-chip--hidden", hidden.has(pk)); pcEye.innerHTML = _eyeSvg(hidden.has(pk)); };
                        paintPc();
                        pcEye.addEventListener("click", _toggleHidden(pk, paintPc));
                        sub.appendChild(chip);
                    });
                    _getSortable().then(Sortable => {
                        Sortable.create(sub, {
                            animation: 150,
                            direction: "horizontal",
                            draggable: ".lgs-pc-chip",
                            filter: ".lgs-pc-eye",
                            ghostClass: "sortable-ghost",
                            chosenClass: "sortable-chosen",
                            onEnd: () => {
                                peopleOrder = [...sub.querySelectorAll(".lgs-pc-chip")].map(c => c.dataset.key);
                                _savePeopleOrder();
                                _render();
                            }
                        });
                    });
                }

                soList.appendChild(row);
            });

            _getSortable().then(Sortable => {
                // Recreate each open so the onEnd closure targets the current hub
                if (soList._sortable) { try { soList._sortable.destroy(); } catch {} }
                soList._sortable = Sortable.create(soList, {
                    animation: 150,
                    draggable: ".lgs-so-row",
                    filter: ".lgs-so-eye, .lgs-pc-eye",
                    ghostClass: "sortable-ghost",
                    chosenClass: "sortable-chosen",
                    onEnd: () => {
                        const newOrder = [...soList.querySelectorAll(".lgs-so-row")].map(r => r.dataset.key);
                        localStorage.setItem(`mghOrder_${_soCatId}`, JSON.stringify(newOrder));
                        _render();
                    }
                });
            });
        }
    }

    // ── Coverflow options (media hubs only; each row gated by admin flags) ──
    const cfWrap    = document.getElementById("lgs-coverflow-wrap");
    const cfDivider = document.getElementById("lgs-coverflow-divider");
    if (cfWrap && cfDivider) {
        const showCf = isMediaHub && !!cat?.id && _gf("cfCustomize");
        cfWrap.style.display    = showCf ? "" : "none";
        cfDivider.style.display = showCf ? "" : "none";
        if (showCf) {
            // Style dropdown
            const cfStyle = document.getElementById("lgs-cf-style");
            if (cfStyle) {
                cfStyle.value = localStorage.getItem("mghCfStyle") || "coverflow";
                cfStyle.onchange = () => { localStorage.setItem("mghCfStyle", cfStyle.value); _render(); };
            }
            // checkbox rows: [inputId, rowId, storageKey, default-on?, admin-allow-flag]
            const cfRows = [
                ["lgs-cf-loop",     "lgs-cf-loop-row",     "mghCfLoop",       false, true],
                ["lgs-cf-reflect",  "lgs-cf-reflect-row",  "mghCfReflection", true,  _gf("cfReflection")],
                ["lgs-cf-autoplay", "lgs-cf-autoplay-row", "mghCfAutoplay",   false, _gf("cfAutoplay")],
                ["lgs-cf-explode",  "lgs-cf-explode-row",  "mghCfExplode",    true,  _gf("cfExplodeGroups")],
            ];
            cfRows.forEach(([inpId, rowId, key, defOn, allow]) => {
                const inp = document.getElementById(inpId);
                const row = document.getElementById(rowId);
                if (row) row.style.display = allow ? "" : "none";
                if (!inp) return;
                const cur = localStorage.getItem(key);
                inp.checked = cur == null ? defOn : cur !== "0";
                inp.onchange = () => { localStorage.setItem(key, inp.checked ? "1" : "0"); _render(); };
            });
            const cfSize = document.getElementById("lgs-cf-size");
            const cfSpacing = document.getElementById("lgs-cf-spacing");
            if (cfSize) {
                cfSize.value = parseInt(localStorage.getItem("mghCfSize") || "100", 10) || 100;
                cfSize.onchange = () => { localStorage.setItem("mghCfSize", cfSize.value); _render(); };
            }
            if (cfSpacing) {
                cfSpacing.value = parseInt(localStorage.getItem("mghCfSpacing") || "100", 10) || 100;
                cfSpacing.onchange = () => { localStorage.setItem("mghCfSpacing", cfSpacing.value); _render(); };
            }
        }
    }

    openModal("modal-links-settings");
}

function _initVideoGroupForm() {
    /* Inject option into the type <select> */
    const sel = document.getElementById("link-type-field");
    if (sel && !sel.querySelector('[value="video-group"]')) {
        const opt = document.createElement("option");
        opt.value = "video-group"; opt.textContent = "Video Group";
        const videoOpt = sel.querySelector('[value="video"]');
        if (videoOpt) videoOpt.after(opt); else sel.appendChild(opt);
    }

    /* Inject the section into the form */
    if (document.getElementById("link-video-group-section")) return;
    const form = document.getElementById("form-add-link");
    if (!form) return;
    const section = document.createElement("div");
    section.id = "link-video-group-section"; section.style.display = "none";
    section.innerHTML = `
        <div class="form-group">
            <label>Videos <span class="form-hint">(add as many as you want)</span></label>
            <div id="link-vg-list" class="link-vg-list"></div>
            <button type="button" id="btn-add-vg-video" class="ws-btn ws-btn-ghost ws-btn-sm" style="margin-top:6px">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add video
            </button>
        </div>`;
    const urlGroup = document.getElementById("link-url-group");
    if (urlGroup) urlGroup.parentNode.insertBefore(section, urlGroup.nextSibling);
    else form.appendChild(section);

    document.getElementById("btn-add-vg-video")?.addEventListener("click", () => _addVgVideoField());
    /* Ensure at least one row shows when the type is first selected */
}

function _addVgVideoField(urlVal = "", thumbVal = "") {
    const list = document.getElementById("link-vg-list"); if (!list) return;
    const row = document.createElement("div"); row.className = "link-vg-row";
    row.innerHTML = `
        <input type="url" class="link-vg-url"   placeholder="https://… (YouTube, video file…)" value="${escHtml(urlVal)}">
        <input type="url" class="link-vg-thumb" placeholder="Thumbnail URL (optional)"          value="${escHtml(thumbVal)}">
        <button type="button" class="link-vg-remove ws-icon-btn" title="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    row.querySelector(".link-vg-remove").addEventListener("click", () => row.remove());
    list.appendChild(row);
}

/* ══════════ COVERFLOW ("STAGE") VIEW ══════════
   A 3-D carousel: the focused item sits flat and front-and-centre while its
   neighbours fan out in perspective on either side. Unlike every other layout
   (which are all scrolling grids) this is a single immersive, navigable card
   deck — drive it with the mouse wheel, arrow keys, drag/swipe, or by clicking
   a side card. Clicking the centred card opens the existing fullscreen viewer. */

/* Pull a single representative thumbnail out of any media link. */
function _mghThumbForLink(link) {
    const isVideo = ["youtube-video", "youtube-playlist", "video", "video-group"].includes(link.type);
    if (link.type === "image-group") {
        const first = (Array.isArray(link.images) ? link.images.filter(i => i?.url) : [])[0];
        return { src: first?.url || link.thumbUrl || "", isVideo: false };
    }
    if (link.type === "video-group") {
        const first = (Array.isArray(link.videos) ? link.videos.filter(v => v?.url) : [])[0];
        return { src: first?.thumb || link.thumbUrl || "", isVideo: true };
    }
    if (isVideo) {
        let src = link.thumbUrl || "";
        if (!src) {
            const embed = _mghEmbed(link.url);
            const ytId = embed?.type === "youtube" ? embed.src.split("/embed/")[1]?.split("?")[0] : "";
            if (ytId) src = `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;
        }
        return { src, isVideo: true };
    }
    return { src: link.url || link.thumbUrl || "", isVideo: false }; // image / 3d-model
}

function _mghCoverflowView(container, items, cat, opts = {}) {
    container.innerHTML = "";
    _mghViewItems = [];
    // Any prior autoplay loop belongs to a now-detached render — kill it.
    if (_mghCfAutoTimer) { clearInterval(_mghCfAutoTimer); _mghCfAutoTimer = null; }
    const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'%3E%3Crect fill='%231a1a1a' width='4' height='3'/%3E%3C/svg%3E";

    const allow = opts.allow || { reflect: true, autoplay: true, explode: true, customize: true };
    let reflect  = opts.reflect  !== false && allow.reflect  !== false;
    let autoplay = !!opts.autoplay        && allow.autoplay !== false;
    let spacingPct = opts.spacingPct || 100;            // adjusted live by the size/spacing sliders
    const sizePct  = opts.sizePct  || 100;
    const style    = opts.style || "coverflow";          // coverflow | flat | wheel | stack | cube
    const loop     = !!opts.loop && items.length > 2;    // endless wrap-around

    const root  = document.createElement("div"); root.className = "mgh-cf-root mgh-cf-style-" + style;
    root.classList.toggle("mgh-cf-reflect-off", !reflect || style === "wheel");
    root.style.setProperty("--mgh-cf-scale", String(sizePct / 100));
    const stage = document.createElement("div"); stage.className = "mgh-cf-stage";
    const track = document.createElement("div"); track.className = "mgh-cf-track";
    stage.appendChild(track);

    const cards = [];
    items.forEach((link, i) => {
        const { src, isVideo } = _mghThumbForLink(link);
        const viewerSrc = link.type === "image-group"
            ? src
            : (link.type === "video-group" ? (link.videos?.[0]?.thumb || src) : src);
        if (isVideo) _mghViewItems.push({ type: "thumb-video", src: viewerSrc || "", name: link.title || "", url: link.url });
        else         _mghViewItems.push({ type: "image",       src: viewerSrc || "", name: link.title || "" });

        const card = document.createElement("div");
        card.className = "mgh-cf-card";
        card.dataset.idx = i;
        card.innerHTML = `
            <div class="mgh-cf-frame">
                ${src
                    ? `<img class="mgh-cf-img" src="${escHtml(src)}" alt="${escHtml(link.title || "")}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">`
                    : `<div class="mgh-cf-noimg">${isVideo ? _playSvg(46) : `<span class="material-symbols-outlined">image</span>`}</div>`}
                ${isVideo && src ? `<div class="mgh-cf-play">${_playSvg(48)}</div>` : ""}
            </div>`;
        track.appendChild(card);
        cards.push(card);
    });

    // Controls / chrome
    const prevBtn = document.createElement("button"); prevBtn.className = "mgh-cf-nav mgh-cf-prev"; prevBtn.setAttribute("aria-label", "Previous");
    prevBtn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
    const nextBtn = document.createElement("button"); nextBtn.className = "mgh-cf-nav mgh-cf-next"; nextBtn.setAttribute("aria-label", "Next");
    nextBtn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
    stage.appendChild(prevBtn);
    stage.appendChild(nextBtn);

    const meta = document.createElement("div"); meta.className = "mgh-cf-meta";
    meta.innerHTML = `<div class="mgh-cf-caption"></div><div class="mgh-cf-counter"></div>`;
    const caption = meta.querySelector(".mgh-cf-caption");
    const counter = meta.querySelector(".mgh-cf-counter");

    root.appendChild(stage);
    root.appendChild(meta);
    container.appendChild(root);

    // ── State + layout ──
    const STORE = `mghCfIndex_${cat.id || cat.name}`;
    let index = parseInt(localStorage.getItem(STORE) || "", 10);
    if (!Number.isFinite(index) || index < 0 || index >= items.length) index = 0;

    function layout() {
        const n   = items.length;
        const gap = spacingPct / 100;
        cards.forEach((card, i) => {
            // Circular (shortest-path) offset when looping, so cards wrap around the ends
            let off = i - index;
            if (loop) { if (off > n / 2) off -= n; else if (off < -n / 2) off += n; }
            const abs  = Math.abs(off);
            const sign = Math.sign(off);
            if (abs > 6) {
                card.style.opacity = "0";
                card.style.pointerEvents = "none";
                card.style.transform = `translate(-50%, -50%) translateX(${sign * 900}px) rotateY(${-sign * 60}deg)`;
                return;
            }
            let x = 0, y = 0, z = 0, rotY = 0, rotZ = 0, sc = 1, op = 1, bright = true;
            if (style === "flat") {
                // Flat filmstrip — centred card pops, neighbours shrink & fade, no tilt
                x  = off * 150 * gap;
                sc = off === 0 ? 1 : 0.74;
                z  = off === 0 ? 0 : -80;
                op = abs > 4 ? 0 : (off === 0 ? 1 : 0.5);
            } else if (style === "wheel") {
                // Cards fanned along a downward arc, like a hand of cards
                x    = off * 132 * gap;
                y    = abs * abs * 7;
                rotZ = off * 7;
                z    = -abs * 26;
                sc   = off === 0 ? 1 : 0.9;
                op   = abs > 5 ? 0 : (off === 0 ? 1 : 0.78);
            } else if (style === "stack") {
                // Deck — side cards stack behind the centre with a slight skew
                x    = off === 0 ? 0 : sign * (56 + (abs - 1) * 16) * gap;
                z    = -abs * 64;
                rotY = off === 0 ? 0 : -sign * 9;
                sc   = off === 0 ? 1 : Math.max(0.6, 1 - abs * 0.07);
                op   = abs > 4 ? 0 : (off === 0 ? 1 : 0.92);
            } else if (style === "cube") {
                // Strong rotation + tight spacing for a turning-cube feel
                x    = off === 0 ? 0 : sign * (150 + (abs - 1) * 40) * gap;
                rotY = off === 0 ? 0 : -sign * 72;
                z    = off === 0 ? 0 : -abs * 70 - 40;
                sc   = off === 0 ? 1 : 0.9;
                op   = abs > 4 ? 0 : (off === 0 ? 1 : 0.7);
            } else {
                // Classic coverflow — side-fanned with strong perspective
                x    = off === 0 ? 0 : sign * (190 + (abs - 1) * 62) * gap;
                rotY = off === 0 ? 0 : -sign * 52;
                z    = off === 0 ? 0 : -abs * 42 - 70;
                sc   = off === 0 ? 1 : 0.82;
                op   = abs > 5 ? 0 : (off === 0 ? 1 : 0.62);
            }
            card.style.transform = `translate(-50%, -50%) translateX(${x}px) translateY(${y}px) translateZ(${z}px) rotateY(${rotY}deg) rotateZ(${rotZ}deg) scale(${sc})`;
            card.style.opacity     = String(op);
            card.style.zIndex      = String(100 - abs);
            card.style.pointerEvents = op === 0 ? "none" : "auto";
            card.style.filter      = off === 0 || !bright ? "none" : "brightness(0.62)";
            card.classList.toggle("is-center", off === 0);
        });
        caption.textContent = items[index]?.title || "Untitled";
        counter.textContent = `${index + 1} / ${items.length}`;
        localStorage.setItem(STORE, String(index));
    }

    const len = items.length;
    const go = (delta) => {
        let n = index + delta;
        if (loop) n = (n % len + len) % len;
        else n = Math.min(len - 1, Math.max(0, n));
        if (n !== index) { index = n; layout(); }
    };
    const goto = (n) => { if (n !== index && n >= 0 && n < len) { index = n; layout(); } };

    prevBtn.addEventListener("click", () => go(-1));
    nextBtn.addEventListener("click", () => go(1));

    cards.forEach((card, i) => card.addEventListener("click", () => {
        if (i === index) _mghOpenViewer([..._mghViewItems], index); // centred → open viewer
        else goto(i);
    }));

    // Wheel — vertical or horizontal both navigate (debounced via threshold)
    let wheelAcc = 0, wheelLock = false;
    stage.addEventListener("wheel", e => {
        e.preventDefault();
        if (wheelLock) return;
        wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(wheelAcc) >= 40) {
            go(wheelAcc > 0 ? 1 : -1);
            wheelAcc = 0; wheelLock = true;
            setTimeout(() => { wheelLock = false; }, 110);
        }
    }, { passive: false });

    // Drag / swipe — window listeners live only for the duration of a drag
    let dragX = null, dragMoved = false;
    const onMove = e => {
        if (dragX == null) return;
        const cx = (e.touches ? e.touches[0].clientX : e.clientX);
        const dx = cx - dragX;
        if (Math.abs(dx) > 60) { go(dx < 0 ? 1 : -1); dragX = cx; dragMoved = true; }
    };
    const onUp = () => {
        dragX = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
    };
    stage.addEventListener("mousedown", e => {
        dragX = e.clientX; dragMoved = false;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });
    stage.addEventListener("touchstart", e => { dragX = e.touches[0].clientX; dragMoved = false; }, { passive: true });
    stage.addEventListener("touchmove", onMove, { passive: true });
    stage.addEventListener("touchend", () => { dragX = null; });
    // Swallow the click that ends a drag so it doesn't open the viewer
    stage.addEventListener("click", e => { if (dragMoved) { e.stopPropagation(); dragMoved = false; } }, true);

    // Keyboard — single shared handler, ignored when typing or when detached
    if (_mghCfKeyHandler) document.removeEventListener("keydown", _mghCfKeyHandler);
    const onKey = e => {
        if (!document.body.contains(stage)) return;
        if (document.getElementById("mgh-viewer")?.classList.contains("open")) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.key === "ArrowLeft")  { e.preventDefault(); go(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
        else if (e.key === "Enter")  { e.preventDefault(); _mghOpenViewer([..._mghViewItems], index); }
        else if (e.key === "Home")   { e.preventDefault(); goto(0); }
        else if (e.key === "End")    { e.preventDefault(); goto(items.length - 1); }
    };
    _mghCfKeyHandler = onKey;
    document.addEventListener("keydown", onKey);

    // ── Autoplay (auto-advance, ping-pong at the ends) ──
    let autoDir = 1;
    const stopAuto = () => { if (_mghCfAutoTimer) { clearInterval(_mghCfAutoTimer); _mghCfAutoTimer = null; } };
    const startAuto = () => {
        stopAuto();
        if (!autoplay || items.length < 2) return;
        _mghCfAutoTimer = setInterval(() => {
            if (!document.body.contains(stage)) { stopAuto(); return; }
            if (document.getElementById("mgh-viewer")?.classList.contains("open")) return;
            if (loop) { go(1); return; }          // endless: always advance & wrap
            if (index >= items.length - 1) autoDir = -1;
            else if (index <= 0) autoDir = 1;
            go(autoDir);
        }, 2600);
    };
    // Pause while the pointer is on the stage so users can look without fighting it
    stage.addEventListener("mouseenter", stopAuto);
    stage.addEventListener("mouseleave", () => { if (autoplay) startAuto(); });

    container.addEventListener("ws:destroy", () => {
        onUp();
        stopAuto();
        if (_mghCfKeyHandler === onKey) { document.removeEventListener("keydown", onKey); _mghCfKeyHandler = null; }
    }, { once: true });

    layout();
    startAuto();
}

/* ══════════ MEDIA HUB VIEW ══════════ */

function _renderMediaHub(body, cat) {
    body.innerHTML = "";
    const catLinks = _links.filter(l => {
        if (l.category === cat.name) return true;
        // Auto-created creators may be missing their category field — include them
        // if they are referenced by an item that IS in this category.
        if (!l.category && (l.type === "creator" || l.type === "youtube-channel"))
            return _links.some(m => m.category === cat.name && m.creatorId === l.id);
        return false;
    });

    // Per-hub persisted state
    let _mghLayout = localStorage.getItem(`mghLayout_${cat.id}`) || "grid";
    let _mghGridScale = parseInt(localStorage.getItem(`mghGridScale_${cat.id}`) || "200", 10);
    let _mghSearch = _search || "";
    let _mghSectionOrder = (() => { try { return JSON.parse(localStorage.getItem(`mghOrder_${cat.id}`) || "null") || null; } catch { return null; } })();
    let _mghFeedIds = null; // stable shuffled ID list for feed mode

    function _shuffleArr(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }

    const CREATOR_TYPES = ["creator", "youtube-channel"];
    const PERSON_TYPES  = ["person"];
    const IMAGE_TYPES   = ["image", "3d-model", "image-group"];
    const VIDEO_TYPES   = ["youtube-video", "youtube-playlist", "video", "video-group"];

    const hub = document.createElement("div"); hub.className = "media-gallery-hub";

    /* ── View catalogue (admin-gateable per user via feature flags) ── */
    const VIEW_DEFS = [
        { key: "grid",      flag: "viewGrid",      title: "Grid",      svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>` },
        { key: "tiles",     flag: "viewTiles",     title: "Tiles",     svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="16" y="2" width="6" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/><rect x="16" y="9" width="6" height="5" rx="1"/><rect x="2" y="16" width="5" height="6" rx="1"/><rect x="9" y="16" width="5" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/></svg>` },
        { key: "list",      flag: "viewList",      title: "List",      svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="6" height="5" rx="1"/><line x1="11" y1="6" x2="22" y2="6"/><line x1="11" y1="8" x2="18" y2="8"/><rect x="2" y="12" width="6" height="5" rx="1"/><line x1="11" y1="14" x2="22" y2="14"/><line x1="11" y1="16" x2="18" y2="16"/></svg>` },
        { key: "coverflow", flag: "viewCoverflow", title: "Coverflow", svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="6" width="6" height="12" rx="1"/><path d="M5 8v8" stroke-linecap="round"/><path d="M19 8v8" stroke-linecap="round"/><path d="M2 10v4" stroke-linecap="round"/><path d="M22 10v4" stroke-linecap="round"/></svg>` },
    ];
    const _viewFlag = { grid: "viewGrid", tiles: "viewTiles", list: "viewList", feed: "viewFeed", coverflow: "viewCoverflow" };
    const _viewEnabled = (layout) => _gf(_viewFlag[layout] || "viewGrid");
    // If the persisted layout has since been disabled for this user, fall back.
    if (!_viewEnabled(_mghLayout)) {
        _mghLayout = ["grid", "tiles", "list", "coverflow", "feed"].find(_viewEnabled) || "grid";
    }

    // Toolbar
    const toolbar = document.createElement("div"); toolbar.className = "mgh-toolbar";
    const viewBtnsHtml = VIEW_DEFS.filter(v => _gf(v.flag)).map(v =>
        `<button class="ws-btn ws-btn-ghost ws-btn-icon mgh-layout-btn ${_mghLayout === v.key ? "active" : ""}" title="${v.title}" data-layout="${v.key}">${v.svg}</button>`
    ).join("");
    toolbar.innerHTML = `
        <span class="mgh-title">
            <span class="material-symbols-outlined">perm_media</span>
            ${escHtml(cat.name)}
        </span>
        <div class="mgh-toolbar-actions">
            <label class="mgh-scale-wrap" title="Grid size" ${["grid","tiles"].includes(_mghLayout) ? "" : 'style="display:none"'}>
                <span class="material-symbols-outlined">photo_size_select_large</span>
                <input type="range" class="mgh-scale-slider" min="130" max="340" step="10" value="${_mghGridScale}">
            </label>
            ${viewBtnsHtml}
        </div>`;
    const addBtn = document.createElement("button"); addBtn.className = "ws-btn ws-btn-accent"; addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => { _openForm(null); setTimeout(() => { const cf = document.getElementById("link-cat-field"); if (cf) cf.value = cat.name; }, 80); });
    const autoLinkAllBtn = document.createElement("button");
    autoLinkAllBtn.className = "ws-btn ws-btn-ghost";
    autoLinkAllBtn.title = "Auto-link all images & videos to characters by matching title";
    autoLinkAllBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Auto-link all`;
    autoLinkAllBtn.addEventListener("click", () => _mghAutoLinkAll(catLinks));
    if (_gf("actionAutolink")) toolbar.appendChild(autoLinkAllBtn);

    const importBtn = document.createElement("button");
    importBtn.className = "ws-btn ws-btn-ghost";
    importBtn.title = "Import media from a Workspace project";
    importBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="21" x2="12" y2="7"/><line x1="4" y1="4" x2="20" y2="4"/></svg>Import`;
    importBtn.addEventListener("click", () => _mghImportFromWorkspace(cat));
    if (_gf("actionImport")) toolbar.appendChild(importBtn);
    if (_gf("actionAdd")) toolbar.appendChild(addBtn);
    hub.appendChild(toolbar);

    const mghBody = document.createElement("div"); mghBody.className = `mgh-body media-body${_mghLayout === "list" ? " layout-list" : ""}${_mghLayout === "tiles" ? " layout-tiles" : ""}${_mghLayout === "feed" ? " layout-feed" : ""}${_mghLayout === "coverflow" ? " layout-coverflow" : ""}`;
    mghBody.style.setProperty("--mgh-grid-col", `${_mghGridScale}px`);
    hub.appendChild(mghBody);

    /* ── Mobile speed-dial FAB ──
       On phones the toolbar action buttons get cut off, so they collapse into
       this expanding circle. Items just re-trigger the real (hidden) controls. */
    const fabWrap = document.createElement("div");
    fabWrap.className = "mgh-fab-wrap";
    const _fabViewItems = [
        { act: "grid",      flag: "viewGrid",      label: "Grid view",      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>` },
        { act: "tiles",     flag: "viewTiles",     label: "Tiles view",     svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="16" y="2" width="6" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/><rect x="16" y="9" width="6" height="5" rx="1"/><rect x="2" y="16" width="5" height="6" rx="1"/><rect x="9" y="16" width="5" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/></svg>` },
        { act: "list",      flag: "viewList",      label: "List view",      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="6" height="5" rx="1"/><line x1="11" y1="6" x2="22" y2="6"/><line x1="11" y1="8" x2="18" y2="8"/><rect x="2" y="12" width="6" height="5" rx="1"/><line x1="11" y1="14" x2="22" y2="14"/><line x1="11" y1="16" x2="18" y2="16"/></svg>` },
        { act: "feed",      flag: "viewFeed",      label: "Phone view",     svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="10" y1="18" x2="14" y2="18"/></svg>` },
        { act: "coverflow", flag: "viewCoverflow", label: "Coverflow view", svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="6" width="6" height="12" rx="1"/><path d="M5 8v8" stroke-linecap="round"/><path d="M19 8v8" stroke-linecap="round"/><path d="M2 10v4" stroke-linecap="round"/><path d="M22 10v4" stroke-linecap="round"/></svg>` },
    ];
    const _fabActionItems = [
        { act: "autolink", flag: "actionAutolink", label: "Auto-link all", cls: "", svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
        { act: "import",   flag: "actionImport",   label: "Import",        cls: "", svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="21" x2="12" y2="7"/><line x1="4" y1="4" x2="20" y2="4"/></svg>` },
        { act: "add",      flag: "actionAdd",      label: "Add media",     cls: " mgh-fab-item--accent", svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>` },
    ];
    const _fabItemHtml = (it) => `<button class="mgh-fab-item${it.cls || ""}" data-act="${it.act}" role="menuitem">${it.svg}<span>${it.label}</span></button>`;
    const _fabViews   = _fabViewItems.filter(it => _gf(it.flag));
    const _fabActions = _fabActionItems.filter(it => _gf(it.flag));
    fabWrap.innerHTML = `
        <div class="mgh-fab-menu" role="menu">
            ${_fabViews.map(_fabItemHtml).join("")}
            ${_fabViews.length && _fabActions.length ? `<div class="mgh-fab-sep"></div>` : ""}
            ${_fabActions.map(_fabItemHtml).join("")}
        </div>
        <button class="mgh-fab" aria-label="Hub actions" aria-expanded="false">
            <svg class="mgh-fab-plus" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>`;
    hub.appendChild(fabWrap);

    const fabBtn = fabWrap.querySelector(".mgh-fab");
    fabBtn.addEventListener("click", () => {
        const open = fabWrap.classList.toggle("open");
        fabBtn.setAttribute("aria-expanded", String(open));
    });
    const _fabOutside = e => {
        if (!fabWrap.contains(e.target)) { fabWrap.classList.remove("open"); fabBtn.setAttribute("aria-expanded", "false"); }
    };
    document.addEventListener("click", _fabOutside);
    hub.addEventListener("ws:destroy", () => document.removeEventListener("click", _fabOutside), { once: true });

    fabWrap.querySelectorAll(".mgh-fab-item").forEach(item => item.addEventListener("click", () => {
        const act = item.dataset.act;
        fabWrap.classList.remove("open"); fabBtn.setAttribute("aria-expanded", "false");
        if (act === "grid" || act === "tiles" || act === "list" || act === "coverflow") {
            toolbar.querySelector(`.mgh-layout-btn[data-layout="${act}"]`)?.click();
        } else if (act === "feed") {
            const allMedia = catLinks.filter(l => [...IMAGE_TYPES, ...VIDEO_TYPES].includes(l.type));
            if (!allMedia.length) { toast("No images or videos to show in feed.", "info"); return; }
            _openMghFeed(allMedia);
        } else if (act === "autolink") { autoLinkAllBtn.click(); }
        else if (act === "import")   { importBtn.click(); }
        else if (act === "add")      { addBtn.click(); }
    }));

    body.appendChild(hub);

    // Grid-size slider (only meaningful in grid view)
    const scaleWrap = toolbar.querySelector(".mgh-scale-wrap");
    toolbar.querySelector(".mgh-scale-slider")?.addEventListener("input", e => {
        _mghGridScale = parseInt(e.target.value, 10);
        mghBody.style.setProperty("--mgh-grid-col", `${_mghGridScale}px`);
        localStorage.setItem(`mghGridScale_${cat.id}`, String(_mghGridScale));
    });

    // Layout toggle buttons
    toolbar.querySelectorAll(".mgh-layout-btn").forEach(btn => btn.addEventListener("click", () => {
        if (btn.dataset.layout === "feed") {
            const allMedia = catLinks.filter(l => [...["image","3d-model","image-group"], ...["youtube-video","youtube-playlist","video","video-group"]].includes(l.type));
            if (!allMedia.length) { toast("No images or videos to show in feed.", "info"); return; }
            _openMghFeed(allMedia);
            return;
        }
        _mghLayout = btn.dataset.layout;
        localStorage.setItem(`mghLayout_${cat.id}`, _mghLayout);
        mghBody.classList.toggle("layout-list",  _mghLayout === "list");
        mghBody.classList.toggle("layout-tiles", _mghLayout === "tiles");
        mghBody.classList.toggle("layout-coverflow", _mghLayout === "coverflow");
        mghBody.classList.toggle("layout-feed", false);
        if (scaleWrap) scaleWrap.style.display = ["grid","tiles"].includes(_mghLayout) ? "" : "none";
        toolbar.querySelectorAll(".mgh-layout-btn").forEach(b => b.classList.toggle("active", b === btn));
        _renderSections();
    }));

    // Empty state
    if (!catLinks.length) {
        mghBody.innerHTML = `<div class="links-empty">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" style="opacity:.35"><rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 19 16 19 16 8"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="1 17 5 12 9 14.5 12 11 16 15"/></svg>
            <p>No media yet. Click <strong>+ Add</strong> to get started.</p>
        </div>`;
        return;
    }

    const DEFAULT_ORDER = ["site", "image", "video", "people"];
    let _order = _mghSectionOrder || DEFAULT_ORDER;
    // Collapse the old split creator/person keys into the merged "people" section
    _order = _order.map(k => (k === "creator" || k === "person") ? "people" : k);
    _order = [...new Set([..._order, ...DEFAULT_ORDER])]; // ensure all keys present, dedupe

    // Sections the user has chosen to hide for this hub ("people"/"creator"/"person"/...)
    let _mghHidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(`mghHidden_${cat.id}`) || "[]")); } catch { return new Set(); } })();
    // Which side comes first inside the merged people section
    let _mghPeopleOrder = (() => {
        try { const a = JSON.parse(localStorage.getItem(`mghPeopleOrder_${cat.id}`) || "null");
            return (Array.isArray(a) && a.length === 2 && a.includes("creator") && a.includes("person")) ? a : ["creator", "person"];
        } catch { return ["creator", "person"]; }
    })();

    const _scrollKey = `mgh_scroll_${cat.id || cat.name}`;
    // Persist scroll position continuously
    const _onScroll = () => sessionStorage.setItem(_scrollKey, String(Math.round(window.scrollY)));
    window.addEventListener("scroll", _onScroll, { passive: true });
    hub.addEventListener("ws:destroy", () => window.removeEventListener("scroll", _onScroll), { once: true });

    const _restoreScroll = () => {
        const t = Number(sessionStorage.getItem(_scrollKey) || 0);
        if (t > 0) window.scrollTo({ top: t, behavior: "instant" });
    };

    function _renderSections() {
        // Schedule scroll restore at multiple timings: after DOM build, after first paint, after images start loading
        requestAnimationFrame(_restoreScroll);
        setTimeout(_restoreScroll, 50);
        setTimeout(_restoreScroll, 300);
        mghBody.innerHTML = "";
        _mghViewItems = [];
        const search = _mghSearch;
        const filtered = search
            ? catLinks.filter(l => (l.title || "").toLowerCase().includes(search) || (l.url || "").toLowerCase().includes(search) || (l.description || "").toLowerCase().includes(search))
            : catLinks;
        const visible = _sorted(filtered);

        if (!visible.length && search) { mghBody.innerHTML = `<div class="ws-placeholder">No matches.</div>`; return; }

        let creators = visible.filter(l => CREATOR_TYPES.includes(l.type));
        let persons  = visible.filter(l => PERSON_TYPES.includes(l.type));
        let images   = visible.filter(l => IMAGE_TYPES.includes(l.type));
        let videos   = visible.filter(l => VIDEO_TYPES.includes(l.type));
        let sites    = visible.filter(l => ![...CREATOR_TYPES, ...PERSON_TYPES, ...IMAGE_TYPES, ...VIDEO_TYPES].includes(l.type));

        // Section gating — admin can hide whole media sections per user.
        if (!_gf("sectionImages")) images = [];
        if (!_gf("sectionVideos")) videos = [];
        if (!_gf("sectionSites"))  sites  = [];
        if (!_gf("sectionPeople")) { creators = []; persons = []; }

        // Feed mode — portrait scroll-snap cards (Shorts style)
        if (_mghLayout === "feed") {
            const allMedia = [...images, ...videos];
            if (!allMedia.length) { mghBody.innerHTML = `<div class="ws-placeholder">No images or videos in this hub yet.</div>`; return; }
            const currentIds = new Set(allMedia.map(l => l.id));
            if (!_mghFeedIds) {
                _mghFeedIds = _shuffleArr(allMedia.map(l => l.id));
            } else {
                _mghFeedIds = _mghFeedIds.filter(id => currentIds.has(id));
                const seen = new Set(_mghFeedIds);
                const newIds = allMedia.filter(l => !seen.has(l.id)).map(l => l.id);
                _mghFeedIds = [..._shuffleArr(newIds), ..._mghFeedIds];
            }
            const idMap = Object.fromEntries(allMedia.map(l => [l.id, l]));
            const feedGrid = document.createElement("div"); feedGrid.className = "shorts-grid";
            _mghFeedIds.map(id => idMap[id]).filter(Boolean).forEach(l => {
                let c;
                if (l.type === "image-group")       c = _mghImageGroupFeedCard(l);
                else if (l.type === "video-group")  c = _mghVideoGroupFeedCard(l);
                else                                c = _mghFeedCard(l);
                if (c) feedGrid.appendChild(c);
            });
            mghBody.appendChild(feedGrid);
            _initFeedAutoplay(feedGrid);
            return;
        }

        // Coverflow mode — 3-D card deck of all images + videos.
        if (_mghLayout === "coverflow") {
            // Admin gates for the per-option features
            const allowReflect  = _gf("cfReflection");
            const allowAutoplay = _gf("cfAutoplay");
            const allowExplode  = _gf("cfExplodeGroups");
            const allowCustom   = _gf("cfCustomize");
            // End-user preferences (within what the admin allows). null = default.
            const pref = (k, d) => { const v = localStorage.getItem(k); return v == null ? d : v; };
            const explode  = allowExplode  && pref("mghCfExplode", "1") !== "0";
            const reflect  = allowReflect  && pref("mghCfReflection", "1") !== "0";
            const autoplay = allowAutoplay && pref("mghCfAutoplay", "0") === "1";
            const sizePct    = parseInt(pref("mghCfSize", "100"), 10)    || 100;
            const spacingPct = parseInt(pref("mghCfSpacing", "100"), 10) || 100;
            const style      = pref("mghCfStyle", "coverflow");
            const loop       = pref("mghCfLoop", "0") === "1";

            // Like tiles, groups are exploded so every image/video gets its own card.
            const cfImages = explode ? images.flatMap(l => l.type === "image-group"
                ? (Array.isArray(l.images) ? l.images : []).filter(i => i?.url).map((img, idx) =>
                    ({ ...l, type: "image", url: img.url, sourceUrl: l.sourceUrl, title: img.name || l.title || "", _fromGroup: l.id, _gi: idx }))
                : [l]) : images;
            const cfVideos = explode ? videos.flatMap(l => l.type === "video-group"
                ? (Array.isArray(l.videos) ? l.videos : []).filter(v => v?.url).map((v, idx) =>
                    ({ ...l, type: "video", url: v.url, thumbUrl: v.thumb || "", title: l.title || "", _fromGroup: l.id, _gi: idx }))
                : [l]) : videos;
            const allMedia = [...cfImages, ...cfVideos];
            if (!allMedia.length) { mghBody.innerHTML = `<div class="ws-placeholder">No images or videos in this hub yet.</div>`; return; }
            _mghCoverflowView(mghBody, allMedia, cat, {
                reflect, autoplay, sizePct, spacingPct, explode, style, loop,
                allow: { reflect: allowReflect, autoplay: allowAutoplay, explode: allowExplode, customize: allowCustom },
                rerender: _renderSections,
            });
            return;
        }

        const isTiles = _mghLayout === "tiles";

        // In tiles view, explode groups into individual image/video tiles (shown one after another)
        let imageItems = images, videoItems = videos;
        if (isTiles) {
            imageItems = images.flatMap(l => l.type === "image-group"
                ? (Array.isArray(l.images) ? l.images : []).filter(i => i?.url).map((img, idx) =>
                    ({ ...l, type: "image", url: img.url, sourceUrl: l.sourceUrl, title: img.name || l.title || "", _fromGroup: l.id, _gi: idx }))
                : [l]);
            videoItems = videos.flatMap(l => l.type === "video-group"
                ? (Array.isArray(l.videos) ? l.videos : []).filter(v => v?.url).map((v, idx) =>
                    ({ ...l, type: "video", url: v.url, thumbUrl: v.thumb || "", title: l.title || "", _fromGroup: l.id, _gi: idx }))
                : [l]);
        }

        const SECS = {
            image:   { label: "Images & 3D",   items: imageItems, gridClass: "media-grid",    buildCard: l => l.type === "image-group" ? _mghImageGroupCard(l) : _mghImageCard(l) },
            video:   { label: "Videos",        items: videoItems, gridClass: "media-grid",    buildCard: l => l.type === "video-group" ? _mghVideoGroupCard(l) : _mghVideoCard(l, { thumbnailOnly: isTiles }) },
            site:    { label: "Sites & Files", items: sites,      gridClass: "db-sites-grid", buildCard: _mghSiteCard },
        };

        _order.forEach(key => {
            if (_mghHidden.has(key)) return;
            if (key === "people") {
                const sec = _makeMghPeopleSection(creators, persons);
                if (sec) mghBody.appendChild(sec);
                return;
            }
            const sec = SECS[key]; if (!sec || !sec.items.length) return;
            mghBody.appendChild(_makeMghSubGroup(key, sec.label, sec.items, sec.gridClass, sec.buildCard));
        });
    }

    /* Apply crop to the small 34px circle avatar using object-fit/position/transform.
       This is safer than _acmApplyToClip's pixel math for a tiny fixed-size clip. */
    function _applyPeopleAvatarCrop(cardEl, link) {
        const raw = link.thumbUrl || "";
        const isBroken = raw.includes("unavatar.io") || raw.includes("ui-avatars.com") || raw.includes("dicebear.com");
        if (!raw || isBroken) return;
        const cx   = link.thumbCropCx   ?? 50;
        const cy   = link.thumbCropCy   ?? 50;
        const zoom = link.thumbCropZoom ?? 1;
        const imgEl = cardEl.querySelector(".creator-avatar");
        if (!imgEl) return;
        const apply = () => {
            imgEl.style.position       = "absolute";
            imgEl.style.top            = "0";
            imgEl.style.left           = "0";
            imgEl.style.width          = "100%";
            imgEl.style.height         = "100%";
            imgEl.style.maxWidth       = "none";
            imgEl.style.maxHeight      = "none";
            imgEl.style.objectFit      = "cover";
            imgEl.style.objectPosition = `${cx}% ${cy}%`;
            imgEl.style.transform      = zoom !== 1 ? `scale(${zoom})` : "";
            imgEl.style.transformOrigin = `${cx}% ${cy}%`;
        };
        apply();
        if (!imgEl.complete) imgEl.addEventListener("load", apply, { once: true });
    }

    /* Build one creators-grid (with drag handles + sortable under manual sort) */
    function _buildPeopleGrid(items) {
        const grid = document.createElement("div"); grid.className = "creators-grid mgh-people-grid";
        const manual = _activeSort() === "manual";
        items.forEach(l => {
            const c = _mghCreatorCard(l);
            _applyPeopleAvatarCrop(c, l);
            grid.appendChild(c);
        });
        if (manual) { grid.classList.add("mgh-sortable"); _mghMakeSortable(grid); }
        return grid;
    }

    /* Merged Creators + Characters section. Column order follows _mghPeopleOrder
       and each side can be hidden individually ("creator" / "person" in _mghHidden). */
    function _makeMghPeopleSection(creators, persons) {
        const map = {
            creator: { key: "creator", title: "Creators",   items: creators },
            person:  { key: "person",  title: "Characters", items: persons  },
        };
        const cols = _mghPeopleOrder.map(k => map[k]).filter(c => c && !_mghHidden.has(c.key));
        if (!cols.length) return null;
        if (!cols.some(c => c.items.length)) return null;

        const total = cols.reduce((n, c) => n + c.items.length, 0);
        const label = cols.length === 2 ? "Creators &amp; Characters"
                    : (cols[0].key === "creator" ? "Creators" : "Characters");

        const sg = document.createElement("div"); sg.className = "db-sub-group mgh-section"; sg.dataset.typeKey = "people";
        const hdr = document.createElement("div"); hdr.className = "db-sub-header"; hdr.style.cursor = "grab"; hdr.title = "Drag to reorder";
        hdr.innerHTML = `<span class="db-sub-label">${label}</span><div class="db-sub-line"></div><span class="mgh-section-count">${total}</span>`;
        sg.appendChild(hdr);

        const split = document.createElement("div"); split.className = "mgh-people-split";
        split.style.gridTemplateColumns = cols.length === 2 ? "1fr 1fr" : "1fr";
        const mkCol = (title, items) => {
            const col = document.createElement("div"); col.className = "mgh-people-col";
            const h = document.createElement("div"); h.className = "mgh-people-col-head"; h.textContent = title;
            col.appendChild(h);
            if (items.length) col.appendChild(_buildPeopleGrid(items));
            else { const e = document.createElement("div"); e.className = "mgh-people-empty"; e.textContent = "Nothing here yet"; col.appendChild(e); }
            return col;
        };
        cols.forEach(c => split.appendChild(mkCol(c.title, c.items)));
        sg.appendChild(split);

        _wireSectionDrag(sg, hdr);
        return sg;
    }

    function _makeMghSubGroup(key, label, items, gridClass, buildCard) {
        const sg = document.createElement("div"); sg.className = "db-sub-group mgh-section"; sg.dataset.typeKey = key;
        const hdr = document.createElement("div"); hdr.className = "db-sub-header"; hdr.style.cursor = "grab"; hdr.title = "Drag to reorder";
        hdr.innerHTML = `<span class="db-sub-label">${label}</span><div class="db-sub-line"></div><span class="mgh-section-count">${items.length}</span>`;
        sg.appendChild(hdr);
        const grid = document.createElement("div"); grid.className = gridClass;
        const manual = _activeSort() === "manual";
        items.forEach(l => {
            const c = buildCard(l);
            grid.appendChild(c);
        });
        sg.appendChild(grid);

        // Per-item drag-to-reorder (manual sort only)
        if (manual) {
            grid.classList.add("mgh-sortable");
            _mghMakeSortable(grid);
        }

        _wireSectionDrag(sg, hdr);
        return sg;
    }

    /* Section header drag-to-reorder wiring (shared by all section types) */
    function _wireSectionDrag(sg, hdr) {
        hdr.addEventListener("mousedown", () => sg.setAttribute("draggable", "true"));
        sg.addEventListener("mouseleave", () => sg.setAttribute("draggable", "false"));
        sg.addEventListener("mouseup", () => sg.setAttribute("draggable", "false"));
        sg.addEventListener("dragstart", e => { window._mghDragSg = sg; e.dataTransfer.effectAllowed = "move"; setTimeout(() => sg.style.opacity = "0.4", 0); _asStart(mghBody); });
        sg.addEventListener("dragover", e => {
            e.preventDefault(); e.dataTransfer.dropEffect = "move";
            if (!window._mghDragSg) return;
            _asMove(e.clientY);
            const afterEl = [...mghBody.querySelectorAll(".db-sub-group:not([style*='opacity: 0.4'])")].reduce((closest, child) => {
                const box = child.getBoundingClientRect(); const offset = e.clientY - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) return { offset, element: child };
                return closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
            if (afterEl == null) mghBody.appendChild(window._mghDragSg); else mghBody.insertBefore(window._mghDragSg, afterEl);
        });
        sg.addEventListener("dragend", () => {
            sg.setAttribute("draggable", "false"); sg.style.opacity = "1"; _asStop();
            if (window._mghDragSg) {
                window._mghDragSg = null;
                const domKeys = [...mghBody.querySelectorAll(".db-sub-group")].map(el => el.dataset.typeKey);
                // Keep hidden / non-rendered sections (not in the DOM) at the end of the order
                _order = [...domKeys, ..._order.filter(k => !domKeys.includes(k))];
                _mghSectionOrder = _order;
                localStorage.setItem(`mghOrder_${cat.id}`, JSON.stringify(_order));
            }
        });
    }

    _renderSections();
}

/* ── Import from Workspace ── */

async function _mghImportFromWorkspace(cat) {
    let projects = [];
    try {
        const snap = await getDocs(refs.projects(_db, _uid()));
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
        const projSnap = await getDoc(refs.project(_db, _uid(), projId));
        if (projSnap.exists()) catId = projSnap.data().sourceCategoryId ?? projId;
    } catch { /* fall back to projId */ }

    let wsLinks = [];
    try {
        const snap = await getDocs(query(refs.links(_db, _uid()),
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
            url:         l.url  || l.profileUrl || "",
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
            const ref = await addDoc(refs.galleryLinks(_db, _uid()), mapDoc(l, remapId));
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
            await addDoc(refs.galleryLinks(_db, _uid()), mapDoc(l, remapId));
            if (l.url) existingUrls.add(l.url);
            count++;
        } catch (err) { console.error("[import] media:", err); }
    }

    toast(`Imported ${count} item${count !== 1 ? "s" : ""} into "${cat.name}".`, "success");
}

function _applyLayout() {
    const layout = _activeLayout();
    const body = document.getElementById("links-body");
    if (body) {
        body.classList.toggle("layout-list",    layout === "list");
        body.classList.toggle("layout-compact", layout === "compact");
        body.classList.toggle("layout-grid",    layout === "grid");
        body.classList.toggle("layout-rows",    layout === "rows");
    }
    // Sync settings modal view buttons if open.
    // Media-hub categories store their layout separately (mghLayout_<id>), so the
    // active highlight must follow that, not the normal-category _activeLayout().
    const _activeCatObj = _cats.find(c => c.name === _activeCat);
    const _modalLayout = (_activeCatObj?.prefab === "media" && _activeCatObj.id)
        ? (localStorage.getItem(`mghLayout_${_activeCatObj.id}`) || "grid")
        : layout;
    document.querySelectorAll(".lgs-view-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.layout === _modalLayout)
    );
}

function _render() {
    _syncCatsFromLinks();
    _renderCatBar();
    const body = document.getElementById("links-body");
    if (!body) return;
    // Notify any media hub teardown listeners before wiping content
    body.querySelector(".media-gallery-hub")?.dispatchEvent(new Event("ws:destroy"));

    // Mark app container with active prefab for CSS-driven UI hiding
    const _appEl = document.getElementById("app-links");
    const _activePrefab = _cats.find(c => c.name === _activeCat)?.prefab ?? null;
    _appEl?.setAttribute("data-prefab", _activePrefab ?? "");

    // Set data-view for context-aware header state
    const _isAll = _activeCat === "all" && !_search;
    _appEl?.setAttribute("data-view", _isAll ? "all" : "cat");
    const _addLbl = document.getElementById("btn-add-link")?.querySelector(".btn-label");
    if (_addLbl) _addLbl.textContent = _isAll ? "New Category" : "Add Link";
    _applyLayout();

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
    el.draggable = _activeSort() === "manual";

    if (_activeSort() === "manual") {
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
        ${_showThumbs ? `<a class="link-card-banner" href="${safeHref}" target="_blank" rel="noopener noreferrer">${bannerContent}</a>` : ""}
        <a class="link-card-main link-card-main--compact" href="${safeHref}" target="_blank" rel="noopener noreferrer">
            <div class="link-card-favicon-wrap">${faviconHtml}</div>
            <div class="link-card-info">
                <div class="link-card-title">${escHtml(link.title || domain || link.url)}</div>
                <div class="link-card-url">${escHtml(_shortUrl(link.url))}</div>
                ${_showDesc && link.description ? `<div class="link-card-desc">${escHtml(link.description)}</div>` : ""}
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
                ${_showDesc && link.description ? `<div class="link-card-desc">${escHtml(link.description)}</div>` : ""}
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
            _showConfirmScreen(_catObj);
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
        await deleteDoc(doc(_db, "users", _uid(), "gallery-links", id));
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
        await updateDoc(doc(_db, "users", _uid(), "gallery-links", id), {
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
            updateDoc(doc(_db, "users", _uid(), "gallery-links", draggedId), { sortOrder: tOrder, updatedAt: serverTimestamp() }),
            updateDoc(doc(_db, "users", _uid(), "gallery-links", targetId),  { sortOrder: dOrder, updatedAt: serverTimestamp() }),
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
                        <span>Personal folder <span style="font-weight:400;color:var(--text-muted)">(asks before opening)</span></span>
                    </label>
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

    overlay.querySelector("#link-cat-lock-field").addEventListener("change", () => {});
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
        if (_lf) { _lf.checked = !!cat.locked; }
    } else {
        setModalTitle("modal-link-cat", "New Category");
        document.getElementById("btn-link-cat-submit").textContent = "Create";
        document.getElementById("link-cat-id-field").value = "";
        if (prefabField) prefabField.value = "";
        // Reset prefab buttons to "Standard" selected
        document.querySelectorAll("#link-cat-prefabs .lc-prefab").forEach(b =>
            b.classList.toggle("active", b.dataset.prefab === ""));
        const _lf2 = document.getElementById("link-cat-lock-field");
        if (_lf2) { _lf2.checked = false; }
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
    const lockData = { locked: lockChecked, passwordHash: null, credentialId: null };

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
                updateDoc(doc(_db, "users", _uid(), "gallery-links", l.id), { category: name, updatedAt: serverTimestamp() })
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
            updateDoc(doc(_db, "users", _uid(), "gallery-links", l.id), { category: deleteField() })
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
        // Pre-fill image group rows
        if (link.type === "image-group") {
            const igList = document.getElementById("link-ig-list");
            if (igList) {
                igList.innerHTML = "";
                (link.images || []).forEach(img => _addIgImageField(img.url || "", img.name || ""));
                if (!link.images?.length) _addIgImageField();
            }
            const _sf2 = document.getElementById("link-source-field");
            if (_sf2) _sf2.value = link.sourceUrl || "";
        }
        // Pre-fill video group rows
        if (link.type === "video-group") {
            const vgList = document.getElementById("link-vg-list");
            if (vgList) {
                vgList.innerHTML = "";
                (link.videos || []).forEach(v => _addVgVideoField(v.url, v.thumb || ""));
                if (!link.videos?.length) _addVgVideoField();
            }
        }
        // Attribution
        if (creatorSel && link.creatorId) {
            creatorSel.value = link.creatorId;
            if (creatorSel.selectedIndex < 0) creatorSel.value = ""; // ID not in options → show "— none —"
        }
        if (personSel) {
            const selIds = link.personIds || (link.personId ? [link.personId] : []);
            Array.from(personSel.options).forEach(o => { o.selected = selIds.includes(o.value); });
        }
        document.getElementById("link-batch-group").style.display = "none";
        document.getElementById("link-batch-field").value = "";
        _updateBatchHint();
        _updateTypeHint(link.type || "website");
        // Load crop values
        _acmCx   = link.thumbCropCx   ?? 50;
        _acmCy   = link.thumbCropCy   ?? 50;
        _acmZoom = link.thumbCropZoom ?? 1;
        const _zs = document.getElementById("acm-zoom");
        if (_zs) _zs.value = Math.round(_acmZoom * 100);
        // Show preview if avatar type + has thumb
        const _isAv = ["creator", "person", "youtube-channel"].includes(link.type || "");
        const _prevDiv = document.getElementById("link-thumb-preview");
        const _prevCircle = document.getElementById("link-thumb-preview-circle");
        const _prevImg  = document.getElementById("link-thumb-preview-img");
        if (_isAv && link.thumbUrl && _prevDiv && _prevImg) {
            _prevImg.src = link.thumbUrl;
            _acmApplyCSS(_prevCircle, _acmCx, _acmCy, _acmZoom);
            _prevDiv.style.display = "";
        } else if (_prevDiv) { _prevDiv.style.display = "none"; }
    } else {
        setModalTitle("modal-link", "Add Link");
        document.getElementById("btn-link-submit").textContent = "Add Link";
        document.getElementById("link-id-field").value = "";
        const preselect = (_activeCat !== "all" && _activeCat !== "_uncat") ? _activeCat : "";
        _populateCatSelect(preselect);
        document.getElementById("link-batch-group").style.display = "";
        document.getElementById("link-batch-field").value = "";
        _updateBatchHint();
        _updateTypeHint("website");
        // Clear dynamic group lists so stale rows from previous edit don't show
        const _igList = document.getElementById("link-ig-list"); if (_igList) _igList.innerHTML = "";
        const _vgList = document.getElementById("link-vg-list"); if (_vgList) _vgList.innerHTML = "";
        // Reset crop
        _acmCx = 50; _acmCy = 50; _acmZoom = 1;
        const _zs2 = document.getElementById("acm-zoom"); if (_zs2) _zs2.value = 100;
        const _prevDiv2 = document.getElementById("link-thumb-preview");
        if (_prevDiv2) _prevDiv2.style.display = "none";
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
    "viaplay.com", "ruutu.fi", "tv.nrk.no", "play.tv2.no",
    "svtplay.se", "areena.yle.fi", "plex.tv", "jellyfin", "emby.media",
    "pstream",
];

function _detectTypeFromUrl(rawUrl) {
    const url = String(rawUrl || "").trim().toLowerCase();
    if (!url) return "website";
    if (url.includes("youtube.com/channel") || url.includes("youtube.com/@") ||
        url.includes("youtube.com/c/") || url.includes("youtube.com/user/")) {
        return "youtube-channel";
    }
    if (url.includes("youtube.com/playlist") ||
        (url.includes("youtube.com/watch") && url.includes("list="))) {
        return "youtube-playlist";
    }
    if (url.includes("youtube.com/watch") || url.includes("youtu.be/") ||
        url.includes("youtube.com/shorts/") || url.includes("youtube.com/live/")) {
        return "youtube-video";
    }
    if (_STREAMING_DOMAINS.some(d => url.includes(d))) {
        return "streaming-service";
    }
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/.test(url)) {
        return "video";
    }
    // Other recognised video hosts → generic video (so they get video-card styling)
    if (/(?:^|\/\/|\.)(?:vimeo\.com|player\.vimeo\.com|dailymotion\.com|dai\.ly|streamable\.com)\//.test(url)) {
        return "video";
    }
    if (/\.(jpg|jpeg|png|gif|webp|svg|avif|bmp)(\?|#|$)/.test(url)) {
        return "image";
    }
    if (/\.(3mf|stl|obj|step|gltf|glb)(\?|#|$)/.test(url) ||
        /makerworld\.bambulab\.com|printables\.com|thingiverse\.com|thangs\.com/.test(url)) {
        return "3d-model";
    }
    return "website";
}

function _autoDetectType() {
    // Don't overwrite a type the user has already chosen
    const typeField = document.getElementById("link-type-field");
    if (typeField.value && typeField.value !== "website") return;

    const url = document.getElementById("link-url-field").value.trim();
    const type = _detectTypeFromUrl(url);
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

    const isCreator    = type === "creator" || type === "youtube-channel";
    const isPerson     = type === "person";
    const isImage      = type === "image" || type === "3d-model";
    const isVideo      = type === "youtube-video" || type === "youtube-playlist" || type === "video";
    const isImageGroup = type === "image-group";
    const isVideoGroup = type === "video-group";

    const urlGroup  = document.getElementById("link-url-group");
    const igSection = document.getElementById("link-image-group-section");
    const vgSection = document.getElementById("link-video-group-section");
    if (urlGroup)  urlGroup.style.display  = (isImageGroup || isVideoGroup) ? "none" : "";
    if (igSection) {
        igSection.style.display = isImageGroup ? "" : "none";
        if (isImageGroup && !document.getElementById("link-ig-list")?.children.length) {
            _addIgImageField();
        }
    }
    if (vgSection) {
        vgSection.style.display = isVideoGroup ? "" : "none";
        if (isVideoGroup && !document.getElementById("link-vg-list")?.children.length) {
            _addVgVideoField(); // ensure at least one empty row shows
        }
    }

    if (urlLabel)    urlLabel.textContent    = isImage ? "Image URL *" : "URL *";
    if (thumbGroup)  thumbGroup.style.display  = (isCreator || isPerson || isVideo || type === "3d-model") ? "" : "none";
    if (thumbLabel)  thumbLabel.textContent  = (isCreator || isPerson) ? "Avatar URL" : "Thumbnail URL";
    if (sourceGroup) sourceGroup.style.display = (isImage || isImageGroup || isVideo || isVideoGroup) ? "" : "none";
    if (badgeGroup)  badgeGroup.style.display  = (isCreator) ? "" : "none";
    if (descGroup)   descGroup.style.display   = (isCreator || isPerson) ? "" : "none";
    if (attrGroup)   attrGroup.style.display   = (isImage || isVideo || isImageGroup || isVideoGroup) ? "" : "none";
    // Batch URL textarea makes no sense for image-group — hide it and show source URL instead
    const batchGroup = document.getElementById("link-batch-group");
    if (batchGroup) {
        if (isImageGroup) {
            batchGroup.style.display = "none";
        } else {
            const isNew = !document.getElementById("link-id-field")?.value;
            batchGroup.style.display = isNew ? "" : "none";
        }
    }
}

function _extractTitleFromUrl(url) {
    try {
        const path = new URL(url).pathname;
        // pstream / TMDB slug: /media/tmdb-movie-12345-the-dark-knight
        const m = path.match(/tmdb-(?:movie|tv)-\d+-(.+?)(?:\/|$)/);
        if (m) return m[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
        const parts = path.split("/").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        const prev = parts[parts.length - 2] || "";
        if (/^\d+$/.test(last) && prev) {
            return prev
                .replace(/-\d+$/, "")
                .replace(/[-_]/g, " ")
                .replace(/\b\w/g, c => c.toUpperCase())
                .trim();
        }
        // Fallback: last meaningful path segment
        const seg = last;
        if (!seg || /^\d+$/.test(seg)) return "";
        return seg.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).split(".")[0].trim();
    } catch { return ""; }
}

function _siteDisplayName(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        const parts = host.split(".");
        const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
        return core.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
    } catch {
        return "";
    }
}

async function _fetchTitleFromStreamingPage(url) {
    try {
    const html = await _fetchHtmlThroughProxy(url, 7000);
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

async function _fetchPagePreviewMeta(url) {
    try {
        const html = await _fetchHtmlThroughProxy(url, 8000);
        if (!html) return null;

        const pick = (...patterns) => {
            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match?.[1]) return match[1].trim();
            }
            return "";
        };

        const title = pick(
            /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
            /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i,
            /<title[^>]*>([^<]+)<\/title>/i,
        ).replace(/\s*[|\u2013\u2014].*$/, "").trim();

        let imageUrl = pick(
            /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
            /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
            /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["']/i,
        );

        if (!imageUrl) {
            imageUrl = pick(
                /<img[^>]+class=["'][^"']*img-content[^"']*["'][^>]+src=["']([^"']+)["']/i,
                /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*img-content[^"']*["']/i,
                /<img[^>]+class=["'][^"']*(?:main|hero|primary)[^"']*["'][^>]+src=["']([^"']+)["']/i,
                /<img[^>]+src=["']([^"']+contents\/[^"']+\.(?:jpg|jpeg|png|webp|gif|avif))["']/i,
                /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif|avif))["']/i,
            );
        }

        return {
            title,
            imageUrl: _resolveSafeUrl(url, imageUrl),
        };
    } catch {
        return null;
    }
}

async function _buildBatchLinkData(url, category, preferredType = "") {
    const type = preferredType || _detectTypeFromUrl(url);
    const detectedType = _detectTypeFromUrl(url);
    const meta = await _fetchPagePreviewMeta(url);
    const parsedCreator = _mghParseCreatorUrl(url);
    const isDirectImage = detectedType === "image";
    const derivedTitle = _extractTitleFromUrl(url);
    const siteName = _siteDisplayName(url);

    let thumbUrl = "";
    if (type === "image") {
        thumbUrl = isDirectImage ? url : (meta?.imageUrl || "");
    } else if (meta?.imageUrl) {
        thumbUrl = meta.imageUrl;
    } else if (type === "youtube-channel" && parsedCreator?.platform && parsedCreator?.username) {
        thumbUrl = await _mghCreatorAvatar(parsedCreator.platform, parsedCreator.username, url);
    }
    /* thum.io removed: it returns HTML for adult/blocked sites which causes ORB errors.
       Site cards show a favicon+domain fallback when no og:image is available. */

    const finalUrl = (type === "image" && !isDirectImage && meta?.imageUrl) ? meta.imageUrl : url;
    const finalTitle = (type === "image" && !isDirectImage && derivedTitle)
        ? `${derivedTitle}${siteName ? ` - ${siteName}` : ""}`
        : (meta?.title || derivedTitle || _domain(url) || url).trim();

    const data = {
        url: finalUrl,
        title: finalTitle,
        type,
        category,
        description: "",
        thumbUrl: thumbUrl && _isSafeUrl(thumbUrl) ? thumbUrl : "",
        pinned: false,
        sortOrder: Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    };

    if (type === "image" && !isDirectImage && finalUrl !== url) {
        data.sourceUrl = url;
    }

    if (type === "youtube-channel" && parsedCreator?.username) {
        data.username = parsedCreator.username;
        data.platform = parsedCreator.platform;
    }

    return data;
}

async function _importBatchUrls(urls, category, preferredType = "") {
    const uniqueUrls = [...new Set(urls.filter(_isSafeUrl))];
    if (!uniqueUrls.length) {
        toast("Paste at least one valid http/https URL", "error");
        return false;
    }

    let added = 0;
    let failed = 0;
    for (const url of uniqueUrls) {
        try {
            const data = await _buildBatchLinkData(url, category, preferredType);
            data.sortOrder = Date.now() + added;
            await addDoc(refs.galleryLinks(_db, _uid()), data);
            added++;
        } catch (err) {
            console.error("[links] batch import failed:", url, err);
            failed++;
        }
    }

    if (added) {
        toast(`Imported ${added} link${added === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`, failed ? "" : "success");
        return true;
    }

    toast("Could not import the dropped URLs", "error");
    return false;
}

async function _onFormSubmit(e) {
    e.preventDefault();
    const editId = document.getElementById("link-id-field").value;
    const selectedType = document.getElementById("link-type-field").value || "website";
    const batchField = document.getElementById("link-batch-field");
    const batchUrls = !editId
        ? _extractUrlsFromText(`${document.getElementById("link-url-field")?.value || ""}\n${batchField?.value || ""}`)
        : [];

    if (!editId && batchUrls.length > 1) {
        const category = document.getElementById("link-cat-field").value.trim();
        const preferredType = selectedType === "website" ? "" : selectedType;
        const imported = await _importBatchUrls(batchUrls, category, preferredType);
        if (imported) {
            closeModal("modal-link");
            _editId = null;
        }
        return;
    }

    // Handle image-group separately — stores images[] array, no single URL
    if (selectedType === "image-group") {
        const imgs = [];
        document.querySelectorAll("#link-ig-list .link-ig-url").forEach(inp => {
            const u = inp.value.trim();
            const n = inp.closest(".link-vg-row")?.querySelector(".link-ig-name")?.value.trim() || "";
            if (u && _isSafeUrl(u)) imgs.push({ url: u, ...(n ? { name: n } : {}) });
        });
        if (!imgs.length) { toast("Add at least one image URL", "error"); return; }
        const _igSrc  = document.getElementById("link-source-field")?.value.trim();
        const _igCVal = document.getElementById("link-creator-field")?.value || null;
        const _igPSel = document.getElementById("link-person-field");
        const _igPIds = _igPSel ? Array.from(_igPSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
        const igData = {
            type:      "image-group",
            title:     document.getElementById("link-title-field").value.trim(),
            category:  document.getElementById("link-cat-field").value.trim(),
            images:    imgs,
            creatorId: _igCVal,
            personIds: _igPIds,
            personId:  _igPIds[0] || null,
            updatedAt: serverTimestamp(),
            ...(_igSrc && _isSafeUrl(_igSrc) ? { sourceUrl: _igSrc } : {}),
        };
        // Auto-detect creator from source URL (same logic as regular images)
        if (!igData.creatorId && _igSrc) {
            const _igParsed = _mghParseCreatorUrl(_igSrc);
            if (_igParsed && _igParsed.platform !== "other" && _igParsed.username) {
                const _igExisting = _links.find(l =>
                    (l.type === "creator" || l.type === "youtube-channel") &&
                    (l.username || "").toLowerCase() === _igParsed.username.toLowerCase() &&
                    (l.platform || _mghParseCreatorUrl(l.url || "")?.platform) === _igParsed.platform
                );
                if (_igExisting) {
                    igData.creatorId = _igExisting.id;
                } else {
                    const _igProfileUrls = {
                        youtube: `https://www.youtube.com/@${_igParsed.username}`,
                        twitter: `https://x.com/${_igParsed.username}`,
                        instagram: `https://www.instagram.com/${_igParsed.username}`,
                        tiktok: `https://www.tiktok.com/@${_igParsed.username}`,
                        twitch: `https://www.twitch.tv/${_igParsed.username}`,
                    };
                    const _igCData = {
                        title: _igParsed.username, url: _igProfileUrls[_igParsed.platform] || _igSrc,
                        type: "creator", category: igData.category,
                        username: _igParsed.username, platform: _igParsed.platform,
                        thumbUrl: await _mghCreatorAvatar(_igParsed.platform, _igParsed.username, _igProfileUrls[_igParsed.platform] || _igSrc),
                        badgeLabel: "", badgeColor: "", createdAt: serverTimestamp(),
                    };
                    const _igDocRef = await addDoc(refs.galleryLinks(_db, _uid()), _igCData);
                    igData.creatorId = _igDocRef.id;
                    toast(`Creator @${_igParsed.username} auto-added.`);
                }
            }
        }
        try {
            if (editId) {
                await updateDoc(doc(_db, "users", _uid(), "gallery-links", editId), igData);
            } else {
                igData.createdAt = serverTimestamp();
                await addDoc(refs.galleryLinks(_db, _uid()), igData);
            }
            closeModal("modal-link");
            _editId = null;
            toast(editId ? "Group updated" : "Group added", "success");
        } catch (err) {
            console.error(err);
            toast("Error saving group", "error");
        }
        return;
    }

    // Handle video-group — stores videos[] array
    if (selectedType === "video-group") {
        const vids = [...document.querySelectorAll("#link-vg-list .link-vg-row")].map(row => {
            const u = row.querySelector(".link-vg-url")?.value.trim()   || "";
            const t = row.querySelector(".link-vg-thumb")?.value.trim() || "";
            return { url: u, ...(t && _isSafeUrl(t) ? { thumb: t } : {}) };
        }).filter(v => v.url && _isSafeUrl(v.url));
        if (!vids.length) { toast("Add at least one video URL", "error"); return; }
        const _vgCVal = document.getElementById("link-creator-field")?.value || null;
        const _vgPSel = document.getElementById("link-person-field");
        const _vgPIds = _vgPSel ? Array.from(_vgPSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
        const _vgSrcRaw = document.getElementById("link-source-field")?.value.trim() || "";
        const _vgSrc    = (_vgSrcRaw && _isSafeUrl(_vgSrcRaw)) ? _vgSrcRaw : "";
        const vgData = {
            type:      "video-group",
            title:     document.getElementById("link-title-field").value.trim(),
            category:  document.getElementById("link-cat-field").value.trim(),
            videos:    vids,
            ...(_vgSrc ? { sourceUrl: _vgSrc } : editId ? { sourceUrl: deleteField() } : {}),
            creatorId: _vgCVal,
            personIds: _vgPIds,
            personId:  _vgPIds[0] || null,
            updatedAt: serverTimestamp(),
        };
        try {
            if (editId) {
                await updateDoc(doc(_db, "users", _uid(), "gallery-links", editId), vgData);
            } else {
                vgData.createdAt = serverTimestamp();
                await addDoc(refs.galleryLinks(_db, _uid()), vgData);
            }
            closeModal("modal-link");
            _editId = null;
            toast(editId ? "Video group updated" : "Video group added", "success");
        } catch (err) {
            console.error(err);
            toast("Error saving video group", "error");
        }
        return;
    }

    const url = document.getElementById("link-url-field").value.trim();
    const _fType = selectedType;
    if (!_isSafeUrl(url) && _fType !== "image" && _fType !== "3d-model" && _fType !== "person") {
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

    if (isCreator || isPerson) {
        data.thumbCropCx   = _acmCx;
        data.thumbCropCy   = _acmCy;
        data.thumbCropZoom = _acmZoom;
    }

    if (isCreator) {
        data.badgeLabel = document.getElementById("link-badge-label-field")?.value.trim() || "";
        data.badgeColor = document.getElementById("link-badge-color-field")?.value || "";
        // Auto-parse URL for platform/username/avatar when adding a creator
        if (url) {
            const parsed = _mghParseCreatorUrl(url);
            if (parsed && parsed.platform !== "other" && parsed.username) {
                data.username = parsed.username;
                data.platform = parsed.platform;
                if (!data.thumbUrl) data.thumbUrl = await _mghCreatorAvatar(parsed.platform, parsed.username, url);
            }
        }
    }
    if (isImage || isVideo) {
        const sv = _safeUrl(document.getElementById("link-source-field")?.value);
        // deleteField() is only valid on updateDoc — never on addDoc. For new docs
        // we simply omit an empty sourceUrl instead of trying to delete it.
        if (sv) data.sourceUrl = sv;
        else if (editId) data.sourceUrl = deleteField();
    }
    if (isImage || isVideo) {
        // Creator attribution
        const cVal = document.getElementById("link-creator-field")?.value || "";
        data.creatorId = cVal || null;
        // Person attribution (multi-select)
        const pSel = document.getElementById("link-person-field");
        data.personIds = pSel ? Array.from(pSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
        data.personId  = data.personIds[0] || null; // back-compat

        // Auto-detect creator — for images use sourceUrl; for videos try url then sourceUrl
        if (!data.creatorId) {
            const sourceUrl = isVideo ? (url || (typeof data.sourceUrl === "string" ? data.sourceUrl : "")) : (typeof data.sourceUrl === "string" ? data.sourceUrl : "");
            const altUrl   = isVideo ? (typeof data.sourceUrl === "string" ? data.sourceUrl : "") : "";
            const _tryAutoCreator = async (tryUrl) => {
                if (!tryUrl) return false;
                const parsed = _mghParseCreatorUrl(tryUrl);
                if (!parsed || parsed.platform === "other" || !parsed.username) return false;
                const existing = _links.find(l =>
                    (l.type === "creator" || l.type === "youtube-channel") &&
                    (l.username === parsed.username || _mghParseCreatorUrl(l.url || "")?.username === parsed.username) &&
                    (l.platform || _mghParseCreatorUrl(l.url || "")?.platform) === parsed.platform
                );
                if (existing) { data.creatorId = existing.id; return true; }
                const _profileUrls = {
                    youtube:   `https://www.youtube.com/@${parsed.username}`,
                    twitter:   `https://twitter.com/${parsed.username}`,
                    instagram: `https://instagram.com/${parsed.username}`,
                    tiktok:    `https://www.tiktok.com/@${parsed.username}`,
                    twitch:    `https://www.twitch.tv/${parsed.username}`,
                };
                const profileUrl = _profileUrls[parsed.platform] || tryUrl;
                const avatarUrl  = await _mghCreatorAvatar(parsed.platform, parsed.username, profileUrl);
                const cData = {
                    title: parsed.username, url: profileUrl, type: "creator",
                    category: data.category,
                    thumbUrl: avatarUrl || "", username: parsed.username, platform: parsed.platform,
                    badgeLabel: "", badgeColor: "", createdAt: serverTimestamp(),
                };
                const docRef = await addDoc(refs.galleryLinks(_db, _uid()), cData);
                data.creatorId = docRef.id;
                toast(`Creator @${parsed.username} auto-added.`);
                return true;
            };
            await _tryAutoCreator(sourceUrl) || await _tryAutoCreator(altUrl);
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
                                    const docRef = await addDoc(refs.galleryLinks(_db, _uid()), pData);
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

    try {
        if (editId) {
            await updateDoc(doc(_db, "users", _uid(), "gallery-links", editId), data);
            toast("Link updated", "success");
        } else {
            await addDoc(refs.galleryLinks(_db, _uid()), {
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

let _pickerCat = null; // current cat for the service picker

const _KNOWN_STREAM_SERVICES = [
    { name: "Netflix",        url: "https://www.netflix.com" },
    { name: "Disney+",        url: "https://www.disneyplus.com" },
    { name: "HBO",            url: "https://www.max.com" },
    { name: "Hulu",           url: "https://www.hulu.com" },
    { name: "Prime Video",    url: "https://www.primevideo.com" },
    { name: "Apple TV+",      url: "https://tv.apple.com" },
    { name: "Peacock",        url: "https://www.peacocktv.com" },
    { name: "Paramount+",     url: "https://www.paramountplus.com" },
    { name: "Crunchyroll",    url: "https://www.crunchyroll.com" },
    { name: "Funimation",     url: "https://www.funimation.com" },
    { name: "MUBI",           url: "https://mubi.com" },
    { name: "Tubi",           url: "https://tubitv.com" },
    { name: "Pluto TV",       url: "https://pluto.tv" },
    { name: "Plex",           url: "https://www.plex.tv" },
    { name: "DAZN",           url: "https://www.dazn.com" },
    { name: "BritBox",        url: "https://www.britbox.com" },
    { name: "Acorn TV",       url: "https://acorn.tv" },
    { name: "Viaplay",        url: "https://viaplay.com" },
    { name: "SVT Play",       url: "https://www.svtplay.se" },
    { name: "NRK TV",          url: "https://tv.nrk.no" },
    { name: "TV 2",           url: "https://play.tv2.no" },
    { name: "Yle Areena",     url: "https://areena.yle.fi" },
    { name: "PStream",        url: "https://pstream.net" },
];
const _sdExpandedIds  = new Set(); // series item IDs with expand open
let   _sdDragSrc      = null;      // { kind:'item'|'coll', id?, name? }
const _collapsedColls   = new Set(); // collection names collapsed (drawer)
const _shCollapsedColls = new Set(); // collection names collapsed (hub)
let   _sdInsertAfter    = false;     // true = insert after drop target on drop
let   _hubLastServices  = null;      // services list for hub re-render after drag

function _getTmdbKey() { return window.__WS_TMDB_KEY || ""; }
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
    return collection(_db, "users", _uid(), "gallery-links", linkId, "streaming-items");
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
                    doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", item.id),
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
            doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", item.id),
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
                    doc(_db, "users", _uid(), "gallery-links", item._serviceId, "streaming-items", item.id),
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
        await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), updates);
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
        await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId),
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
            updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", srcId),  { collection: name }),
            updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", tgtId),  { collection: name }),
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
            updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", i.id),
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
        await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), changes);
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
                <input id="sh-iaf-title" class="sd-add-input" placeholder="Search title\u2026" autocomplete="off">
                <div id="sh-iaf-search-results" class="sd-search-results sd-hidden"></div>
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
            let   posterUrl = null;
            let   seasons   = [];
            const collectionName = document.getElementById("sh-iaf-coll")?.value.trim() || null;
            if (_iafSelectedResult) {
                posterUrl = _iafSelectedResult.posterUrl || null;
                title     = _iafSelectedResult.title || title;
                if (type === "series" && _iafSelectedResult.tmdbId) {
                    const meta = await _fetchTmdbMeta(
                        `https://www.themoviedb.org/tv/${_iafSelectedResult.tmdbId}`, title, "series"
                    );
                    if (meta) {
                        if (meta.posterUrl) posterUrl = meta.posterUrl;
                        if (meta.seasons?.length) seasons = meta.seasons;
                    }
                }
            } else {
                const rawPoster = document.getElementById("sh-iaf-poster-val").value || "";
                posterUrl = rawPoster && _isSafeUrl(rawPoster) ? rawPoster : null;
                if (type === "series") {
                    const meta = await _fetchTmdbMeta(rawUrl || null, title, "series");
                    if (meta) {
                        if (!posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
                        if (meta.seasons?.length) seasons = meta.seasons;
                    }
                } else {
                    const meta = await _fetchTmdbMeta(rawUrl || null, title, "movie");
                    if (meta && !posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
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
        let _iafSelectedResult = null;

        function _iafHideResults() {
            const el = document.getElementById("sh-iaf-search-results");
            if (el) { el.innerHTML = ""; el.classList.add("sd-hidden"); }
        }

        function _iafPickResult(result) {
            _iafSelectedResult = result;
            const titleInp = document.getElementById("sh-iaf-title");
            const prevImg  = document.getElementById("sh-iaf-poster");
            titleInp.value = result.title;
            document.getElementById("sh-iaf-poster-val").value = result.posterUrl || "";
            if (prevImg) {
                if (result.posterUrl) { prevImg.src = result.posterUrl; prevImg.style.display = ""; }
                else { prevImg.src = ""; prevImg.style.display = "none"; }
            }
            _iafHideResults();
        }

        document.getElementById("sh-iaf-title").addEventListener("input", () => {
            clearTimeout(_iafTimer);
            const q = document.getElementById("sh-iaf-title").value.trim();
            if (!q) { _iafHideResults(); return; }
            if (_iafSelectedResult && _iafSelectedResult.title === q) return;
            _iafSelectedResult = null;
            _iafTimer = setTimeout(async () => {
                const results = await _searchTmdbMulti(q);
                const el = document.getElementById("sh-iaf-search-results");
                if (!el) return;
                if (!results.length) { _iafHideResults(); return; }
                el.innerHTML = results.map((r, i) => `
                    <button class="sd-sr-item" data-iaf-sr-idx="${i}" type="button">
                        ${r.posterUrl
                            ? `<img class="sd-sr-poster" src="${escHtml(r.posterUrl)}" alt="" loading="lazy">`
                            : `<div class="sd-sr-poster sd-sr-poster--empty"><span class="material-symbols-outlined">${r.kind === "series" ? "tv" : "movie"}</span></div>`}
                        <div class="sd-sr-info">
                            <span class="sd-sr-title">${escHtml(r.title)}</span>
                            <span class="sd-sr-meta">${r.year ? escHtml(r.year) + " \u00b7 " : ""}${r.kind === "series" ? "Series" : "Movie"}</span>
                        </div>
                    </button>`).join("");
                el.classList.remove("sd-hidden");
                el._results = results;
            }, 450);
        });
        document.getElementById("sh-iaf-search-results").addEventListener("click", e => {
            const btn = e.target.closest("[data-iaf-sr-idx]");
            if (!btn) return;
            const idx = parseInt(btn.dataset.iafSrIdx, 10);
            const results = document.getElementById("sh-iaf-search-results")._results;
            if (!results?.[idx]) return;
            _iafPickResult(results[idx]);
        });
        document.getElementById("sh-iaf-url").addEventListener("input", () => {
            clearTimeout(_iafTimer);
            _iafTimer = setTimeout(async () => {
                const url   = document.getElementById("sh-iaf-url").value.trim();
                const title = document.getElementById("sh-iaf-title").value.trim();
                if (!url) return;
                if (!title) {
                    const ex = _extractTitleFromUrl(url);
                    if (ex) { document.getElementById("sh-iaf-title").value = ex; }
                }
                const meta = await _fetchTmdbMeta(url, title, "movie");
                if (meta?.posterUrl) {
                    document.getElementById("sh-iaf-poster-val").value = meta.posterUrl;
                    const p = document.getElementById("sh-iaf-poster");
                    p.src = meta.posterUrl; p.style.display = "";
                }
                if (meta?.title && !document.getElementById("sh-iaf-title").value.trim()) {
                    document.getElementById("sh-iaf-title").value = meta.title;
                }
            }, 500);
        });
        document.getElementById("sh-iaf-movie").addEventListener("click",  () => shSaveItem("movie"));
        document.getElementById("sh-iaf-series").addEventListener("click", () => shSaveItem("series"));
        document.getElementById("sh-iaf-cancel").addEventListener("click", () => {
            form.classList.add("sd-hidden");
            _iafSelectedResult = null;
            _iafHideResults();
        });
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

/* ══════════ SERVICE PICKER ══════════ */

function _renderPickerList(query) {
    const list = document.getElementById("sh-svc-picker-list");
    if (!list || !_pickerCat) return;
    const addedDomains = new Set(
        _links.filter(l => l.category === _pickerCat.name).map(l => _domain(l.url))
    );
    const q = query.toLowerCase();
    const filtered = _KNOWN_STREAM_SERVICES
        .map((s, i) => ({ ...s, idx: i }))
        .filter(s => !q || s.name.toLowerCase().includes(q));
    if (!filtered.length) {
        list.innerHTML = `<div class="sh-svc-picker-empty">No match — use "Add custom" below.</div>`;
        return;
    }
    list.innerHTML = filtered.map(s => {
        const alreadyAdded = addedDomains.has(_domain(s.url));
        let hostname = "";
        try { hostname = new URL(s.url).hostname; } catch { /* noop */ }
        const fav = hostname
            ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`
            : "";
        return `<button class="sh-svc-picker-item${alreadyAdded ? " sh-svc-picker-item--added" : ""}" data-svc-idx="${s.idx}" ${alreadyAdded ? "disabled" : ""} type="button">
            ${fav ? `<img class="sh-svc-picker-fav" src="${escHtml(fav)}" alt="" onerror="this.style.display='none'">` : ""}
            <span class="sh-svc-picker-name">${escHtml(s.name)}</span>
            ${alreadyAdded ? `<span class="sh-svc-picker-badge">Added</span>` : ""}
        </button>`;
    }).join("");
}

function _openServicePicker(cat) {
    _pickerCat = cat;
    let overlay = document.getElementById("sh-svc-picker-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "sh-svc-picker-overlay";
        overlay.className = "sh-svc-picker-overlay";
        overlay.innerHTML = `
            <div class="sh-svc-picker" role="dialog" aria-modal="true" aria-label="Add streaming service">
                <div class="sh-svc-picker-hdr">
                    <span class="material-symbols-outlined" style="font-size:1.1rem;opacity:.7">smart_display</span>
                    Add Streaming Service
                    <button id="sh-svc-picker-close" class="sh-svc-picker-close" title="Close" type="button">&times;</button>
                </div>
                <div class="sh-svc-picker-search-wrap">
                    <span class="material-symbols-outlined sh-svc-picker-search-icon">search</span>
                    <input id="sh-svc-picker-input" class="sh-svc-picker-input" placeholder="Search (e.g. Netflix, Disney+)…" autocomplete="off" type="search">
                </div>
                <div id="sh-svc-picker-list" class="sh-svc-picker-list"></div>
                <div class="sh-svc-picker-footer">
                    <button id="sh-svc-picker-custom" class="sh-svc-picker-custom-btn" type="button">
                        <span class="material-symbols-outlined">add_link</span>
                        Add custom service…
                    </button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const _hidePicker = () => overlay.classList.remove("sh-svc-picker-open");

        overlay.addEventListener("click", e => { if (e.target === overlay) _hidePicker(); });
        overlay.addEventListener("keydown", e => { if (e.key === "Escape") _hidePicker(); });

        document.getElementById("sh-svc-picker-close").addEventListener("click", _hidePicker);

        document.getElementById("sh-svc-picker-input").addEventListener("input", e => {
            _renderPickerList(e.target.value.trim());
        });

        document.getElementById("sh-svc-picker-custom").addEventListener("click", () => {
            _hidePicker();
            _openForm(null);
            setTimeout(() => {
                const cf = document.getElementById("link-cat-field");
                const tf = document.getElementById("link-type-field");
                if (cf && _pickerCat) cf.value = _pickerCat.name;
                if (tf) { tf.value = "streaming-service"; _updateTypeHint("streaming-service"); }
            }, 80);
        });

        document.getElementById("sh-svc-picker-list").addEventListener("click", async e => {
            const item = e.target.closest("[data-svc-idx]");
            if (!item || item.disabled) return;
            const idx = parseInt(item.dataset.svcIdx, 10);
            const svc = _KNOWN_STREAM_SERVICES[idx];
            if (!svc || !_pickerCat) return;
            _hidePicker();
            // Prevent duplicates
            const alreadyAdded = _links.some(
                l => l.category === _pickerCat.name && _domain(l.url) === _domain(svc.url)
            );
            if (alreadyAdded) { toast(`${svc.name} is already added`, "info"); return; }
            try {
                const url = _applyOverrideDomain(svc);
                await addDoc(refs.galleryLinks(_db, _uid()), {
                    title:     svc.name,
                    url,
                    type:      "streaming-service",
                    category:  _pickerCat.name,
                    createdAt: serverTimestamp(),
                    sortOrder: Date.now(),
                });
                toast(`${svc.name} added`, "success");
            } catch (err) { console.error(err); toast("Error adding service", "error"); }
        });
    }

    // Reset and open
    document.getElementById("sh-svc-picker-input").value = "";
    _renderPickerList("");
    overlay.classList.add("sh-svc-picker-open");
    setTimeout(() => document.getElementById("sh-svc-picker-input").focus(), 60);
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

    // Service domain rewrite: swap stored URL to admin-configured domain if an override exists
    el.addEventListener("click", e => {
        const a = e.target.closest("a[target='_blank']");
        if (!a || !a.href) return;
        const rewritten = _rewriteServiceUrl(a.href);
        if (rewritten === null) return;
        e.preventDefault();
        window.open(rewritten, "_blank", "noopener,noreferrer");
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

// Returns the URL to use when adding a service from the picker (applies override if set).
function _applyOverrideDomain(svc) {
    const override = _serviceDomains[svc.name];
    if (!override) return svc.url;
    try {
        const u = new URL(svc.url);
        u.hostname = override;
        return u.toString();
    } catch { return svc.url; }
}

// Rewrites a stored service URL to the admin-configured domain if an override exists.
// Returns null if no rewrite is needed.
function _rewriteServiceUrl(url) {
    if (!Object.keys(_serviceDomains).length) return null;
    try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        for (const svc of _KNOWN_STREAM_SERVICES) {
            const override = _serviceDomains[svc.name];
            if (!override) continue;
            const defHost = new URL(svc.url).hostname.replace(/^www\./, "");
            const ovrHost = override.replace(/^www\./, "");
            if (h === defHost || h === ovrHost) {
                if (h === ovrHost) return null; // already on the right domain
                const u = new URL(url);
                u.hostname = override;
                return u.toString();
            }
        }
    } catch {}
    return null;
}

const _SD_BRAND_COLORS = {
    "netflix.com":           "#e50914",
    "primevideo.com":        "#0578FF",
    "amazon.com":            "#0578FF",
    "disneyplus.com":        "#00333E",
    "hulu.com":              "#14aa5f",
    "max.com":               "#222222",
    "hbomax.com":            "#222222",
    "appletv.apple.com":     "#595959",
    "tv.apple.com":          "#595959",
    "peacocktv.com":         "#6F55DE",
    "paramountplus.com":     "#0064ff",
    "discoveryplus.com":     "#2175d9",
    "crunchyroll.com":       "#f47521",
    "funimation.com":        "#f47521",
    "mubi.com":              "#001489",
    "tubi.tv":               "#7B00D5",
    "pluto.tv":              "#8f8800",
    "dazn.com":              "#121b22",
    "britbox.com":           "#00182B",
    "acorn.tv":              "#0C4742",
    "viaplay.com":           "#DF146A",
    "svtplay.se":            "#004300",
    "tv.nrk.no":             "#073B84",
    "play.tv2.no":           "#6F03FF",
    "areena.yle.fi":         "#494949",
    "plex.tv":               "#e5a00d",
    "pstream.net":           "#8288fe",
};

function _sdBrandColor(url) {
    if (!url) return null;
    try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        // Check static brand colors first
        for (const [k, v] of Object.entries(_SD_BRAND_COLORS)) {
            if (h === k || h.endsWith("." + k)) return v;
        }
        // If URL uses an override domain, look up the color for the service's default URL
        for (const svc of _KNOWN_STREAM_SERVICES) {
            const override = _serviceDomains[svc.name];
            if (override && h === override.replace(/^www\./, "")) {
                const defHost = new URL(svc.url).hostname.replace(/^www\./, "");
                for (const [k, v] of Object.entries(_SD_BRAND_COLORS)) {
                    if (defHost === k || defHost.endsWith("." + k)) return v;
                }
            }
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
            await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { watched: item.watched });
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
            await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
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
            await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
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
            await updateDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId), { seasons: item.seasons });
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
            await deleteDoc(doc(_db, "users", _uid(), "gallery-links", _openDrawerLinkId, "streaming-items", itemId));
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
