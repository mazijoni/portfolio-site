/**
 * sections/files.js — GitHub-style file tree with per-item commit info.
 */

import { auth, db }         from "../app.js";
import { currentProject }   from "../projects.js";
import { getDoc, doc }      from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { escHtml }          from "../ui.js";

const enc = encodeURIComponent;

let _treeRepoUrl   = null;
let _owner         = null;
let _repo          = null;
let _hdrs          = {};
const _commitCache = new Map();   // path → { message, date, sha, commitUrl }

export function init() {
    window.addEventListener("projectSelected",  _onProjectSelected);
    window.addEventListener("sectionActivated", e => {
        if (e.detail.section === "files") _loadFiles();
    });

    document.getElementById("btn-files-refresh")
        .addEventListener("click", () => { _treeRepoUrl = null; _loadFiles(); });

    document.getElementById("files-search")
        .addEventListener("input", _onSearch);

    // `toggle` on <details> doesn't bubble — use capture phase
    document.getElementById("repo-filetree")
        .addEventListener("toggle", _onFolderToggle, true);

    // Click file row (outside a link) → open on GitHub
    document.getElementById("repo-filetree")
        .addEventListener("click", e => {
            if (e.target.closest("a")) return;
            const row = e.target.closest(".ft-file");
            if (row?.dataset.href) window.open(row.dataset.href, "_blank", "noopener,noreferrer");
        });

    _loadFiles();
}

function _onProjectSelected() {
    _treeRepoUrl = null;
    _commitCache.clear();
    _owner = _repo = null;
    _hdrs  = {};
    const h = document.getElementById("files-header");
    const t = document.getElementById("repo-filetree");
    if (h) h.innerHTML = "";
    if (t) t.innerHTML = "";
    _loadFiles();
}

async function _loadFiles() {
    const p        = currentProject;
    const noRepo   = document.getElementById("files-no-repo");
    const treeWrap = document.getElementById("files-tree-wrap");
    const treeEl   = document.getElementById("repo-filetree");
    const headerEl = document.getElementById("files-header");
    const searchEl = document.getElementById("files-search");

    if (!p) return;

    if (!p.githubRepo) {
        noRepo.style.display   = "";
        treeWrap.style.display = "none";
        return;
    }
    noRepo.style.display   = "none";
    treeWrap.style.display = "";

    if (_treeRepoUrl === p.githubRepo) return;

    const parsed = _parseRepo(p.githubRepo);
    if (!parsed) {
        treeEl.innerHTML = '<div class="ft-empty">Invalid repository URL.</div>';
        return;
    }

    _owner = parsed.owner;
    _repo  = parsed.repo;
    treeEl.innerHTML = '<div class="ft-loading">Loading\u2026</div>';
    if (headerEl) headerEl.innerHTML = "";
    if (searchEl) searchEl.value    = "";
    _commitCache.clear();

    const uid = auth.currentUser?.uid;
    const pat = await _getGhPat(uid);
    _hdrs = { Accept: "application/vnd.github+json" };
    if (pat) _hdrs["Authorization"] = `Bearer ${pat}`;

    try {
        const [treeResp, commitsResp] = await Promise.all([
            fetch(`https://api.github.com/repos/${enc(_owner)}/${enc(_repo)}/git/trees/HEAD?recursive=1`, { headers: _hdrs }),
            fetch(`https://api.github.com/repos/${enc(_owner)}/${enc(_repo)}/commits?per_page=1`,          { headers: _hdrs }),
        ]);

        if (!treeResp.ok) throw new Error(`GitHub ${treeResp.status}`);

        const treeData = await treeResp.json();
        const root     = _buildTree(treeData.tree || []);

        // Render commit header
        if (commitsResp.ok && headerEl) {
            const link  = commitsResp.headers.get("Link") || "";
            const m     = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
            const count = m ? parseInt(m[1]) : null;
            const [c]   = await commitsResp.json();
            if (c) headerEl.innerHTML = _renderHeader(c, count);
        }

        // Render tree
        treeEl.innerHTML = _renderNode(root, 0)
            + (treeData.truncated ? '<div class="ft-truncated">Large repo \u2014 tree may be partial</div>' : "");

        _treeRepoUrl = p.githubRepo;

        // Eagerly fetch commit info for root-level rows
        const rootPaths = [...treeEl.querySelectorAll('.ft-row[data-depth="0"]')]
            .map(r => r.dataset.path).filter(Boolean);
        _fetchCommitInfo(rootPaths);

    } catch (err) {
        console.error("Files:", err);
        treeEl.innerHTML = '<div class="ft-empty">Failed to load file tree.</div>';
    }
}

