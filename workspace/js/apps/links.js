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

let _cats = [];   // [{ id, name, icon }]
const _CATS_KEY = () => `linksCats_${_user?.uid}`;
function _loadCats() {
    try { _cats = JSON.parse(localStorage.getItem(_CATS_KEY()) || "[]"); }
    catch { _cats = []; }
}
function _saveCats() {
    try { localStorage.setItem(_CATS_KEY(), JSON.stringify(_cats)); } catch {}
}
function _syncCatsFromLinks() {
    const known = new Set(_cats.map(c => c.name));
    let changed = false;
    _links.forEach(l => {
        if (l.category && !known.has(l.category)) {
            _cats.push({ id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: l.category, icon: "folder" });
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
    el.className = "link-card" + (link.pinned ? " link-card--pinned" : "");
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

    const faviconSrc = type.startsWith("youtube-")
        ? "https://www.google.com/s2/favicons?domain=youtube.com&sz=32"
        : domain
            ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
            : null;
    const faviconHtml = faviconSrc
        ? `<img class="link-card-favicon" src="${faviconSrc}" alt="" loading="lazy" onerror="this.style.display='none'">`
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
        document.getElementById("link-cat-icon-ms").textContent = sw.dataset.icon;
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
    _renderLinkCatIconGrid("");
    openModal("modal-link-cat");
    setTimeout(() => document.getElementById("link-cat-name-field").focus(), 60);
}

function _onCatFormSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("link-cat-name-field").value.trim();
    if (!name) { toast("Enter a category name", "error"); return; }
    const icon   = document.getElementById("link-cat-icon-ms")?.textContent.trim() || "folder";
    const editId = document.getElementById("link-cat-id-field").value;

    const prefab = document.getElementById("link-cat-prefab-field")?.value || "";
    if (editId) {
        const old = _cats.find(c => c.id === editId);
        const oldName = old?.name;
        _cats = _cats.map(c => c.id === editId ? { ...c, name, icon } : c);
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
        // 1. If a direct TMDB URL was pasted, use the ID lookup
        const m = urlStr && urlStr.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
        if (m) {
            const res = await fetch(
                `https://api.themoviedb.org/3/${m[1] === "tv" ? "tv" : "movie"}/${m[2]}?api_key=${encodeURIComponent(key)}&language=en-US`
            );
            if (res.ok) {
                const data = await res.json();
                return {
                    title:     data.title || data.name || "",
                    posterUrl: data.poster_path ? `https://image.tmdb.org/t/p/w200${data.poster_path}` : null,
                };
            }
        }
        // 2. Fall back to title search
        if (!title) return null;
        const res = await fetch(
            `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}&language=en-US&page=1`
        );
        if (!res.ok) return null;
        const data = await res.json();
        const hit  = (data.results || [])[0];
        if (!hit) return null;
        return {
            title:     hit.title || hit.name || "",
            posterUrl: hit.poster_path ? `https://image.tmdb.org/t/p/w200${hit.poster_path}` : null,
        };
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

async function _saveStreamItem(linkId, type, title, itemUrl, posterUrl) {
    const item = {
        title, type, watched: false, addedAt: Date.now(),
        ...(itemUrl   ? { url: itemUrl }            : {}),
        ...(posterUrl ? { posterUrl }               : {}),
        ...(type === "series" ? { seasons: [] }     : {}),
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
            if (!title && rawUrl) title = _extractTitleFromUrl(rawUrl) || rawUrl;
            if (!title || !linkId) { toast("Enter a title and select a service", "error"); return; }
            const itemUrl   = rawUrl && _isSafeUrl(rawUrl) ? rawUrl : null;
            const rawPoster = document.getElementById("sh-iaf-poster-val").value || "";
            const posterUrl = rawPoster && _isSafeUrl(rawPoster) ? rawPoster : null;
            try {
                await _saveStreamItem(linkId, type, title, itemUrl, posterUrl);
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

    let _pendingType = null;
    function showAddForm() {
        document.getElementById("sd-add-form").classList.remove("sd-hidden");
        const titleInp = document.getElementById("sd-add-title");
        const prevImg  = document.getElementById("sd-add-poster-preview");
        document.getElementById("sd-add-url").value   = "";
        titleInp.value = "";
        document.getElementById("sd-add-poster").value = "";
        if (prevImg) { prevImg.src = ""; prevImg.style.display = "none"; }
        titleInp.placeholder = "Search title…";
        titleInp.focus();
    }
    let _posterTimer = null;
    function _triggerPosterFetch() {
        clearTimeout(_posterTimer);
        const url      = document.getElementById("sd-add-url").value.trim();
        const titleInp = document.getElementById("sd-add-title");
        const prevImg  = document.getElementById("sd-add-poster-preview");
        const title    = titleInp.value.trim();
        if (!url && !title) {
            document.getElementById("sd-add-poster").value = "";
            if (prevImg) { prevImg.src = ""; prevImg.style.display = "none"; }
            return;
        }
        _posterTimer = setTimeout(async () => {
            const meta = await _fetchTmdbMeta(url || null, title, _pendingType || "movie");
            if (!meta) return;
            if (meta.title) titleInp.value = meta.title;
            document.getElementById("sd-add-poster").value = meta.posterUrl || "";
            if (prevImg) {
                if (meta.posterUrl) { prevImg.src = meta.posterUrl; prevImg.style.display = ""; }
                else { prevImg.src = ""; prevImg.style.display = "none"; }
            }
        }, 700);
    }
    document.getElementById("sd-add-title").addEventListener("input", _triggerPosterFetch);
    document.getElementById("sd-add-url").addEventListener("input", () => {
        const url      = document.getElementById("sd-add-url").value.trim();
        const titleInp = document.getElementById("sd-add-title");
        if (url && !titleInp.value.trim()) {
            const ex = _extractTitleFromUrl(url);
            if (ex) titleInp.value = ex;
        }
        _triggerPosterFetch();
    });
    document.getElementById("sd-add-fab").addEventListener("click", showAddForm);
    document.getElementById("sd-add-cancel").addEventListener("click", () => {
        document.getElementById("sd-add-form").classList.add("sd-hidden");
        _pendingType = null;
    });

    async function saveItem(type) {
        _pendingType = type;
        const rawUrl = document.getElementById("sd-add-url").value.trim();
        let   title  = document.getElementById("sd-add-title").value.trim();
        if (!title && rawUrl) title = _extractTitleFromUrl(rawUrl) || rawUrl;
        if (!title || !_openDrawerLinkId) return;
        const itemUrl   = rawUrl && _isSafeUrl(rawUrl) ? rawUrl : null;
        const rawPoster = document.getElementById("sd-add-poster")?.value || "";
        const posterUrl = rawPoster && _isSafeUrl(rawPoster) ? rawPoster : null;
        try {
            await _saveStreamItem(_openDrawerLinkId, type, title, itemUrl, posterUrl);
            document.getElementById("sd-add-form").classList.add("sd-hidden");
            _pendingType = null;
            _renderLibrary();
        } catch (err) { console.error(err); toast("Error adding item", "error"); }
    }
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

async function _openLibrary(linkId) {
    _ensureStreamingDrawer();
    _openDrawerLinkId = linkId;

    const link   = _links.find(l => l.id === linkId);
    const title  = link?.title || _domain(link?.url || "") || "Streaming";
    const domain = _domain(link?.url || "");

    document.getElementById("sd-title").textContent = title;
    const fav = document.getElementById("sd-favicon");
    if (domain) { fav.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`; fav.style.display = ""; }
    else        { fav.style.display = "none"; }

    const visitEl = document.getElementById("sd-visit-btn");
    if (link?.url && _isSafeUrl(link.url)) visitEl.href = link.url; else visitEl.removeAttribute("href");

    document.getElementById("sd-add-form").classList.add("sd-hidden");
    document.getElementById("sd-body").innerHTML = `<div class="sd-loading">Loading…</div>`;
    document.getElementById("sd-stats").textContent = "";
    _sdActiveTab = "all";
    document.getElementById("streaming-drawer").querySelectorAll(".sd-tab").forEach(t =>
        t.classList.toggle("sd-tab-active", t.dataset.sdTab === "all")
    );

    const drawer = document.getElementById("streaming-drawer");
    drawer.classList.remove("sd-closed");
    requestAnimationFrame(() => drawer.classList.add("sd-open"));

    await _loadStreamItems(linkId);
    if (_openDrawerLinkId === linkId) _renderLibrary();
}

function _closeLibrary() {
    const el = document.getElementById("streaming-drawer");
    if (!el) return;
    el.classList.remove("sd-open");
    el.addEventListener("transitionend", () => {
        if (!el.classList.contains("sd-open")) el.classList.add("sd-closed");
    }, { once: true });
    _openDrawerLinkId = null;
}

function _renderLibrary() {
    const linkId = _openDrawerLinkId;
    if (!linkId) return;
    const items  = _streamCache[linkId] || [];
    const movies = items.filter(i => i.type === "movie");
    const series = items.filter(i => i.type === "series");
    const mDone  = movies.filter(i => i.watched).length;
    let totalEps = 0, doneEps = 0;
    series.forEach(s => (s.seasons || []).forEach(se => { totalEps += se.eps || 0; doneEps += (se.watched || []).length; }));

    const totalTracked = movies.length + totalEps;
    const doneTracked  = mDone + doneEps;
    const pctOverall   = totalTracked ? Math.round(doneTracked / totalTracked * 100) : 0;

    const parts = [];
    if (movies.length) parts.push(`${mDone}/${movies.length} movies`);
    if (series.length) parts.push(`${doneEps}/${totalEps} eps`);
    document.getElementById("sd-stats").textContent = parts.join(" · ") || "Nothing tracked yet";
    const fill = document.getElementById("sd-progress-fill");
    if (fill) fill.style.width = `${pctOverall}%`;

    const showMovies = _sdActiveTab === "all" || _sdActiveTab === "movie";
    const showSeries = _sdActiveTab === "all" || _sdActiveTab === "series";

    const body = document.getElementById("sd-body");
    if (!items.length) {
        body.innerHTML = `<div class="sd-empty"><span class="material-symbols-outlined" style="font-size:2.5rem;opacity:.18">video_library</span><span>Add movies and series to track.</span></div>`;
        return;
    }

    let html = "";

    if (showMovies && movies.length) {
        html += `<div class="sd-section">
            <div class="sd-section-hdr"><span class="material-symbols-outlined">movie</span>Movies<span class="sd-section-count">${mDone}/${movies.length}</span></div>
            <div class="sd-movies-grid">` +
        movies.map(m => {
            const rawUrl   = m.url && _isSafeUrl(m.url) ? m.url : (m.title && _isSafeUrl(m.title) ? m.title : null);
            const safeUrl  = rawUrl ? escHtml(rawUrl) : null;
            const dispTitle = m.title && !_isSafeUrl(m.title)
                ? m.title
                : (rawUrl ? _extractTitleFromUrl(rawUrl) || rawUrl : m.title || "");
            return `
            <div class="sd-movie-card${m.watched ? " sd-movie-watched" : ""}">
                ${safeUrl
                    ? `<a class="sd-movie-poster" href="${safeUrl}" target="_blank" rel="noopener noreferrer">`
                    : `<div class="sd-movie-poster">`}
                    ${m.posterUrl && _isSafeUrl(m.posterUrl)
                        ? `<img class="sd-movie-poster-img" src="${escHtml(m.posterUrl)}" alt="" loading="lazy">`
                        : `<span class="material-symbols-outlined sd-movie-icon">movie</span>`}
                    <div class="sd-movie-watched-overlay"><span class="material-symbols-outlined">check_circle</span></div>
                ${safeUrl ? `</a>` : `</div>`}
                <button class="sd-watched-toggle" data-item-action="toggle-movie" data-item-id="${escHtml(m.id)}" title="${m.watched ? "Mark unwatched" : "Mark watched"}">
                    <span class="material-symbols-outlined">${m.watched ? "check_circle" : "radio_button_unchecked"}</span>
                </button>
                <div class="sd-movie-info">
                    ${safeUrl
                        ? `<a class="sd-movie-title sd-movie-title-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</a>`
                        : `<span class="sd-movie-title" title="${escHtml(dispTitle)}">${escHtml(dispTitle)}</span>`}
                    <button class="sd-del-btn" data-item-action="delete" data-item-id="${escHtml(m.id)}" title="Remove">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>`;}).join("") +
        `</div></div>`;
    }

    if (showSeries && series.length) {
        const seriesEpsDone  = series.reduce((a, s) => a + (s.seasons || []).reduce((b, se) => b + (se.watched || []).length, 0), 0);
        const seriesEpsTotal = series.reduce((a, s) => a + (s.seasons || []).reduce((b, se) => b + (se.eps || 0), 0), 0);
        html += `<div class="sd-section">
            <div class="sd-section-hdr"><span class="material-symbols-outlined">tv</span>Series<span class="sd-section-count">${seriesEpsDone}/${seriesEpsTotal} eps</span></div>
            <div class="sd-movies-grid">` +
        series.map(s => {
            const tot  = (s.seasons || []).reduce((a, se) => a + (se.eps || 0), 0);
            const done = (s.seasons || []).reduce((a, se) => a + (se.watched || []).length, 0);
            const pct  = tot ? Math.round(done / tot * 100) : 0;
            const sRawUrl = s.url && _isSafeUrl(s.url) ? s.url : (s.title && _isSafeUrl(s.title) ? s.title : null);
            const sDisp = s.title && !_isSafeUrl(s.title) ? s.title : (sRawUrl ? _extractTitleFromUrl(sRawUrl) || sRawUrl : s.title || "");
            const seasonsHtml = (s.seasons || []).map((se, idx) => {
                const eps     = se.eps || 0;
                const wSet    = new Set(se.watched || []);
                const allDone = wSet.size === eps && eps > 0;
                const bubbles = Array.from({ length: eps }, (_, i) => i + 1)
                    .map(ep => `<button class="sd-ep${wSet.has(ep) ? " sd-ep-done" : ""}" data-item-action="toggle-ep" data-item-id="${escHtml(s.id)}" data-season="${idx}" data-ep="${ep}" title="S${se.s}E${ep}">${ep}</button>`)
                    .join("");
                return `
                    <div class="sd-season-row">
                        <span class="sd-s-label${allDone ? " sd-s-done" : ""}">S${se.s}</span>
                        <div class="sd-ep-wrap">${bubbles}</div>
                        <span class="sd-ep-count">${wSet.size}/${eps}</span>
                    </div>`;
            }).join("");
            return `
            <div class="sd-movie-card sd-series-tile" data-item-id="${escHtml(s.id)}">
                <button class="sd-movie-poster" data-item-action="expand-series" data-item-id="${escHtml(s.id)}">
                    ${s.posterUrl && _isSafeUrl(s.posterUrl)
                        ? `<img class="sd-movie-poster-img" src="${escHtml(s.posterUrl)}" alt="" loading="lazy">`
                        : `<span class="material-symbols-outlined sd-movie-icon">tv</span>`}
                    ${tot > 0 ? `<div class="sd-tile-prog"><div class="sd-tile-prog-fill" style="width:${pct}%"></div></div>` : ""}
                    ${s.seasons?.length ? `<div class="sd-season-badge">${s.seasons.length} S</div>` : ""}
                </button>
                <div class="sd-movie-info">
                    <span class="sd-movie-title" title="${escHtml(sDisp)}">${escHtml(sDisp)}</span>
                    <button class="sd-del-btn" data-item-action="delete" data-item-id="${escHtml(s.id)}" title="Remove">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="sd-series-expand sd-hidden">
                    ${seasonsHtml ? `<div class="sd-seasons">${seasonsHtml}</div>` : ""}
                    ${!s.seasons?.length ? `<div class="sd-no-seasons">No seasons yet.</div>` : ""}
                    <button class="sd-sf-add-btn" data-item-action="add-season" data-item-id="${escHtml(s.id)}">
                        <span class="material-symbols-outlined" style="font-size:11px">add</span>Season
                    </button>
                </div>
            </div>`;
        }).join("") +
        `</div></div>`;
    }

    if (!html) {
        const typeName = _sdActiveTab === "movie" ? "movies" : "series";
        html = `<div class="sd-empty"><span class="material-symbols-outlined" style="font-size:2.5rem;opacity:.18">${_sdActiveTab === "movie" ? "movie" : "tv"}</span><span>No ${typeName} tracked yet.</span></div>`;
    }

    body.innerHTML = html;

    // Restore expanded series tiles
    _sdExpandedIds.forEach(id => {
        const tile = body.querySelector(`.sd-series-tile[data-item-id="${id}"]`);
        tile?.querySelector(".sd-series-expand")?.classList.remove("sd-hidden");
    });
}

async function _onLibraryBodyClick(e) {
    const btn    = e.target.closest("[data-item-action]");
    if (!btn) return;
    const action = btn.dataset.itemAction;
    const itemId = btn.dataset.itemId;
    const linkId = _openDrawerLinkId;
    if (!linkId || !itemId) return;
    if (action === "expand-series") {
        const tile = btn.closest(".sd-series-tile");
        const exp  = tile?.querySelector(".sd-series-expand");
        if (!exp) return;
        const id = tile.dataset.itemId;
        exp.classList.toggle("sd-hidden");
        exp.classList.contains("sd-hidden") ? _sdExpandedIds.delete(id) : _sdExpandedIds.add(id);
        return;
    }
    const items = _streamCache[linkId] || [];
    const item  = items.find(i => i.id === itemId);
    if (!item) return;

    if (action === "toggle-movie") {
        item.watched = !item.watched;
        try { await updateDoc(doc(_db, "users", _user.uid, "gallery-links", linkId, "streaming-items", itemId), { watched: item.watched }); }
        catch (err) { console.error(err); }
        _renderLibrary();

    } else if (action === "toggle-ep") {
        const sIdx = parseInt(btn.dataset.season, 10);
        const ep   = parseInt(btn.dataset.ep, 10);
        const se   = item.seasons?.[sIdx];
        if (!se) return;
        const wSet = new Set(se.watched || []);
        wSet.has(ep) ? wSet.delete(ep) : wSet.add(ep);
        se.watched = [...wSet].sort((a, b) => a - b);
        try { await updateDoc(doc(_db, "users", _user.uid, "gallery-links", linkId, "streaming-items", itemId), { seasons: item.seasons }); }
        catch (err) { console.error(err); }
        _renderLibrary();

    } else if (action === "add-season") {
        const expand = btn.closest(".sd-series-expand");
        if (!expand || expand.querySelector(".sd-season-form")) return;
        const nextS = (item.seasons?.length || 0) + 1;
        const form  = document.createElement("div");
        form.className = "sd-season-form";
        form.innerHTML = `
            <span class="sd-sf-label">S${nextS} eps:</span>
            <input type="number" class="sd-sf-input" min="1" max="99" placeholder="?" autocomplete="off">
            <button type="button" class="sd-save-btn sd-sf-ok">Add</button>
            <button type="button" class="sd-cancel-btn sd-sf-x">✕</button>`;
        expand.insertBefore(form, btn);
        form.querySelector(".sd-sf-input").focus();
        form.querySelector(".sd-sf-x").addEventListener("click", () => form.remove());
        const doAdd = async () => {
            const eps = parseInt(form.querySelector(".sd-sf-input").value, 10);
            if (!eps || eps < 1 || eps > 99) { form.querySelector(".sd-sf-input").style.borderColor = "var(--danger)"; return; }
            item.seasons = [...(item.seasons || []), { s: nextS, eps, watched: [] }];
            form.remove();
            _sdExpandedIds.add(itemId); // keep expanded after re-render
            try { await updateDoc(doc(_db, "users", _user.uid, "gallery-links", linkId, "streaming-items", itemId), { seasons: item.seasons }); }
            catch (err) { console.error(err); }
            _renderLibrary();
        };
        form.querySelector(".sd-sf-ok").addEventListener("click", doAdd);
        form.querySelector(".sd-sf-input").addEventListener("keydown", e => {
            if (e.key === "Enter")  doAdd();
            if (e.key === "Escape") form.remove();
        });

    } else if (action === "delete") {
        const ok = await confirm(`Remove "${item.title}"?`);
        if (!ok) return;
        try {
            await deleteDoc(doc(_db, "users", _user.uid, "gallery-links", linkId, "streaming-items", itemId));
            _streamCache[linkId] = _streamCache[linkId].filter(i => i.id !== itemId);
        } catch (err) { console.error(err); toast("Error removing", "error"); return; }
        _renderLibrary();
    }
}

function _showReturnPrompt(linkId, serviceTitle) {
    document.getElementById("sd-return-prompt")?.remove();
    const el = document.createElement("div");
    el.id = "sd-return-prompt";
    el.className = "sd-return-prompt";
    el.innerHTML = `
        <span class="material-symbols-outlined" style="font-size:1rem;flex-shrink:0;opacity:.7">smart_display</span>
        <span>Back from <strong>${escHtml(serviceTitle)}</strong>? Update your library.</span>
        <button id="sd-rp-open" class="ws-btn ws-btn-accent ws-btn-sm">Open</button>
        <button id="sd-rp-dismiss" class="link-card-action-btn" title="Dismiss">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("visible"));
    const dismiss = () => { el.classList.remove("visible"); setTimeout(() => el.remove(), 220); };
    document.getElementById("sd-rp-open").addEventListener("click", () => { dismiss(); _openLibrary(linkId); });
    document.getElementById("sd-rp-dismiss").addEventListener("click", dismiss);
    setTimeout(dismiss, 10000);
}

/* ══════════ HELPERS ══════════ */

function _isSafeUrl(url) {
    try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; }
    catch { return false; }
}
function _domain(url) { try { return new URL(url).hostname; } catch { return null; } }
function _shortUrl(url) {
    try {
        const u = new URL(url);
        const p = u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "";
        return u.hostname + (p.length > 32 ? p.slice(0, 32) + "…" : p);
    } catch { return url; }
}
