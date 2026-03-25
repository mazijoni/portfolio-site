/**
 * sections/media.js — Full CRUD for Media Projects.
 *
 * Firestore collections (shared with original dashboard data):
 *   users/{uid}/categories   — project names + order  (UI calls them "projects")
 *   users/{uid}/links        — site / video / image / comic / creator cards
 */

import {
    onSnapshot, collection, query, orderBy,
    addDoc, deleteDoc, updateDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                from "../app.js";
import { escHtml, toast, confirm } from "../ui.js";

let _uid       = null;
let _unsubCat  = null;
let _unsubLnk  = null;
let _cats      = [];
let _links     = [];
let _search    = "";
let _init      = false;

// Modal state
let _editCatId     = null;   // null = new project
let _editLinkId    = null;   // null = new link
let _editLinkCatId = null;

export function init() {
    if (_init) return;
    _init = true;

    document.getElementById("media-search").addEventListener("input", (e) => {
        _search = e.target.value.trim().toLowerCase();
        _render();
    });

    document.getElementById("btn-add-media-project").addEventListener("click", () => _openProjectModal(null));
    document.getElementById("form-media-project").addEventListener("submit", _onProjectSubmit);
    document.getElementById("form-media-link").addEventListener("submit", _onLinkSubmit);
    document.getElementById("ml-field-type").addEventListener("change", _updateLinkFields);

    _uid = auth.currentUser?.uid;
    if (_uid) _subscribe();
    else {
        const iv = setInterval(() => {
            if (auth.currentUser) {
                _uid = auth.currentUser.uid;
                clearInterval(iv);
                _subscribe();
            }
        }, 200);
    }
}

function _subscribe() {
    if (_unsubCat) _unsubCat();
    if (_unsubLnk) _unsubLnk();

    const catsQ  = query(collection(db, "users", _uid, "categories"),  orderBy("createdAt"));
    const linksQ = query(collection(db, "users", _uid, "links"),        orderBy("createdAt"));

    let catsReady  = false;
    let linksReady = false;

    _unsubCat = onSnapshot(catsQ, (snap) => {
        _cats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        catsReady = true;
        if (linksReady) _render();
    });

    _unsubLnk = onSnapshot(linksQ, (snap) => {
        _links = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        linksReady = true;
        if (catsReady) _render();
    });
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

function _render() {
    const body = document.getElementById("media-body");
    if (!body) return;

    // Remove loading state
    const loading = document.getElementById("media-loading");
    if (loading) loading.remove();

    // Clear previous
    body.innerHTML = "";

    if (_cats.length === 0) {
        body.innerHTML = `<div class="ws-placeholder">No projects yet. Click <strong>+ Project</strong> to add one.</div>`;
        return;
    }

    _cats.forEach(cat => {
        const catLinks = _links.filter(l => l.categoryId === cat.id);
        body.appendChild(_buildProjectBlock(cat, catLinks));
    });
}

function _buildProjectBlock(cat, links) {
    // Filter by search
    const filtered = _search
        ? links.filter(l =>
            (l.name  || "").toLowerCase().includes(_search) ||
            (l.url   || "").toLowerCase().includes(_search))
        : links;

    const sites    = filtered.filter(l => l.type !== "video" && l.type !== "image" && l.type !== "creator" && l.type !== "person" && l.type !== "comic");
    const media    = filtered.filter(l => l.type === "video" || l.type === "image");
    const creators = filtered.filter(l => l.type === "creator" || l.type === "person");

    const block = document.createElement("div");
    block.className = "db-cat-block";

    const header = document.createElement("div");
    header.className = "db-cat-header";
    header.innerHTML = `
        <span class="db-cat-name">${escHtml(cat.name)}<span class="db-cat-count">${filtered.length}</span></span>
        <div class="db-cat-actions">
            <button class="ws-btn ws-btn-ghost db-cat-add-link" title="Add link">+ Link</button>
            <button class="ws-btn ws-btn-ghost db-cat-edit-btn" title="Rename">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="ws-btn ws-btn-ghost db-cat-del-btn" title="Delete project">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
        </div>`;
    header.querySelector(".db-cat-add-link").addEventListener("click", () => _openLinkModal(null, cat.id));
    header.querySelector(".db-cat-edit-btn").addEventListener("click", () => _openProjectModal(cat));
    header.querySelector(".db-cat-del-btn").addEventListener("click", () => _confirmDeleteProject(cat));
    block.appendChild(header);

    if (sites.length) {
        block.appendChild(_makeSubGroup("Sites", _sitesGrid(sites)));
    }
    if (media.length) {
        block.appendChild(_makeSubGroup("Media", _mediaGrid(media)));
    }
    if (creators.length) {
        block.appendChild(_makeSubGroup("Creators", _creatorsGrid(creators)));
    }
    if (!sites.length && !media.length && !creators.length) {
        const empty = document.createElement("p");
        empty.className = "db-cat-empty";
        empty.textContent = _search ? "No matches in this project." : "No links yet — click + Link to add one.";
        block.appendChild(empty);
    }

    return block;
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
    wrap.querySelector(".db-card-action-btn").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); _openLinkModal(link, link.categoryId); });
    wrap.querySelector(".db-card-del-btn").addEventListener("click",   (e) => { e.preventDefault(); e.stopPropagation(); _confirmDeleteLink(link); });
    return wrap;
}

