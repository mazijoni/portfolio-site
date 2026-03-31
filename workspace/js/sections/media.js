/**
 * sections/media.js — Project-scoped Media & Links tab.
 *
 * Firestore:
 *   users/{uid}/links   — all link documents, field `categoryId` points to
 *                         the parent "category" (private.html) or project id.
 *
 * When the active project was migrated from private.html it carries a
 * `sourceCategoryId` field.  Links for that project live in
 *   users/{uid}/links where categoryId === sourceCategoryId
 *
 * For newly-created workspace projects (no sourceCategoryId) links are stored
 * in the same collection with  categoryId === projectId.
 */

import {
    onSnapshot, collection, query, where,
    addDoc, deleteDoc, updateDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                from "../app.js";
import { currentProjectId,
         currentProject }          from "../projects.js";
import { escHtml, toast, confirm,
         openModal, closeModal }    from "../ui.js";

let _uid        = null;
let _unsub      = null;
let _links      = [];
let _catId      = null;   // categoryId value to filter links by
let _search     = "";
let _init       = false;
let _layout     = localStorage.getItem("mediaLayout") || "grid";

// Link modal state
let _editLinkId = null;

export function init() {
    if (_init) return;
    _init = true;

    // Apply saved layout on load
    _applyLayout(_layout);

    // Layout toggle buttons
    document.getElementById("btn-layout-grid").addEventListener("click", () => _applyLayout("grid"));
    document.getElementById("btn-layout-list").addEventListener("click", () => _applyLayout("list"));

    document.getElementById("media-search").addEventListener("input", (e) => {
        _search = e.target.value.trim().toLowerCase();
        _render();
    });

    // Search icon toggle
    const toolbar   = document.getElementById("media-toolbar");
    const searchInput = document.getElementById("media-search");

    document.getElementById("btn-media-search").addEventListener("click", () => {
        toolbar.classList.add("searching");
        searchInput.focus();
    });

    document.getElementById("btn-media-search-close").addEventListener("click", () => {
        toolbar.classList.remove("searching");
        searchInput.value = "";
        _search = "";
        _render();
    });

    document.getElementById("btn-add-media-link")
        .addEventListener("click", () => _openLinkModal(null));

    document.getElementById("form-media-link")
        .addEventListener("submit", _onLinkSubmit);

    document.getElementById("ml-field-type")
        .addEventListener("change", _updateLinkFields);
    
    document.getElementById("ml-field-name")
        .addEventListener("input", _onNameInput);

    // Creator panel back button
    const cpBack = document.getElementById("cp-back");
    if (cpBack) {
        cpBack.addEventListener("click", () => {
            document.getElementById("creator-panel")?.classList.remove("active");
        });
    }

    // Re-subscribe whenever the selected project changes
    window.addEventListener("projectSelected", () => {
        _catId = currentProject?.sourceCategoryId ?? currentProjectId ?? null;
        _subscribe();
    });

    _uid = auth.currentUser?.uid;
    if (_uid) {
        _catId = currentProject?.sourceCategoryId ?? currentProjectId ?? null;
        _subscribe();
    } else {
        const iv = setInterval(() => {
            if (auth.currentUser) {
                _uid = auth.currentUser.uid;
                clearInterval(iv);
                _catId = currentProject?.sourceCategoryId ?? currentProjectId ?? null;
                _subscribe();
            }
        }, 200);
    }
}

function _subscribe() {
    if (_unsub) { _unsub(); _unsub = null; }
    if (!_uid || !_catId) { _render(); return; }

    const q = query(
        collection(db, "users", _uid, "links"),
        where("categoryId", "==", _catId)
    );
    _unsub = onSnapshot(q,
        (snap) => {
            _links = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
            _render();
        },
        (err) => {
            console.error("[media] Firestore error:", err);
            _render();
        }
    );
}

/* ── Layout ──────────────────────────────────────────────────────────── */

function _applyLayout(layout) {
    _layout = layout;
    localStorage.setItem("mediaLayout", layout);
    const body = document.getElementById("media-body");
    if (body) {
        body.classList.toggle("layout-list", layout === "list");
    }
    document.querySelectorAll(".media-layout-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.layout === layout);
    });
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function _render() {
    const body = document.getElementById("media-body");
    if (!body) return;

    const loading = document.getElementById("media-loading");
    if (loading) loading.remove();

    body.innerHTML = "";

    if (!_catId) {
        body.innerHTML = `<div class="ws-placeholder">Select a project from the sidebar to view its media.</div>`;
        return;
    }

    const visible = _search
        ? _links.filter(l =>
            (l.name || "").toLowerCase().includes(_search) ||
            (l.url  || "").toLowerCase().includes(_search))
        : _links;

    if (!visible.length && _search) {
        body.innerHTML = `<div class="ws-placeholder">No matches.</div>`;
        return;
    }

    const sites    = visible.filter(l => l.type !== "video" && l.type !== "image" && l.type !== "creator" && l.type !== "person");
    const videos   = visible.filter(l => l.type === "video");
    const images   = visible.filter(l => l.type === "image");
    const creators = visible.filter(l => l.type === "creator");
    const persons  = visible.filter(l => l.type === "person");

    const sectionsData = {
        site:    { label: "Sites",                gridHtml: _sitesGrid(sites),                count: sites.length },
        video:   { label: "Video",                gridHtml: _mediaGrid(videos, "video"),      count: videos.length },
        image:   { label: "Image",                gridHtml: _mediaGrid(images, "image"),      count: images.length },
        creator: { label: "Creators",             gridHtml: _creatorsGrid(creators, "creator"),count: creators.length },
        person:  { label: "Persons / Characters", gridHtml: _creatorsGrid(persons, "person"),  count: persons.length }
    };

    const defaultOrder = ["site", "video", "image", "creator", "person"];
    let order = currentProject.mediaSectionOrder;
    if (!Array.isArray(order) || !order.length) order = defaultOrder;
    order = [...new Set([...order, ...defaultOrder])];

    order.forEach(typeKey => {
        const sec = sectionsData[typeKey];
        if (sec && sec.count > 0) {
            body.appendChild(_makeSubGroup(typeKey, sec.label, sec.gridHtml));
        }
    });
}

function _addTypeCard(typeLabel, iconSvg, typeVal) {
    const btn = document.createElement("button");
    btn.className = "add-type-card";
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg><span class="add-type-label">Add ${typeLabel}</span>`;
    btn.addEventListener("click", () => _openLinkModal(null, typeVal));
    return btn;
}

/* ── Card action overlay helper ── */

function _cardActions(link) {
    const wrap = document.createElement("div");
    wrap.className = "db-card-actions";
    wrap.innerHTML = `
        <button class="db-card-action-btn" title="Edit">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="db-card-action-btn db-card-del-btn" title="Delete">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>`;
    wrap.querySelector(".db-card-action-btn").addEventListener("click",    (e) => { e.preventDefault(); e.stopPropagation(); _openLinkModal(link); });
    wrap.querySelector(".db-card-del-btn").addEventListener("click",       (e) => { e.preventDefault(); e.stopPropagation(); _confirmDeleteLink(link); });
    return wrap;
}

function _makeSubGroup(typeKey, label, gridEl) {
    const sg = document.createElement("div");
    sg.className = "db-sub-group";
    sg.dataset.typeKey = typeKey;
    sg.innerHTML = `<div class="db-sub-header" style="cursor: grab;" title="Drag to reorder"><span class="db-sub-label">${label}</span><div class="db-sub-line"></div></div>`;
    sg.appendChild(gridEl);

    const header = sg.querySelector(".db-sub-header");
    header.addEventListener("mousedown", () => sg.setAttribute("draggable", "true"));
    sg.addEventListener("mouseleave", () => sg.setAttribute("draggable", "false"));
    sg.addEventListener("mouseup", () => sg.setAttribute("draggable", "false"));

    sg.addEventListener("dragstart", (e) => {
        window._draggedMediaSg = sg;
        e.dataTransfer.effectAllowed = "move";
        setTimeout(() => sg.style.opacity = "0.4", 0);
    });

    sg.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!window._draggedMediaSg) return;
        const body = document.getElementById("media-body");

        const bodyRect = body.getBoundingClientRect();
        const y = e.clientY - bodyRect.top;
        if (y < 80) body.scrollTop -= 15;
        else if (y > bodyRect.height - 80) body.scrollTop += 15;

        const afterEl = [...body.querySelectorAll(".db-sub-group:not([style*='opacity: 0.4'])")].reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = e.clientY - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;

        if (afterEl == null) body.appendChild(window._draggedMediaSg);
        else body.insertBefore(window._draggedMediaSg, afterEl);
    });

    sg.addEventListener("dragend", async () => {
        sg.setAttribute("draggable", "false");
        sg.style.opacity = "1";
        if (window._draggedMediaSg) {
            window._draggedMediaSg = null;
            const newOrder = [...document.getElementById("media-body").querySelectorAll(".db-sub-group")].map(el => el.dataset.typeKey);
            if (currentProject) {
                currentProject.mediaSectionOrder = newOrder;
                const { updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js");
                updateDoc(doc(db, "users", auth.currentUser.uid, "projects", currentProject.id), { mediaSectionOrder: newOrder }).catch(console.error);
            }
        }
    });

    return sg;
}

/* ── Site cards ─────────────────────────────────────────────────────────── */

function _sitesGrid(links) {
    const grid = document.createElement("div");
    grid.className = "db-sites-grid";
    links.forEach(link => grid.appendChild(_buildSiteCard(link)));
    if (!_search) {
        grid.appendChild(_addTypeCard("Site", `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>`, "site"));
    }
    return grid;
}

function _buildSiteCard(link) {
    const card = document.createElement("div");
    card.className = "db-site-card";

    const faviconUrl  = _getFavicon(link.url);
    const thumbSrc    = link.imageUrl?.trim() || _getScreenshot(link.url);
    const prettyLabel = _prettyUrl(link.url);
    const fbId        = "fb_ws_" + link.id;

    card.innerHTML = `
        <a class="db-site-link" href="${escHtml(link.url || "#")}" target="_blank" rel="noopener noreferrer">
            <div class="db-site-thumb">
                <img class="db-site-thumb-img" src="${escHtml(thumbSrc)}" alt=""
                     onerror="this.style.display='none';document.getElementById('${fbId}').style.display='flex'">
                <div class="db-site-thumb-fb" id="${fbId}" style="display:none">
                    <img src="${escHtml(faviconUrl)}" alt="" onerror="this.style.display='none'">
                    <span>${escHtml(prettyLabel)}</span>
                </div>
            </div>
            <div class="db-site-body">
                <div class="db-site-name">${escHtml(link.name || prettyLabel)}</div>
                <div class="db-site-url">${escHtml(prettyLabel)}</div>
            </div>
        </a>`;
    card.appendChild(_cardActions(link));
    return card;
}

/* ── Media cards (video / image) ────────────────────────────────────────── */

function _mediaGrid(links, typeStr) {
    const grid = document.createElement("div");
    grid.className = "media-grid";
    links.forEach(link => {
        if (link.type === "video") grid.appendChild(_buildVideoCard(link));
        else                       grid.appendChild(_buildImageCard(link));
    });
    if (!_search) {
        if (typeStr === "video") {
            grid.appendChild(_addTypeCard("Video", `<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>`, "video"));
        } else {
            grid.appendChild(_addTypeCard("Image", `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`, "image"));
        }
    }
    return grid;
}

function _buildVideoCard(link) {
    const card = document.createElement("div");
    card.className = "video-card";

    const embed = link.url ? _getVideoEmbed(link.url) : null;
    const _vPersonIds = link.personIds || (link.personId ? [link.personId] : []);
    const _vPersons = _vPersonIds.map(id => _links.find(l => l.id === id)).filter(Boolean);
    const _vCreator = _findCreatorFor(link);

    let mediaHtml;
    let isThumbOnly = false;
    let isLinkOnly  = false;

    if (embed) {
        if (embed.type === "direct") {
            mediaHtml = `<video src="${escHtml(embed.src)}" controls style="position:absolute;inset:0;width:100%;height:100%;background:#000" preload="metadata"></video>`;
        } else {
            mediaHtml = `<iframe src="${escHtml(embed.src)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe>`;
        }
    } else if (link.thumbUrl) {
        isThumbOnly = true;
        mediaHtml = `
            <img src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.name || "")}" style="width:100%;height:auto;display:block;">
            <div class="video-thumb-play-overlay">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><path d="M13 10.5l10 5.5-10 5.5V10.5z" fill="white"/></svg>
            </div>`;
    } else if (link.url) {
        isLinkOnly = true;
        const domain = (() => { try { return new URL(link.url).hostname.replace(/^www\./, ""); } catch { return link.url; } })();
        mediaHtml = `<div class="video-link-placeholder">
            <svg width="36" height="36" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/><path d="M13 10.5l10 5.5-10 5.5V10.5z" fill="rgba(255,255,255,0.85)"/></svg>
            <span class="video-link-domain">${escHtml(domain)}</span>
        </div>`;
    } else {
        mediaHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:0.8rem">No video or thumbnail</div>`;
    }

    const badgeLabel = embed
        ? (embed.type === "youtube" ? "YT" : embed.type === "vimeo" ? "VIMEO" : "VIDEO")
        : (link.thumbUrl ? "IMG" : link.url ? "LINK" : "?");

    card.innerHTML = `
        <div class="video-iframe-wrap${isThumbOnly ? " video-iframe-wrap--thumb" : ""}">${mediaHtml}</div>
        <div class="video-card-body">
            <span class="video-type-badge">${badgeLabel}</span>
            <span class="video-card-name">${escHtml(link.name || "")}</span>
            ${link.url ? `<a class="card-source-link" href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
        </div>
        ${_vCreator ? `<div class="image-card-creator" title="Creator: ${escHtml(_vCreator.name || "")}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(_vCreator.name || "")}</span></div>` : ""}
        ${_vPersons.length ? `<div class="image-card-person" title="Click to view: ${escHtml(_vPersons.map(p => p.name).join(", "))}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(_vPersons.map(p => p.name).join(", "))}</span></div>` : ""}`;

    const creatorDiv = card.querySelector(".image-card-creator");
    const personDiv  = card.querySelector(".image-card-person");
    if (creatorDiv && _vCreator) creatorDiv.addEventListener("click", (e) => { e.stopPropagation(); _openCreatorPanel(_vCreator); });
    if (personDiv  && _vPersons.length) personDiv.addEventListener("click", (e) => { e.stopPropagation(); _openCreatorPanel(_vPersons[0]); });

    if (isThumbOnly) {
        const overlay  = card.querySelector(".video-thumb-play-overlay");
        const thumbImg = card.querySelector(".video-iframe-wrap img");
        const openLink = link.url
            ? () => window.open(link.url, "_blank", "noopener,noreferrer")
            : () => {};
        if (overlay)  { overlay.style.cursor = "pointer"; overlay.addEventListener("click", openLink); }
        if (thumbImg) { thumbImg.style.cursor = "pointer"; thumbImg.addEventListener("click", openLink); }
    }
    if (isLinkOnly) {
        const ph = card.querySelector(".video-link-placeholder");
        if (ph) ph.addEventListener("click", () => window.open(link.url, "_blank", "noopener,noreferrer"));
    }

    card.appendChild(_cardActions(link));
    return card;
}

function _buildImageCard(link) {
    const card = document.createElement("div");
    card.className = "image-card";

    const src = link.url || link.imageUrl || "";
    const _personIds = link.personIds || (link.personId ? [link.personId] : []);
    const _persons = _personIds.map(id => _links.find(l => l.id === id)).filter(Boolean);
    const _creator = _findCreatorFor(link);

    const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'%3E%3Crect fill='%231a1a1a' width='4' height='3'/%3E%3C/svg%3E";

    card.innerHTML = `
        ${src
            ? `<img class="image-card-img" src="${escHtml(src)}" alt="${escHtml(link.name || "")}" onerror="this.src='${fallback}'">`
            : `<div style="background:#111;min-height:80px;display:flex;align-items:center;justify-content:center;color:#444;font-size:0.72rem">No image</div>`}
        <div class="image-card-body">
            <span class="image-type-badge">IMG</span>
            <span class="image-card-name">${escHtml(link.name || "")}</span>
            ${link.sourceUrl ? `<a class="card-source-link" href="${escHtml(link.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="Go to source" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
        </div>
        ${_creator ? `<div class="image-card-creator" title="Creator: ${escHtml(_creator.name || "")}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>${escHtml(_creator.name || "")}</span></div>` : ""}
        ${_persons.length ? `<div class="image-card-person" title="Click to view: ${escHtml(_persons.map(p => p.name).join(", "))}"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="#55ccbb" stroke-width="1.3"/><path d="M1 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="#55ccbb" stroke-width="1.3" stroke-linecap="round"/></svg><span class="image-card-person-name">${escHtml(_persons.map(p => p.name).join(", "))}</span></div>` : ""}`;

    const imgEl = card.querySelector(".image-card-img");
    if (imgEl && src) imgEl.addEventListener("click", () => window.open(src, "_blank", "noopener,noreferrer"));

    const creatorDiv = card.querySelector(".image-card-creator");
    const personDiv  = card.querySelector(".image-card-person");
    if (creatorDiv && _creator) creatorDiv.addEventListener("click", (e) => { e.stopPropagation(); _openCreatorPanel(_creator); });
    if (personDiv  && _persons.length) personDiv.addEventListener("click", (e) => { e.stopPropagation(); _openCreatorPanel(_persons[0]); });

    card.appendChild(_cardActions(link));
    return card;
}

/* ── Creator cards ──────────────────────────────────────────────────────── */

function _creatorsGrid(links, typeStr) {
    const grid = document.createElement("div");
    grid.className = "creators-grid";
    links.forEach(link => grid.appendChild(_buildCreatorCard(link)));
    if (!_search) {
        if (typeStr === "creator") {
            grid.appendChild(_addTypeCard("Creator", `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`, "creator"));
        } else {
            grid.appendChild(_addTypeCard("Person", `<path d="M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2Z" stroke-dasharray="0" fill="none"></path><path d="M16 14C16 14 14.5 16 12 16C9.5 16 8 14 8 14"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line>`, "person"));
        }
    }
    return grid;
}

function _buildCreatorCard(link) {
    const card = document.createElement("div");
    card.className = "creator-card";

    const isChar    = link.type === "person";
    const avatarSrc = link.avatarUrl || "";
    const { cls: badgeCls, label: badgeDisplayStr, color: badgeCol, isCustom } = _getPlatformBadge(link);
    const badgeStyle = (isCustom && badgeCol) ? ` style="color:${escHtml(badgeCol)};border-color:${escHtml(badgeCol)}66"` : "";
    const usernameDisplay = link.username ? `@${link.username}` : "";
    const linkedCount = _matchLinked(link).length;

    card.innerHTML = `
        ${avatarSrc
            ? `<img class="creator-avatar" src="${escHtml(avatarSrc)}" alt="${escHtml(link.name || "")}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
               <div class="creator-avatar-fallback" style="display:none">👤</div>`
            : `<div class="creator-avatar-fallback">👤</div>`}
        <div class="creator-info">
            <div class="creator-name">${escHtml(link.name || "")}</div>
            <div class="creator-meta">
                ${isChar
                    ? `<span class="creator-platform-badge person">char</span>`
                    : (badgeDisplayStr ? `<span class="creator-platform-badge ${badgeCls}"${badgeStyle}>${escHtml(badgeDisplayStr)}</span>` : "")}
                ${usernameDisplay ? `<span class="creator-username">${escHtml(usernameDisplay)}</span>` : ""}
                ${linkedCount > 0 ? `<span class="creator-media-count" title="${linkedCount} linked item${linkedCount !== 1 ? "s" : ""}">${linkedCount}</span>` : ""}
            </div>
            ${(link.desc || link.description) ? `<div class="creator-desc">${escHtml(link.desc || link.description)}</div>` : ""}
        </div>
        ${ (link.url || link.profileUrl) ? `<a class="creator-card-link" href="${escHtml(link.url || link.profileUrl)}" target="_blank" rel="noopener noreferrer" title="Open profile" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5.5 1H9v3.5M9 1L4 6M2 3.5H1v5.5h5.5V8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}`;

    card.addEventListener("click", (e) => {
        if (e.target.closest(".db-card-actions") || e.target.closest(".creator-card-link")) return;
        _openCreatorPanel(link);
    });
    card.appendChild(_cardActions(link));
    return card;
}

function _getPlatformBadge(link) {
    let lbl = link.badgeLabel || "";
    let col = link.badgeColor || "";

    const linkUrl = link.url || link.profileUrl || "";
    let h = "";
    if (linkUrl) {
        try { h = new URL(linkUrl).hostname.replace(/^www\./, ""); } catch { h = ""; }
    }

    if (!lbl && h) {
        const peer = _links.find(l => {
            if (l.type !== "creator" || !l.badgeLabel) return false;
            const u = l.url || l.profileUrl || "";
            if (!u) return false;
            try { return new URL(u).hostname.replace(/^www\./, "") === h; } catch { return false; }
        });
        if (peer) {
            lbl = peer.badgeLabel;
            col = peer.badgeColor || "";
        }
    }

    let defaultLabel = "";
    let cls = "other";

    if (h) {
        if (h.includes("youtube.com") || h === "youtu.be") { cls = "yt"; defaultLabel = "YT"; }
        else if (h.includes("twitter.com") || h.includes("x.com")) { cls = "tw"; defaultLabel = "X"; }
        else if (h.includes("instagram.com")) { cls = "ig"; defaultLabel = "IG"; }
        else if (h.includes("tiktok.com")) { cls = "ttk"; defaultLabel = "TikTok"; }
        else if (h.includes("twitch.tv")) { cls = "twitch"; defaultLabel = "Twitch"; }
        else if (h.includes("vimeo.com")) { cls = "other"; defaultLabel = "Vimeo"; }
    } else if (link.platform) {
        const map = {
            youtube:  { cls: "yt",     label: "YT" },
            twitter:  { cls: "tw",     label: "X" },
            instagram:{ cls: "ig",     label: "IG" },
            tiktok:   { cls: "ttk",    label: "TikTok" },
            twitch:   { cls: "twitch", label: "Twitch" },
        };
        const mapped = map[link.platform];
        if (mapped) {
            cls = mapped.cls;
            defaultLabel = mapped.label;
        } else {
            defaultLabel = link.platform;
        }
    }

    return { cls, label: lbl || defaultLabel, color: col, isCustom: !!lbl };
}

/* ── Creator attribution helpers ────────────────────────────────────────── */

function _findCreatorFor(link) {
    if (!link || (link.type !== "image" && link.type !== "video")) return null;
    if (link.creatorId) return _links.find(l => l.id === link.creatorId) ?? null;
    if (!link.url) return null;
    // Auto-match: if media URL path starts with a creator's URL path on the same host
    for (const c of _links.filter(l => l.type === "creator")) {
        if (!c.url) continue;
        try {
            const cu = new URL(c.url);
            const mu = new URL(link.url);
            if (cu.hostname === mu.hostname) {
                const cPath = cu.pathname.replace(/\/$/, "");
                const mPath = mu.pathname.replace(/\/$/, "");
                if (cPath && (mPath === cPath || mPath.startsWith(cPath + "/"))) return c;
            }
        } catch { /* noop */ }
    }
    return null;
}

function _findPersonFor(link) {
    const ids = link.personIds || (link.personId ? [link.personId] : []);
    return ids.map(id => _links.find(l => l.id === id)).filter(Boolean);
}

function _matchLinked(creator) {
    return _links.filter(l => {
        if (l.type === "creator" || l.type === "person") return false;
        const pIds = l.personIds || (l.personId ? [l.personId] : []);
        if (l.creatorId === creator.id || pIds.includes(creator.id)) return true;
        return _findCreatorFor(l)?.id === creator.id;
    });
}

function _openCreatorPanel(creator) {
    if (!creator) return;
    const isChar  = creator.type === "person";
    const matched = _matchLinked(creator);

    const avatarSrc = creator.avatarUrl || "";
    const panel = document.getElementById("creator-panel");
    if (!panel) return;

    // Header: avatar
    const avatarEl    = document.getElementById("cp-avatar");
    const fallbackEl  = document.getElementById("cp-avatar-fallback");
    if (avatarSrc) {
        avatarEl.src = avatarSrc;
        avatarEl.style.display    = "";
        fallbackEl.style.display  = "none";
    } else {
        avatarEl.style.display    = "none";
        fallbackEl.style.display  = "flex";
    }

    document.getElementById("cp-name").textContent = creator.name || "";

    const badge = document.getElementById("cp-badge");
    if (isChar) {
        badge.textContent = "char";
        badge.className   = "creator-platform-badge person";
        badge.style.display = "";
    } else {
        const { cls, label, color } = _getPlatformBadge(creator);
        if (label) {
            badge.textContent = label;
            badge.className   = `creator-platform-badge ${cls}`;
            badge.style.color       = color || "";
            badge.style.borderColor = color ? color + "66" : "";
            badge.style.display = "";
        } else {
            badge.style.display = "none";
        }
    }

    const usernameEl = document.getElementById("cp-username");
    usernameEl.textContent = (!isChar && creator.username) ? `@${creator.username}` : "";

    const descEl = document.getElementById("cp-desc");
    const descText = creator.desc || creator.description || "";
    if (descText) { descEl.textContent = descText; descEl.style.display = ""; }
    else descEl.style.display = "none";

    const profileBtn = document.getElementById("cp-profile-btn");
    const profileUrl = creator.url || creator.profileUrl || "";
    if (!isChar && profileUrl) {
        profileBtn.style.display = "";
        profileBtn.onclick = () => window.open(profileUrl, "_blank", "noopener,noreferrer");
    } else {
        profileBtn.style.display = "none";
    }

    // Body: linked media
    const body = document.getElementById("cp-body");
    body.innerHTML = "";

    if (matched.length === 0) {
        body.innerHTML = `<div class="creator-panel-empty">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.25"><rect x="6" y="10" width="36" height="28" rx="2" stroke="white" stroke-width="2"/><path d="M14 24h20M14 30h12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
            <p>No saved items ${isChar ? "tagged with this character" : "linked to this creator"} yet.</p>
        </div>`;
    } else {
        const countEl = document.createElement("p");
        countEl.className = "creator-panel-count";
        countEl.textContent = `${matched.length} saved item${matched.length !== 1 ? "s" : ""}`;
        body.appendChild(countEl);
        const grid = document.createElement("div");
        grid.className = "media-grid";
        matched.forEach(l => {
            if (l.type === "video")  grid.appendChild(_buildVideoCard(l));
            else                     grid.appendChild(_buildImageCard(l));
        });
        body.appendChild(grid);
    }

    panel.classList.add("active");

    document.getElementById("cp-back")._closeOnce = () => {
        panel.classList.remove("active");
    };

    const escHandler = (e) => {
        if (e.key === "Escape") {
            panel.classList.remove("active");
            document.removeEventListener("keydown", escHandler);
        }
    };
    document.addEventListener("keydown", escHandler);
}

/* ── Link CRUD ──────────────────────────────────────────────────────────── */

function _openLinkModal(link, defaultType = "site") {
    _editLinkId = link ? link.id : null;
    document.getElementById("modal-media-link-title").textContent = link ? "Edit Link" : "Add Link";
    document.getElementById("ml-field-type").value  = link?.type || defaultType;
    document.getElementById("ml-field-name").value  = link?.name || "";
    document.getElementById("ml-field-url").value   = link?.url || link?.profileUrl || "";
    document.getElementById("ml-field-img").value   = link?.imageUrl || link?.thumbUrl || link?.avatarUrl || "";
    document.getElementById("ml-field-desc").value  = link?.desc || link?.description || "";
    document.getElementById("ml-field-color").value = link?.badgeColor || "#888888";
    
    const hint = document.getElementById("ml-char-hint");
    if (hint) hint.textContent = "";

    const _badgeEl = document.getElementById("ml-field-badge");
    if (_badgeEl) _badgeEl.value = link?.badgeLabel || "";
    // Populate creator / person selects
    const creatorSel = document.getElementById("ml-field-creator");
    const personSel  = document.getElementById("ml-field-person");
    if (creatorSel && personSel) {
        creatorSel.innerHTML = '<option value="">\u2014 none \u2014</option>';
        personSel.innerHTML  = '<option value="">\u2014 none \u2014</option>';
        _links.filter(l => l.type === "creator").forEach(c => {
            const o = document.createElement("option");
            o.value = c.id; o.textContent = c.name || c.url || c.id;
            if (link && c.id === link.creatorId) o.selected = true;
            creatorSel.appendChild(o);
        });
        _links.filter(l => l.type === "person").forEach(p => {
            const o = document.createElement("option");
            o.value = p.id; o.textContent = p.name || p.url || p.id;
            const selPIds = link?.personIds || (link?.personId ? [link.personId] : []);
            if (selPIds.includes(p.id)) o.selected = true;
            personSel.appendChild(o);
        });
    }
    // Populate Source URL field for images
    const sourceField = document.getElementById("ml-field-source");
    if (sourceField) sourceField.value = link?.sourceUrl || "";
    _updateLinkFields();
    openModal("modal-media-link");
    setTimeout(() => document.getElementById("ml-field-name").focus(), 60);
}

function _updateLinkFields() {
    const type        = document.getElementById("ml-field-type").value;
    const imgGroup    = document.getElementById("ml-img-group");
    const sourceGroup = document.getElementById("ml-source-group");
    const descGroup   = document.getElementById("ml-desc-group");
    const badgeRow    = document.getElementById("ml-badge-row");
    const attrGroup   = document.getElementById("ml-attribution-group");
    const urlLabel    = document.getElementById("ml-url-label");
    const imgLabel    = document.getElementById("ml-img-label");
    imgGroup.style.display    = ["site", "video", "creator", "person"].includes(type) ? "" : "none";
    if (sourceGroup) sourceGroup.style.display = type === "image" ? "" : "none";
    descGroup.style.display   = ["creator", "person"].includes(type) ? "" : "none";
    if (badgeRow) badgeRow.style.display = ["creator", "person"].includes(type) ? "flex" : "none";
    if (attrGroup)  attrGroup.style.display  = ["image", "video"].includes(type) ? "" : "none";
    if (urlLabel) urlLabel.textContent = type === "image" ? "Image URL" : "URL";
    if      (type === "site")                          imgLabel.textContent = "Custom thumbnail URL";
    else if (type === "video")                         imgLabel.textContent = "Thumbnail URL";
    else if (type === "creator" || type === "person")  imgLabel.textContent = "Avatar URL";
}

const PLATFORM_LABELS = { youtube: 'YouTube', twitter: 'X / Twitter', instagram: 'Instagram', tiktok: 'TikTok', twitch: 'Twitch', other: '' };
const PERSON_NAME_ALIASES = {
    'ellie':   'Ellie (The Last of Us)',
    'sabrina': 'Sabrina Carpenter',
};

async function _onLinkSubmit(e) {
    e.preventDefault();
    const type  = document.getElementById("ml-field-type").value;
    const name  = document.getElementById("ml-field-name").value.trim();
    const url   = document.getElementById("ml-field-url").value.trim();
    const img   = document.getElementById("ml-field-img").value.trim();
    const desc  = document.getElementById("ml-field-desc").value.trim();
    const color = document.getElementById("ml-field-color").value;
    if (!name && !url) return;
    const data = { type, name, url, categoryId: _catId };
    if      (type === "site")                          { if (img) data.imageUrl  = img; }
    else if (type === "video")                         { if (img) data.thumbUrl  = img; }
    else if (type === "image")                         { const src = document.getElementById("ml-field-source")?.value.trim(); if (src) data.sourceUrl = src; }
    else if (type === "creator" || type === "person")  {
        if (img)  data.avatarUrl  = img;
        if (desc) data.desc       = desc;
        data.badgeColor = color;
        const _badgeLbl = document.getElementById("ml-field-badge")?.value.trim() || null;
        if (_badgeLbl !== null) data.badgeLabel = _badgeLbl;
    }
        data.creatorId = document.getElementById("ml-field-creator")?.value || null;
        const _pSel = document.getElementById("ml-field-person");
        data.personIds = _pSel ? Array.from(_pSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
        data.personId  = data.personIds[0] || null; // backward-compat

        // AUTO DETECTION & CREATION
        if (!data.creatorId) {
            const sourceUrl = type === "video" ? url : data.sourceUrl;
            if (sourceUrl) {
                const parsed = _parseCreatorUrl(sourceUrl);
                if (parsed && parsed.platform !== "other" && parsed.username) {
                    const existing = _links.find(l => l.type === 'creator' && l.platform === parsed.platform && l.username.toLowerCase() === parsed.username.toLowerCase());
                    if (existing) {
                        data.creatorId = existing.id;
                    } else {
                        // Create it right now
                        const profileUrls = { twitter: `https://x.com/${parsed.username}`, youtube: `https://www.youtube.com/@${parsed.username}`, instagram: `https://www.instagram.com/${parsed.username}`, tiktok: `https://www.tiktok.com/@${parsed.username}`, twitch: `https://www.twitch.tv/${parsed.username}` };
                        const profileUrl = profileUrls[parsed.platform] || "";
                        const avatarUrl = _getCreatorAvatar(parsed.platform, parsed.username);
                        const cData = { name: parsed.username, profileUrl, avatarUrl, description: "", platform: parsed.platform, username: parsed.username, type: "creator", categoryId: _catId, createdAt: serverTimestamp() };
                        const docRef = await addDoc(collection(db, "users", _uid, "links"), cData);
                        data.creatorId = docRef.id;
                        toast(`Creator @${parsed.username} auto-added.`);
                    }
                }
            }
        }

        if (!data.personId && !data.personIds.length && name) {
            let detectedId = _detectPersonIdFromText(name);
            if (detectedId) {
                data.personIds = [detectedId];
                data.personId = detectedId;
            } else {
                // Attempt to auto create
                const lowerName = name.toLowerCase();
                for (const [alias, canonical] of Object.entries(PERSON_NAME_ALIASES)) {
                    const aliasRe = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\b', 'i');
                    if (aliasRe.test(lowerName)) {
                        const existing = _links.find(l => (l.type === "person" || (l.type==="creator" && l.isCharacter)) && (l.name||"").toLowerCase() === canonical.toLowerCase());
                        if (existing) {
                            detectedId = existing.id;
                        } else {
                            let avatarUrl = '', description = '';
                            try {
                                const titleSlug = encodeURIComponent(canonical.replace(/ /g, '_'));
                                const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${titleSlug}`);
                                if (resp.ok) {
                                    const wData = await resp.json();
                                    avatarUrl = wData.thumbnail?.source || wData.originalimage?.source || '';
                                    description = wData.description || '';
                                }
                            } catch {}
                            const pData = { name: canonical, avatarUrl, description, type: "person", categoryId: _catId, createdAt: serverTimestamp() };
                            const docRef = await addDoc(collection(db, "users", _uid, "links"), pData);
                            detectedId = docRef.id;
                            toast(`Character ${canonical} auto-added.`);
                        }
                        break;
                    }
                }
                if (detectedId) {
                    data.personIds = [detectedId];
                    data.personId = detectedId;
                }
            }
        }
    try {
        if (_editLinkId) {
            await updateDoc(doc(db, "users", _uid, "links", _editLinkId), data);
        } else {
            data.createdAt = serverTimestamp();
            await addDoc(collection(db, "users", _uid, "links"), data);
        }
        closeModal("modal-media-link");
        toast(_editLinkId ? "Link updated" : "Link added", "success");
    } catch (err) {
        console.error(err);
        toast("Error saving link", "error");
    }
}

async function _confirmDeleteLink(link) {
    const ok = await confirm(`Delete "${link.name || link.url}"?`);
    if (!ok) return;
    try {
        await deleteDoc(doc(db, "users", _uid, "links", link.id));
        toast("Link deleted", "success");
    } catch (err) {
        console.error(err);
        toast("Error deleting link", "error");
    }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function _getFavicon(url) {
    try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
    catch { return ""; }
}

function _parseCreatorUrl(url) {
    try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, '');
        if (h === 'youtube.com' || h === 'youtu.be') {
            const m = u.pathname.match(/\/@([^/?#]+)/) || u.pathname.match(/\/c\/([^/?#]+)/) || u.pathname.match(/\/user\/([^/?#]+)/);
            return { platform: 'youtube', username: m ? m[1] : '' };
        }
        if (h === 'x.com' || h === 'twitter.com') {
            const m = u.pathname.match(/^\/([^/?#]+)/);
            return { platform: 'twitter', username: m ? m[1] : '' };
        }
        if (h === 'instagram.com') {
            const m = u.pathname.match(/^\/([^/?#]+)/);
            return { platform: 'instagram', username: m ? m[1] : '' };
        }
        if (h === 'tiktok.com') {
            const m = u.pathname.match(/^\/@?([^/?#]+)/);
            return { platform: 'tiktok', username: m ? m[1].replace(/^@/, '') : '' };
        }
        if (h === 'twitch.tv') {
            const m = u.pathname.match(/^\/([^/?#]+)/);
            return { platform: 'twitch', username: m ? m[1] : '' };
        }
        return { platform: 'other', username: '' };
    } catch { return null; }
}

function _getCreatorAvatar(platform, username) {
    if (!username) return '';
    switch (platform) {
        case 'youtube':   return `https://unavatar.io/youtube/${encodeURIComponent(username)}`;
        case 'twitter':   return `https://unavatar.io/twitter/${encodeURIComponent(username)}`;
        case 'instagram': return `https://unavatar.io/instagram/${encodeURIComponent(username)}`;
        case 'tiktok':    return `https://unavatar.io/tiktok/${encodeURIComponent(username)}`;
        case 'twitch':    return `https://unavatar.io/twitch/${encodeURIComponent(username)}`;
        default: return '';
    }
}

function _detectPersonIdFromText(text) {
    if (!text) return '';
    const persons = _links.filter(l => l.type === 'person' || (l.type === 'creator' && l.isCharacter));
    for (const person of persons) {
        const pName = (person.name || '').toLowerCase();
        const nameRe = new RegExp('\\b' + pName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\b', 'i');
        if (nameRe.test(text)) return person.id;
        for (const alias of (person.aliases || [])) {
            if (!alias) continue;
            const aliasRe = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\b', 'i');
            if (aliasRe.test(text)) return person.id;
        }
        for (const [alias, canonical] of Object.entries(PERSON_NAME_ALIASES)) {
            if (canonical.toLowerCase() === pName) {
                const aliasRe = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\b', 'i');
                if (aliasRe.test(text)) return person.id;
            }
        }
    }
    return '';
}

function _getScreenshot(url) {
    if (!url) return "";
    return `https://image.thum.io/get/width/600/crop/338/noanimate/${encodeURIComponent(url)}`;
}

function _prettyUrl(url) {
    try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, ""); }
    catch { return url || ""; }
}

function _getVideoEmbed(url) {
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

/* ── Wikipedia Auto-Fetch for Characters ── */

let _charNameTimer;
function _onNameInput() {
    if (document.getElementById("ml-field-type").value !== "person") return;
    clearTimeout(_charNameTimer);
    _charNameTimer = setTimeout(_autoFetchCharacterImage, 600);
}

async function _autoFetchCharacterImage() {
    const typeField = document.getElementById("ml-field-type");
    if (typeField.value !== "person") return;

    const name = document.getElementById("ml-field-name").value.trim();
    const hint = document.getElementById("ml-char-hint");
    if (!name) { if (hint) hint.textContent = ''; return; }
    
    const existingUrl = document.getElementById("ml-field-img").value.trim();
    if (existingUrl) return;

    if (hint) {
        hint.style.color = "var(--text-secondary)";
        hint.textContent = "Looking up\u2026";
    }

    try {
        const titleSlug = encodeURIComponent(name.replace(/ /g, "_"));
        const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${titleSlug}`);
        if (resp.ok) {
            const data = await resp.json();
            const thumbUrl = data.thumbnail?.source || data.originalimage?.source || "";
            const desc = data.description || "";
            if (thumbUrl) {
                document.getElementById("ml-field-img").value = thumbUrl;
                const descInput = document.getElementById("ml-field-desc");
                if (descInput && !descInput.value.trim() && desc) {
                    descInput.value = desc;
                }
                if (hint) {
                    hint.style.color = "var(--success)";
                    hint.textContent = `Found: "${data.title}"${desc ? ' \u2014 ' + desc : ''}`;
                }
                return;
            } else if (data.title && !data.missing) {
                if (hint) {
                    hint.style.color = "var(--text-secondary)";
                    hint.textContent = `Found "${data.title}" but no image \u2014 paste a URL manually.`;
                }
                return;
            }
        }
        
        // Fallback: action API
        const wikiQ = encodeURIComponent(name);
        const resp2 = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${wikiQ}&prop=pageimages|pageterms&format=json&pithumbsize=300&pilicense=any&origin=*`);
        if (!resp2.ok) throw new Error("API err");
        const json = await resp2.json();
        const page = Object.values(json.query?.pages || {})[0];
        
        if (!page || page.missing !== undefined) {
             if (hint) {
                 hint.style.color = "var(--text-secondary)";
                 hint.textContent = "No Wikipedia match \u2014 paste a URL manually.";
             }
             return;
        }
        
        const thumbUrl2 = page.thumbnail?.source || "";
        const desc2 = (page.terms?.description || [])[0] || "";
        
        if (thumbUrl2) {
            document.getElementById("ml-field-img").value = thumbUrl2;
            const descInput = document.getElementById("ml-field-desc");
            if (descInput && !descInput.value.trim() && desc2) {
                descInput.value = desc2;
            }
            if (hint) {
                hint.style.color = "var(--success)";
                hint.textContent = `Found: "${page.title}"${desc2 ? ' \u2014 ' + desc2 : ''}`;
            }
        } else {
             if (hint) {
                 hint.style.color = "var(--text-secondary)";
                 hint.textContent = `Found "${page.title}" but no image \u2014 paste a URL manually.`;
             }
        }
    } catch {
        if (hint) {
             hint.style.color = "var(--text-secondary)";
             hint.textContent = "Lookup failed \u2014 paste a URL manually.";
        }
    }
}
