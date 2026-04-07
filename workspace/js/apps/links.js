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
    onSnapshot, addDoc, updateDoc, deleteDoc,
    doc, query, orderBy, serverTimestamp,
    collection, getDocs
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
    "other":              { label: "Other",             icon: "link" },
};

/* ══════════ STATE ══════════ */

let _db, _user, _unsub;
let _links       = [];
let _search      = "";
let _activeCat   = "all";   // "all" | category name | "_uncat"
let _sortMode    = "manual";
let _editId      = null;
let _editCatId   = null;
let _dragId      = null;
const _mediaThumbs = {}; // url → imgUrl | null  (undefined = not yet tried)

let _cats = [];   // [{ id, name, icon }]
const _CATS_KEY = () => `linksCats_${_user?.uid}`;
function _loadCats() {
    try { _cats = JSON.parse(localStorage.getItem(_CATS_KEY()) || "[]"); }
    catch { _cats = []; }
    // Migrate: auto-apply streaming prefab to any existing "Streaming" category
    let migrated = false;
    _cats = _cats.map(c => {
        if (c.name.toLowerCase() === "streaming" && !c.prefab) {
            migrated = true;
            return { ...c, prefab: "streaming", icon: "smart_display" };
        }
        return c;
    });
    if (migrated) _saveCats();
}
function _saveCats() {
    try { localStorage.setItem(_CATS_KEY(), JSON.stringify(_cats)); } catch {}
}
function _syncCatsFromLinks() {
    const known = new Set(_cats.map(c => c.name));
    let changed = false;
    _links.forEach(l => {
        if (l.category && !known.has(l.category)) {
            const isStreaming = l.category.toLowerCase() === "streaming";
            _cats.push({ id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: l.category, icon: isStreaming ? "smart_display" : "folder", ...(isStreaming ? { prefab: "streaming" } : {}) });
            known.add(l.category);
            changed = true;
        }
    });
    if (changed) _saveCats();
}

/* ══════════ INIT ══════════ */