function _onFolderToggle(e) {
    if (!e.target.classList.contains("ft-dir") || !e.target.open) return;
    const depth = parseInt(e.target.dataset.depth ?? "0");
    const paths = [...e.target.querySelectorAll(`.ft-row[data-depth="${depth + 1}"]`)]
        .map(r => r.dataset.path).filter(Boolean);
    if (paths.length) _fetchCommitInfo(paths);
}

async function _fetchCommitInfo(paths) {
    if (!_owner || !_repo || !paths.length) return;
    const needed = paths.filter(p => !_commitCache.has(p));

    await Promise.all(needed.map(async path => {
        try {
            const resp = await fetch(
                `https://api.github.com/repos/${enc(_owner)}/${enc(_repo)}/commits?path=${encodeURIComponent(path)}&per_page=1`,
                { headers: _hdrs }
            );
            if (!resp.ok) return;
            const [c] = await resp.json();
            if (!c) return;
            _commitCache.set(path, {
                message:   c.commit.message.split("\n")[0],
                date:      c.commit.author.date,
                sha:       c.sha.slice(0, 7),
                commitUrl: c.html_url,
            });
        } catch { /* ignore */ }
    }));

    paths.forEach(path => {
        const info = _commitCache.get(path);
        if (info) _populateRow(path, info);
    });
}

function _populateRow(path, info) {
    document.querySelectorAll("#repo-filetree .ft-row[data-path]").forEach(row => {
        if (row.dataset.path !== path) return;
        const msgEl  = row.querySelector(".ft-cell-msg");
        const timeEl = row.querySelector(".ft-cell-time");
        if (msgEl)  msgEl.innerHTML  = `<a class="ft-commit-link" href="${escHtml(info.commitUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(info.message)}</a>`;
        if (timeEl) { timeEl.textContent = _relTime(info.date); timeEl.title = new Date(info.date).toLocaleString(); }
    });
}

function _onSearch(e) {
    const q    = e.target.value.trim().toLowerCase();
    const tree = document.getElementById("repo-filetree");
    if (!tree) return;

    if (!q) {
        tree.querySelectorAll(".ft-dir, .ft-file").forEach(el => el.style.display = "");
        tree.querySelectorAll(".ft-dir").forEach(d => { d.open = false; });
        return;
    }

    tree.querySelectorAll(".ft-file").forEach(f => {
        const name = (f.querySelector(".ft-name")?.textContent ?? "").toLowerCase();
        f.style.display = name.includes(q) ? "" : "none";
    });
    [...tree.querySelectorAll(".ft-dir")].reverse().forEach(d => {
        const has = !!d.querySelector('.ft-file:not([style*="display: none"])');
        d.style.display = has ? "" : "none";
        if (has) d.open = true;
    });
}

/* ── Renderers ── */

function _renderHeader(c, count) {
    const msg    = escHtml(c.commit.message.split("\n")[0]);
    const author = escHtml(c.commit.author.name);
    const sha    = c.sha.slice(0, 7);
    const time   = _relTime(c.commit.author.date);
    const cUrl   = escHtml(c.html_url);
    const avatar = c.author?.avatar_url
        ? `<img class="ft-hdr-avatar" src="${escHtml(c.author.avatar_url)}&s=32" alt="" loading="lazy">`
        : `<span class="ft-hdr-avatar ft-hdr-avatar--empty"></span>`;
    const commitsUrl = `https://github.com/${enc(_owner)}/${enc(_repo)}/commits`;
    const countHtml  = count
        ? `<a class="ft-hdr-count" href="${commitsUrl}" target="_blank" rel="noopener noreferrer">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>
             ${count} commits
           </a>`
        : "";
    return `
    <div class="ft-hdr-left">
      ${avatar}
      <span class="ft-hdr-author">${author}</span>
      <a class="ft-hdr-msg" href="${cUrl}" target="_blank" rel="noopener noreferrer">${msg}</a>
    </div>
    <div class="ft-hdr-right">
      <a class="ft-hdr-sha" href="${cUrl}" target="_blank" rel="noopener noreferrer">${sha}</a>
      <span class="ft-hdr-sep">&middot;</span>
      <span class="ft-hdr-time">${time}</span>
      ${countHtml}
    </div>`;
}