function _makeSubGroup(label, gridEl) {
    const sg = document.createElement("div");
    sg.className = "db-sub-group";
    sg.innerHTML = `<div class="db-sub-header"><span class="db-sub-label">${label}</span><div class="db-sub-line"></div></div>`;
    sg.appendChild(gridEl);
    return sg;
}

/* ── Site cards ──────────────────────────────────────────────────────────── */

function _sitesGrid(links) {
    const grid = document.createElement("div");
    grid.className = "db-sites-grid";
    links.forEach(link => grid.appendChild(_buildSiteCard(link)));
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

/* ── Media cards (video / image) ─────────────────────────────────────────── */

function _mediaGrid(links) {
    const grid = document.createElement("div");
    grid.className = "db-media-grid";
    links.forEach(link => {
        if (link.type === "video") grid.appendChild(_buildVideoCard(link));
        else                       grid.appendChild(_buildImageCard(link));
    });
    return grid;
}

function _buildVideoCard(link) {
    const card = document.createElement("div");
    card.className = "db-video-card";

    const embed = link.url ? _getVideoEmbed(link.url) : null;
    let mediaHtml;

    if (embed && embed.type !== "direct" && embed.type !== "tweet") {
        mediaHtml = `<iframe class="db-video-iframe" src="${escHtml(embed.src)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe>`;
    } else if (link.thumbUrl) {
        mediaHtml = `<a href="${escHtml(link.url || "#")}" target="_blank" rel="noopener noreferrer" class="db-video-thumb-wrap">
            <img src="${escHtml(link.thumbUrl)}" alt="${escHtml(link.name || "")}">
            <div class="db-video-play-overlay"><svg width="30" height="30" viewBox="0 0 30 30" fill="none"><circle cx="15" cy="15" r="14" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/><path d="M12 9.5l9 5.5-9 5.5V9.5z" fill="white"/></svg></div>
        </a>`;
    } else if (link.url) {
        const domain = (() => { try { return new URL(link.url).hostname.replace(/^www\./, ""); } catch { return link.url; } })();
        mediaHtml = `<a href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="db-video-link-only">
            <svg width="32" height="32" viewBox="0 0 30 30" fill="none"><circle cx="15" cy="15" r="14" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><path d="M12 9.5l9 5.5-9 5.5V9.5z" fill="rgba(255,255,255,0.8)"/></svg>
            <span>${escHtml(domain)}</span>
        </a>`;
    } else {
        mediaHtml = `<div class="db-video-empty">No source</div>`;
    }

    const badgeType = embed
        ? (embed.type === "youtube" ? "YT" : embed.type === "vimeo" ? "VIMEO" : "VIDEO")
        : (link.thumbUrl ? "IMG" : "LINK");

    card.innerHTML = `
        <div class="db-video-wrap">${mediaHtml}</div>
        <div class="db-video-body">
            <span class="db-video-badge">${badgeType}</span>
            <span class="db-video-name">${escHtml(link.name || "")}</span>
        </div>`;
    card.appendChild(_cardActions(link));
    return card;
}

function _buildImageCard(link) {
    const card = document.createElement("div");
    card.className = "db-image-card";

    const src = link.url || link.imageUrl || "";
    card.innerHTML = `
        <a class="db-image-link" href="${escHtml(src || "#")}" target="_blank" rel="noopener noreferrer">
            <div class="db-image-thumb">
                ${src ? `<img src="${escHtml(src)}" alt="${escHtml(link.name || "")}">` : `<div class="db-image-no-src">No image</div>`}
            </div>
        </a>
        <div class="db-image-name">${escHtml(link.name || "")}</div>`;
    card.appendChild(_cardActions(link));
    return card;
}

/* ── Creator cards ───────────────────────────────────────────────────────── */

function _creatorsGrid(links) {
    const grid = document.createElement("div");
    grid.className = "db-creators-grid";
    links.forEach(link => grid.appendChild(_buildCreatorCard(link)));
    return grid;
}

function _buildCreatorCard(link) {
    const card = document.createElement("div");
    card.className = "db-creator-card";

    const avatarSrc  = link.avatarUrl || "";
    const initials   = (link.name || "?")[0].toUpperCase();
    const badgeColor = link.badgeColor || "#888";

    card.innerHTML = `
        <a class="db-creator-link" href="${escHtml(link.url || "#")}" target="_blank" rel="noopener noreferrer">
            <div class="db-creator-avatar" style="border-color:${escHtml(badgeColor)}">
                ${avatarSrc
                    ? `<img src="${escHtml(avatarSrc)}" alt="${escHtml(link.name || "")}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                    : ""}
                <span class="db-creator-initials" style="${avatarSrc ? "display:none" : ""}">${escHtml(initials)}</span>
            </div>
            <div class="db-creator-info">
                <div class="db-creator-name">${escHtml(link.name || "")}</div>
                ${link.desc ? `<div class="db-creator-desc">${escHtml(link.desc)}</div>` : ""}
            </div>
        </a>`;
    card.appendChild(_cardActions(link));
    return card;
}

/* ── Project CRUD ─────────────────────────────────────────────────────────── */

function _openProjectModal(cat) {
    _editCatId = cat ? cat.id : null;
    document.getElementById("modal-media-project-title").textContent = cat ? "Rename Project" : "New Project";
    document.getElementById("mp-field-name").value = cat ? (cat.name || "") : "";
    document.getElementById("modal-media-project").classList.remove("hidden");
    setTimeout(() => document.getElementById("mp-field-name").focus(), 60);
}

async function _onProjectSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("mp-field-name").value.trim();
    if (!name) return;
    try {
        if (_editCatId) {
            await updateDoc(doc(db, "users", _uid, "categories", _editCatId), { name });
        } else {
            await addDoc(collection(db, "users", _uid, "categories"), { name, createdAt: serverTimestamp() });
        }
        document.getElementById("modal-media-project").classList.add("hidden");
        toast(_editCatId ? "Project renamed" : "Project created", "success");
    } catch (err) {
        console.error(err);
        toast("Error saving project", "error");
    }
}

async function _confirmDeleteProject(cat) {
    const count = _links.filter(l => l.categoryId === cat.id).length;
    const msg = count > 0
        ? `Delete "${cat.name}" and its ${count} link${count !== 1 ? "s" : ""}? This cannot be undone.`
        : `Delete project "${cat.name}"? This cannot be undone.`;
    const ok = await confirm(msg);
    if (!ok) return;
    try {
        for (const link of _links.filter(l => l.categoryId === cat.id)) {
            await deleteDoc(doc(db, "users", _uid, "links", link.id));
        }
        await deleteDoc(doc(db, "users", _uid, "categories", cat.id));
        toast("Project deleted", "success");
    } catch (err) {
        console.error(err);
        toast("Error deleting project", "error");
    }
}

/* ── Link CRUD ─────────────────────────────────────────────────────────────── */

function _openLinkModal(link, catId) {
    _editLinkId    = link ? link.id : null;
    _editLinkCatId = catId;
    document.getElementById("modal-media-link-title").textContent = link ? "Edit Link" : "Add Link";
    document.getElementById("ml-field-type").value  = link?.type || "site";
    document.getElementById("ml-field-name").value  = link?.name || "";
    document.getElementById("ml-field-url").value   = link?.url  || "";
    document.getElementById("ml-field-img").value   = link?.imageUrl || link?.thumbUrl || link?.avatarUrl || "";
    document.getElementById("ml-field-desc").value  = link?.desc || "";
    document.getElementById("ml-field-color").value = link?.badgeColor || "#888888";
    const projSel = document.getElementById("ml-field-project");
    projSel.innerHTML = _cats.map(c =>
        `<option value="${escHtml(c.id)}" ${c.id === catId ? "selected" : ""}>${escHtml(c.name)}</option>`
    ).join("");
    _updateLinkFields();
    document.getElementById("modal-media-link").classList.remove("hidden");
    setTimeout(() => document.getElementById("ml-field-name").focus(), 60);
}

function _updateLinkFields() {
    const type       = document.getElementById("ml-field-type").value;
    const imgGroup   = document.getElementById("ml-img-group");
    const descGroup  = document.getElementById("ml-desc-group");
    const colorGroup = document.getElementById("ml-color-group");
    const imgLabel   = document.getElementById("ml-img-label");
    imgGroup.style.display   = ["site", "video", "image", "creator", "person"].includes(type) ? "" : "none";
    descGroup.style.display  = ["creator", "person"].includes(type) ? "" : "none";
    colorGroup.style.display = ["creator", "person"].includes(type) ? "" : "none";
    if      (type === "site")                            imgLabel.textContent = "Custom thumbnail URL";
    else if (type === "video")                           imgLabel.textContent = "Thumbnail URL";
    else if (type === "image")                           imgLabel.textContent = "Image URL";
    else if (type === "creator" || type === "person")    imgLabel.textContent = "Avatar URL";
}

async function _onLinkSubmit(e) {
    e.preventDefault();
    const type  = document.getElementById("ml-field-type").value;
    const name  = document.getElementById("ml-field-name").value.trim();
    const url   = document.getElementById("ml-field-url").value.trim();
    const img   = document.getElementById("ml-field-img").value.trim();
    const desc  = document.getElementById("ml-field-desc").value.trim();
    const color = document.getElementById("ml-field-color").value;
    const catId = document.getElementById("ml-field-project").value;
    if (!name && !url) return;
    const data = { type, name, url, categoryId: catId };
    if      (type === "site")                          { if (img) data.imageUrl  = img; }
    else if (type === "video")                         { if (img) data.thumbUrl  = img; }
    else if (type === "image")                         { if (img) data.imageUrl  = img; }
    else if (type === "creator" || type === "person")  {
        if (img)  data.avatarUrl  = img;
        if (desc) data.desc       = desc;
        data.badgeColor = color;
    }
    try {
        if (_editLinkId) {
            await updateDoc(doc(db, "users", _uid, "links", _editLinkId), data);
        } else {
            data.createdAt = serverTimestamp();
            await addDoc(collection(db, "users", _uid, "links"), data);
        }
        document.getElementById("modal-media-link").classList.add("hidden");
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

function _getScreenshot(url) {
    if (!url) return "";
    return `https://image.thum.io/get/width/600/crop/338/noanimate/${encodeURIComponent(url)}`;
}

function _prettyUrl(url) {
    try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, ""); }
    catch { return url || ""; }
}

function _getVideoEmbed(url) {
    try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, "");
        if (h === "youtube.com" || h === "youtu.be") {
            let id = h === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") || u.pathname.split("/").pop();
            if (id) return { type: "youtube", src: `https://www.youtube.com/embed/${encodeURIComponent(id)}` };
        }
        if (h === "vimeo.com") {
            const id = u.pathname.split("/").pop();
            if (id) return { type: "vimeo", src: `https://player.vimeo.com/video/${encodeURIComponent(id)}` };
        }
    } catch { /* noop */ }
    return null;
}