export function initLinks(db, user) {
    _db   = db;
    _user = user;
    _loadCats();

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
        const actionBtns = `
            <button class="link-card-action-btn" data-cat-action="edit-cat" data-cat-id="${escHtml(c.id)}" title="Edit">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="link-card-action-btn link-card-action-btn--danger" data-cat-action="delete-cat" data-cat-id="${escHtml(c.id)}" title="Delete">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>`;
        if (c.prefab === "streaming") return `
            <div class="link-cat-card link-cat-card--streaming" data-cat-name="${escHtml(c.name)}">
                <div class="link-cat-card-icon"><span class="material-symbols-outlined">smart_display</span></div>
                <div class="link-cat-card-name">${escHtml(c.name)}</div>
                <div class="link-cat-card-count">${count} service${count !== 1 ? "s" : ""}</div>
                <div class="link-cat-card-footer">${actionBtns}</div>
            </div>`;
        return `
            <div class="link-cat-card" data-cat-name="${escHtml(c.name)}">
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

function _renderHubContent(container, allItems) {
    if (!container) return;
    const movies = allItems.filter(i => i.type === "movie");
    const series = allItems.filter(i => i.type === "series");
    const showMovies = _shActiveTab === "all" || _shActiveTab === "movie";
    const showSeries = _shActiveTab === "all" || _shActiveTab === "series";

    if (!allItems.length) {
        container.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">video_library</span><p>Add a streaming service then open it to track movies &amp; series.</p></div>`;
        return;
    }

    let html = "";

    if (showMovies && movies.length) {
        const watched = movies.filter(m => m.watched).length;
        html += `<div class="sh-section">
            <div class="sh-section-hdr"><span class="material-symbols-outlined">movie</span>Movies<span class="sh-section-count">${watched}/${movies.length}</span></div>
            <div class="sd-movies-grid">`
        + movies.map(m => {
            const rawUrl    = m.url && _isSafeUrl(m.url) ? m.url : (m.title && _isSafeUrl(m.title) ? m.title : null);
            const safeUrl   = rawUrl ? escHtml(rawUrl) : null;
            const dispTitle = m.title && !_isSafeUrl(m.title) ? m.title : (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : m.title || "");
            return `
            <div class="sd-movie-card${m.watched ? " sd-movie-watched" : ""}" data-sh-item-id="${escHtml(m.id)}" data-sh-svc-id="${escHtml(m._serviceId)}">
                ${safeUrl
                    ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer">`
                    : `<div class="sd-movie-poster">`}
                    ${m.posterUrl && _isSafeUrl(m.posterUrl)
                        ? `<img class="sd-movie-poster-img" src="${escHtml(m.posterUrl)}" alt="" loading="lazy">`
                        : `<span class="material-symbols-outlined sd-movie-icon">movie</span>`}
                    <div class="sd-movie-watched-overlay"><span class="material-symbols-outlined">check_circle</span></div>
                ${safeUrl ? `</a>` : `</div>`}
                <button class="sd-watched-toggle sh-toggle-watched" title="${m.watched ? "Mark unwatched" : "Mark watched"}">
                    <span class="material-symbols-outlined">${m.watched ? "check_circle" : "radio_button_unchecked"}</span>
                </button>
                <div class="sd-movie-info">
                    ${safeUrl
                        ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>`
                        : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
                </div>
                <div class="sh-svc-badge">${escHtml(m._serviceTitle)}</div>
            </div>`;
        }).join("")
        + `</div></div>`;
    }

    if (showSeries && series.length) {
        html += `<div class="sh-section">
            <div class="sh-section-hdr"><span class="material-symbols-outlined">tv</span>Series<span class="sh-section-count">${series.length}</span></div>
            <div class="sd-movies-grid">` +
        series.map(s => {
            const tot  = (s.seasons || []).reduce((a, se) => a + (se.eps || 0), 0);
            const done = (s.seasons || []).reduce((a, se) => a + (se.watched || []).length, 0);
            const pct  = tot ? Math.round(done / tot * 100) : 0;
            const sDisp = s.title && !_isSafeUrl(s.title) ? s.title : (s.url && _isSafeUrl(s.url) ? _extractTitleFromUrl(s.url) || s.title || "" : s.title || "");
            const sRawUrl  = s.url && _isSafeUrl(s.url) ? s.url : (s.title && _isSafeUrl(s.title) ? s.title : null);
            const sSafeUrl = sRawUrl ? escHtml(sRawUrl) : null;
            return `
            <div class="sd-movie-card sd-series-tile" data-sh-item-id="${escHtml(s.id)}" data-sh-svc-id="${escHtml(s._serviceId)}">
                ${sSafeUrl
                    ? `<a class="sd-movie-poster" href="${sSafeUrl}" target="_blank" rel="noopener noreferrer">`
                    : `<div class="sd-movie-poster">`}
                    ${s.posterUrl && _isSafeUrl(s.posterUrl)
                        ? `<img class="sd-movie-poster-img" src="${escHtml(s.posterUrl)}" alt="" loading="lazy">`
                        : `<span class="material-symbols-outlined sd-movie-icon">tv</span>`}
                    ${tot > 0 ? `<div class="sd-tile-prog"><div class="sd-tile-prog-fill" style="width:${pct}%"></div></div>` : ""}
                    ${s.seasons?.length ? `<div class="sd-season-badge">${s.seasons.length} S</div>` : ""}
                ${sSafeUrl ? `</a>` : `</div>`}
                <div class="sd-movie-info">
                    ${sSafeUrl
                        ? `<a class="sd-movie-title sd-movie-title-link" href="${sSafeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(sDisp)}">${escHtml(sDisp)}</a>`
                        : `<span class="sd-movie-title" title="${escHtml(sDisp)}">${escHtml(sDisp)}</span>`}
                </div>
                <div class="sh-svc-badge">${escHtml(s._serviceTitle)}</div>
            </div>`;
        }).join("") +
        `</div></div>`;
    }

    if (!html) {
        const label = _shActiveTab === "movie" ? "movies" : "series";
        html = `<div class="sh-empty"><span class="material-symbols-outlined">${_shActiveTab === "movie" ? "movie" : "tv"}</span><p>No ${label} tracked yet.</p></div>`;
    }

    container.innerHTML = html;

    // Toggle watched on movie poster click
    container.querySelectorAll(".sh-toggle-watched").forEach(btn => {
        btn.addEventListener("click", async e => {
            if (e.target.closest("a")) return;
            const card  = btn.closest("[data-sh-item-id]");
            const itemId = card.dataset.shItemId;
            const svcId  = card.dataset.shSvcId;
            const item   = (_streamCache[svcId] || []).find(i => i.id === itemId);
            if (!item) return;
            item.watched = !item.watched;
            card.classList.toggle("sd-movie-watched", item.watched);
            btn.title = item.watched ? "Mark unwatched" : "Mark watched";
            try {
                await updateDoc(doc(_db, "users", _user.uid, "gallery-links", svcId, "streaming-items", itemId), { watched: item.watched });
            } catch (err) { console.error(err); item.watched = !item.watched; card.classList.toggle("sd-movie-watched", item.watched); }
        });
    });


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
    // Category card click (not on a sub-button)
    const catCard = e.target.closest(".link-cat-card[data-cat-name]");
    if (catCard && !e.target.closest("[data-cat-action]")) {
        _activeCat = catCard.dataset.catName;
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
            // visually select smart_display swatch if grid is rendered
            overlay.querySelectorAll(".link-cat-icon-swatch").forEach(s =>
                s.classList.toggle("selected", s.dataset.icon === "smart_display"));
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

    // Prefab section: only show when creating, hide when editing
    const prefabGroup = document.getElementById("link-cat-prefab-group");
    const prefabField = document.getElementById("link-cat-prefab-field");
    if (prefabGroup) prefabGroup.style.display = editId ? "none" : "";

    let selectedIcon = "folder";
    if (editId) {
        const cat = _cats.find(c => c.id === editId);
        if (!cat) return;
        setModalTitle("modal-link-cat", "Edit Category");
        document.getElementById("btn-link-cat-submit").textContent = "Save";
        document.getElementById("link-cat-id-field").value   = editId;
        document.getElementById("link-cat-name-field").value = cat.name;
        if (prefabField) prefabField.value = cat.prefab || "";
        selectedIcon = cat.icon || "folder";
    } else {
        setModalTitle("modal-link-cat", "New Category");
        document.getElementById("btn-link-cat-submit").textContent = "Create";
        document.getElementById("link-cat-id-field").value = "";
        if (prefabField) prefabField.value = "";
        // Reset prefab buttons to "Standard" selected
        document.querySelectorAll("#link-cat-prefabs .lc-prefab").forEach(b =>
            b.classList.toggle("active", b.dataset.prefab === ""));
    }
    document.getElementById("link-cat-icon-ms").textContent = selectedIcon;
    const _iconFieldEl = document.getElementById("link-cat-icon-field");
    if (_iconFieldEl) _iconFieldEl.value = selectedIcon;
    _renderLinkCatIconGrid("");
    openModal("modal-link-cat");
    setTimeout(() => document.getElementById("link-cat-name-field").focus(), 60);
}