function _renderNode(node, depth) {
    const entries = Object.entries(node.children);
    if (!entries.length) return "";

    entries.sort(([an, av], [bn, bv]) => {
        const ad = av.type === "tree", bd = bv.type === "tree";
        if (ad !== bd) return ad ? -1 : 1;
        return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });

    const indent = depth * 16;
    return entries.map(([name, child]) => {
        const pa = escHtml(child.path);
        if (child.type === "tree") {
            const inner = _renderNode(child, depth + 1);
            return `<details class="ft-dir" data-depth="${depth}" data-path="${pa}"><summary class="ft-row" data-path="${pa}" data-depth="${depth}"><span class="ft-cell-name" style="padding-left:${indent + 6}px"><span class="ft-caret">&#9654;</span><svg class="ft-icon ft-icon-dir" width="14" height="12" viewBox="0 0 22 18" fill="currentColor" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h5.17a2 2 0 0 1 1.42.59L11 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3z"/></svg><span class="ft-name">${escHtml(name)}</span></span><span class="ft-cell-msg"></span><span class="ft-cell-time"></span></summary>
${inner}</details>`;
        }
        const url    = `https://github.com/${enc(_owner)}/${enc(_repo)}/blob/HEAD/${child.path}`;
        const extCls = _extClass(name);
        return `<div class="ft-row ft-file${extCls}" data-path="${pa}" data-depth="${depth}" data-href="${escHtml(url)}"><span class="ft-cell-name" style="padding-left:${indent + 24}px"><svg class="ft-icon" width="12" height="13" viewBox="0 0 20 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg><a class="ft-name" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(name)}</a></span><span class="ft-cell-msg"></span><span class="ft-cell-time"></span></div>`;
    }).join("\n");
}
/* ── Utilities ── */

function _parseRepo(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== "github.com") return null;
        const parts = u.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
        if (parts.length < 2) return null;
        return { owner: parts[0], repo: parts[1] };
    } catch { return null; }
}

async function _getGhPat(uid) {
    if (!uid) return null;
    try {
        const snap = await getDoc(doc(db, "users", uid, "settings", "github"));
        return snap.exists() ? (snap.data().pat || null) : null;
    } catch { return null; }
}

function _buildTree(items) {
    const root = { type: "tree", path: "", children: {} };
    for (const item of items) {
        const parts = item.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!node.children[part]) {
                node.children[part] = {
                    type:     i < parts.length - 1 ? "tree" : item.type,
                    path:     item.path,
                    children: {},
                };
            }
            if (i < parts.length - 1) node = node.children[part];
        }
    }
    return root;
}

const _EXT_MAP = {
    js:   ["js","mjs","cjs","jsx"],
    ts:   ["ts","tsx"],
    css:  ["css","scss","less","sass"],
    html: ["html","htm"],
    md:   ["md","mdx"],
    json: ["json","jsonc","json5"],
    py:   ["py","pyi"],
    rs:   ["rs"],
    go:   ["go"],
    img:  ["png","jpg","jpeg","gif","webp","ico","svg"],
};

function _extClass(name) {
    if (!name.includes(".")) return "";
    const ext = name.split(".").pop().toLowerCase();
    for (const [cls, exts] of Object.entries(_EXT_MAP)) {
        if (exts.includes(ext)) return ` ft-${cls}`;
    }
    return "";
}

function _relTime(dateStr) {
    const s = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (s < 60)          return "just now";
    if (s < 3600)        return `${Math.floor(s / 60)} minutes ago`;
    if (s < 86400)       return `${Math.floor(s / 3600)} hours ago`;
    if (s < 86400 * 30)  return `${Math.floor(s / 86400)} days ago`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))} months ago`;
    return `${Math.floor(s / (86400 * 365))} years ago`;
}