function _onCatFormSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("link-cat-name-field").value.trim();
    if (!name) { toast("Enter a category name", "error"); return; }
    const icon   = (document.getElementById("link-cat-icon-field")?.value ||
                   document.getElementById("link-cat-icon-ms")?.textContent || "folder").trim() || "folder";
    const editId = document.getElementById("link-cat-id-field").value;

    let prefab = document.getElementById("link-cat-prefab-field")?.value || "";
    if (!prefab && name.toLowerCase() === "streaming") prefab = "streaming";
    if (editId) {
        const old = _cats.find(c => c.id === editId);
        const oldName = old?.name;
        _cats = _cats.map(c => c.id === editId ? { ...c, name, icon, ...(prefab ? { prefab } : (c.prefab ? { prefab: c.prefab } : {})) } : c);
        if (oldName && oldName !== name) {
            const toUpdate = _links.filter(l => l.category === oldName);
            Promise.all(toUpdate.map(l =>
                updateDoc(doc(_db, "users", _user.uid, "gallery-links", l.id), { category: name, updatedAt: serverTimestamp() })
            )).catch(err => console.error(err));
            if (_activeCat === oldName) _activeCat = name;
        }
        toast("Category updated", "success");
    } else {
        if (_cats.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            toast("Category already exists", "error"); return;
        }
        if (!prefab && name.toLowerCase() === "streaming") prefab = "streaming";
        _cats.push({ id: `cat-${Date.now()}`, name, icon, ...(prefab ? { prefab } : {}) });
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
    const linksInCat = _links.filter(l => l.category === cat.name).length;
    const msg = linksInCat
        ? `Delete category "${cat.name}"? The ${linksInCat} link${linksInCat !== 1 ? "s" : ""} inside will become uncategorised.`
        : `Delete category "${cat.name}"?`;
    const ok = await confirm(msg);
    if (!ok) return;
    _cats = _cats.filter(c => c.id !== id);
    _saveCats();
    if (_activeCat === cat.name) _activeCat = "all";
    toast("Category deleted");
    _render();
}

/* ══════════ FORM ══════════ */

function _openForm(editId) {
    _editId = editId;
    const form = document.getElementById("form-add-link");
    form.reset();
    document.getElementById("link-type-field").value = "website";
    _updateTypeHint("website");

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
        document.getElementById("link-desc-field").value       = link.description || "";
        document.getElementById("link-thumb-field").value      = link.thumbUrl    || "";
        _updateTypeHint(link.type || "website");
    } else {
        setModalTitle("modal-link", "Add Link");
        document.getElementById("btn-link-submit").textContent = "Add Link";
        document.getElementById("link-id-field").value = "";
        const preselect = (_activeCat !== "all" && _activeCat !== "_uncat") ? _activeCat : "";
        _populateCatSelect(preselect);
    }

    openModal("modal-link");
    setTimeout(() => document.getElementById("link-url-field").focus(), 60);
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
    const thumbGroup = document.getElementById("link-thumb-group");
    if (thumbGroup) thumbGroup.style.display = (type === "image" || type === "3d-model") ? "" : "none";
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
    if (!_isSafeUrl(url)) {
        toast("Please enter a valid http/https URL", "error"); return;
    }
    const data = {
        url,
        title:       document.getElementById("link-title-field").value.trim(),
        type:        document.getElementById("link-type-field").value || "website",
        category:    document.getElementById("link-cat-field").value.trim(),
        description: document.getElementById("link-desc-field").value.trim(),
        thumbUrl:    (() => { const v = document.getElementById("link-thumb-field")?.value.trim(); return (v && _isSafeUrl(v)) ? v : ""; })(),
        updatedAt:   serverTimestamp(),
    };
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

async function _saveStreamItem(linkId, type, title, itemUrl, posterUrl, seasons) {
    const item = {
        title, type, watched: false, addedAt: Date.now(),
        ...(itemUrl   ? { url: itemUrl }            : {}),
        ...(posterUrl ? { posterUrl }               : {}),
        ...(type === "series" ? { seasons: (seasons?.length ? seasons : []) } : {}),
    };
    const ref = await addDoc(_streamRef(linkId), item);
    _streamCache[linkId] = [...(_streamCache[linkId] || []), { id: ref.id, ...item }];
    return { id: ref.id, ...item };
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
            if (type === "series") {
                const meta = await _fetchTmdbMeta(rawUrl || null, title, "series");
                if (meta) {
                    if (!posterUrl && meta.posterUrl) posterUrl = meta.posterUrl;
                    if (meta.seasons?.length) seasons = meta.seasons;
                }
            }
            try {
                await _saveStreamItem(linkId, type, title, itemUrl, posterUrl, seasons);
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
    document.getElementById("sh-iaf-poster-val").value = "";
    const p = document.getElementById("sh-iaf-poster"); p.src = ""; p.style.display = "none";
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
    const items   = _streamCache[_openDrawerLinkId] || [];
    const movies  = items.filter(i => i.type !== "series");
    const series  = items.filter(i => i.type === "series");

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

    if (!items.length) {
        body.innerHTML = `<div class="sh-empty"><span class="material-symbols-outlined">video_library</span><p>No movies or series added yet.</p></div>`;
        return;
    }

    const showMovies = _sdActiveTab === "all" || _sdActiveTab === "movie";
    const showSeries = _sdActiveTab === "all" || _sdActiveTab === "series";
    let html = "";

    if (showMovies && movies.length) {
        html += `<div class="sh-section"><div class="sh-section-hdr"><span class="material-symbols-outlined">movie</span>Movies<span class="sh-section-count">${watchedMov}/${totalMovies}</span></div><div class="sd-movies-grid">`;
        html += movies.map(m => {
            const rawUrl    = m.url && _isSafeUrl(m.url) ? m.url : null;
            const safeUrl   = rawUrl ? escHtml(rawUrl) : null;
            const dispTitle = m.title || (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : "");
            return `<div class="sd-movie-card${m.watched ? " sd-movie-watched" : ""}" data-sd-item-id="${escHtml(m.id)}">
                ${safeUrl ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer">` : `<div class="sd-movie-poster">`}
                    ${m.posterUrl && _isSafeUrl(m.posterUrl) ? `<img class="sd-movie-poster-img" src="${escHtml(m.posterUrl)}" alt="" loading="lazy">` : `<span class="material-symbols-outlined sd-movie-icon">movie</span>`}
                    <div class="sd-movie-watched-overlay"><span class="material-symbols-outlined">check_circle</span></div>
                ${safeUrl ? `</a>` : `</div>`}
                <button class="sd-watched-toggle" data-toggle-watched data-sd-item-id="${escHtml(m.id)}" title="${m.watched ? "Mark unwatched" : "Mark watched"}">
                    <span class="material-symbols-outlined">${m.watched ? "check_circle" : "radio_button_unchecked"}</span>
                </button>
                <div class="sd-movie-info">
                    ${safeUrl ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>` : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
                </div>
                <button class="sd-icon-btn sd-icon-btn--danger sd-del-btn" data-delete-item="${escHtml(m.id)}" title="Remove">
                    <span class="material-symbols-outlined" style="font-size:13px">delete</span>
                </button>
            </div>`;
        }).join("");
        html += `</div></div>`;
    }

    if (showSeries && series.length) {
        html += `<div class="sh-section"><div class="sh-section-hdr"><span class="material-symbols-outlined">tv</span>Series<span class="sh-section-count">${series.length}</span></div><div class="sd-movies-grid">`;
        html += series.map(s => {
            const tot  = (s.seasons || []).reduce((a, se) => a + (se.eps || 0), 0);
            const done = (s.seasons || []).reduce((a, se) => a + (se.watched?.length || 0), 0);
            const pct  = tot ? Math.round(done / tot * 100) : 0;
            const rawUrl    = s.url && _isSafeUrl(s.url) ? s.url : null;
            const safeUrl   = rawUrl ? escHtml(rawUrl) : null;
            const dispTitle = s.title || (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : "");
            const isExpanded = _sdExpandedIds.has(s.id);
            const allDone    = tot > 0 && done === tot;
            const seasonsHtml = s.seasons?.length
                ? `<div class="sd-seasons">${s.seasons.map((se, si) => {
                    const sDone    = (se.watched || []).length;
                    const sAllDone = sDone === se.eps;
                    const epBubbles = Array.from({ length: se.eps }, (_, ei) => {
                        const ep      = ei + 1;
                        const watched = (se.watched || []).includes(ep);
                        return `<button class="sd-ep${watched ? " sd-ep-done" : ""}" data-sd-item-id="${escHtml(s.id)}" data-season-idx="${si}" data-ep-n="${ep}" title="E${ep}">${ep}</button>`;
                    }).join("");
                    return `<div class="sd-season-row">
                        <button class="sd-s-label${sAllDone ? " sd-s-done" : ""}" data-toggle-season data-sd-item-id="${escHtml(s.id)}" data-season-idx="${si}" title="Toggle season ${se.s}">S${se.s}</button>
                        <div class="sd-ep-wrap">${epBubbles}</div>
                        <span class="sd-ep-count">${sDone}/${se.eps}</span>
                    </div>`;
                }).join("")}</div>`
                : `<div class="sd-no-seasons">No season data</div>`;

            return `<div class="sd-movie-card sd-series-tile" data-sd-item-id="${escHtml(s.id)}">
                ${safeUrl ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer">` : `<div class="sd-movie-poster">`}
                    ${s.posterUrl && _isSafeUrl(s.posterUrl) ? `<img class="sd-movie-poster-img" src="${escHtml(s.posterUrl)}" alt="" loading="lazy">` : `<span class="material-symbols-outlined sd-movie-icon">tv</span>`}
                    ${tot > 0 ? `<div class="sd-tile-prog"><div class="sd-tile-prog-fill" style="width:${pct}%"></div></div>` : ""}
                    ${s.seasons?.length ? `<div class="sd-season-badge">${s.seasons.length} S</div>` : ""}
                ${safeUrl ? `</a>` : `</div>`}
                <div class="sd-movie-info">
                    ${safeUrl ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>` : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
                    <button class="sd-expand-toggle" data-toggle-expand="${escHtml(s.id)}" title="${isExpanded ? "Collapse" : "Expand seasons"}">
                        <span class="material-symbols-outlined">${isExpanded ? "expand_less" : "expand_more"}</span>
                    </button>
                </div>
                <div class="sd-series-expand${isExpanded ? "" : " sd-hidden"}">
                    <div class="sd-expand-hdr">
                        <button class="sd-toggle-show${allDone ? " sd-toggle-show--done" : ""}" data-toggle-show data-sd-item-id="${escHtml(s.id)}" title="${allDone ? "Unwatch all" : "Watch all"}">
                            <span class="material-symbols-outlined" style="font-size:14px">${allDone ? "remove_done" : "done_all"}</span>
                            ${allDone ? "Unwatch all" : "Watch all"}
                        </button>
                    </div>
                    ${seasonsHtml}
                </div>
                <button class="sd-icon-btn sd-icon-btn--danger sd-del-btn" data-delete-item="${escHtml(s.id)}" title="Remove">
                    <span class="material-symbols-outlined" style="font-size:13px">delete</span>
                </button>
            </div>`;
        }).join("");
        html += `</div></div>`;
    }

    if (!html) {
        const label = _sdActiveTab === "movie" ? "movies" : "series";
        html = `<div class="sh-empty"><span class="material-symbols-outlined">${_sdActiveTab === "movie" ? "movie" : "tv"}</span><p>No ${label} tracked yet.</p></div>`;
    }
    body.innerHTML = html;
}

async function _onLibraryBodyClick(e) {
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
