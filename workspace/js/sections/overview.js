/**
 * sections/overview.js — Overview section: description, meta, stats, quick notes.
 */

import {
    onSnapshot, updateDoc, query, getCountFromServer, collection, where, getDoc, doc
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                     from "../app.js";
import { currentProjectId,
         currentProject }               from "../projects.js";
import { refs }                         from "../db.js";
import { toast, escHtml, fmtDate }      from "../ui.js";
import { marked }                        from "https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js";
import katex                             from "https://esm.sh/katex@0.16.11";

/* ── Configure marked: GFM (task lists, tables, strikethrough) + math ── */
marked.use({
    gfm: true,
    extensions: [
        /* Block math: $$...$$  (must come first so it wins over inline $) */
        {
            name: 'blockMath',
            level: 'block',
            start(src) { return src.indexOf('$$'); },
            tokenizer(src) {
                const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
                if (m) return { type: 'blockMath', raw: m[0], math: m[1].trim() };
            },
            renderer(token) {
                try {
                    return `<div class="math-block">${katex.renderToString(token.math, { displayMode: true, throwOnError: false })}</div>\n`;
                } catch {
                    return `<pre class="math-block">${token.math}</pre>\n`;
                }
            },
        },
        /* Inline math: $...$ (not $$) */
        {
            name: 'inlineMath',
            level: 'inline',
            start(src) { return src.indexOf('$'); },
            tokenizer(src) {
                const m = /^\$(?!\$)((?:[^$\n]|\\.)+?)\$/.exec(src);
                if (m) return { type: 'inlineMath', raw: m[0], math: m[1] };
            },
            renderer(token) {
                try {
                    return `<span class="math-inline">${katex.renderToString(token.math, { displayMode: false, throwOnError: false })}</span>`;
                } catch {
                    return `<code class="math-inline">${token.math}</code>`;
                }
            },
        },
    ],
});

/* ── Emoji map (GitHub-flavored shortcodes → Unicode) ── */
const _EMOJI = {
    rocket:'🚀', fire:'🔥', star:'⭐', heart:'❤️', thumbsup:'👍', thumbsdown:'👎',
    eyes:'👀', wave:'👋', pray:'🙏', clap:'👏', muscle:'💪', point_right:'👉',
    white_check_mark:'✅', x:'❌', warning:'⚠️', question:'❓', exclamation:'❗',
    information_source:'ℹ️', ballot_box_with_check:'☑️', no_entry:'⛔',
    computer:'💻', keyboard:'⌨️', wrench:'🔧', gear:'⚙️', bug:'🐛', zap:'⚡',
    link:'🔗', lock:'🔒', key:'🔑', shield:'🛡️', package:'📦', memo:'📝',
    books:'📚', file_folder:'📁', clipboard:'📋', chart_bar:'📊', mag:'🔍',
    sparkles:'✨', tada:'🎉', rainbow:'🌈', snowflake:'❄️', sun_with_face:'🌞',
    moon:'🌙', earth_americas:'🌎', construction:'🚧', checkered_flag:'🏁',
    trophy:'🏆', dart:'🎯', robot:'🤖', alien:'👽', ghost:'👻', skull:'💀',
    smile:'😊', laughing:'😄', thinking:'🤔', sob:'😭', angry:'😠',
    arrow_right:'→', arrow_left:'←', arrow_up:'↑', arrow_down:'↓',
    'plus_one':'👍', '-1':'👎', octocat:'🐙', 100:'💯',
};

/**
 * Preprocess raw markdown before marked.parse():
 *   • Extracts abbreviation definitions and wraps matches in <abbr>
 *   • Converts definition lists (Term\n: Def) to <dl> HTML
 *   • Converts footnote definitions + references to HTML
 */
function _mdPreprocess(src) {
    /* 1. Abbreviations: *[ABBR]: Definition  — strip definitions, apply later */
    const abbrs = {};
    src = src.replace(/^\*\[([^\]]+)\]:\s*(.+)$/gm, (_, a, d) => {
        abbrs[a] = d.trim();
        return '';
    });

    /* 2. Footnotes — collect [^label]: text, replace [^label] refs */
    const fnDefs = {};
    let fnIdx = 0;
    src = src.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, lbl, txt) => {
        fnDefs[lbl] = txt.trim();
        return '';
    });
    src = src.replace(/\[\^([^\]]+)\]/g, (_, lbl) => {
        fnIdx++;
        const n = fnIdx;
        return `<sup class="footnote-ref"><a href="#fn-${lbl}" id="fnref-${lbl}">[${n}]</a></sup>`;
    });

    /* 3. Definition lists: Term\n: Def (one or more) */
    src = src.replace(
        /^(?!#{1,6} |[-*+] |\d+\. |> |```|    |\t|<)([^\n]+)\n((?:: [^\n]+\n?)+)/gm,
        (_, term, defs) => {
            const dds = [...defs.matchAll(/^: ([^\n]+)/gm)]
                .map(m => `<dd>${m[1]}</dd>`)
                .join('');
            return `\n<dl><dt>${term.trim()}</dt>${dds}</dl>\n\n`;
        }
    );

    /* 4. Apply abbreviations — wrap matching whole words in <abbr> */
    for (const [abbr, def] of Object.entries(abbrs)) {
        const esc = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        src = src.replace(
            new RegExp(`(?<![\\w<])${esc}(?![\\w>])`, 'g'),
            `<abbr title="${def}">${abbr}</abbr>`
        );
    }

    /* 5. Append footnotes section */
    if (Object.keys(fnDefs).length) {
        const items = Object.entries(fnDefs)
            .map(([lbl, txt]) =>
                `<li id="fn-${lbl}">${txt}&nbsp;<a href="#fnref-${lbl}" class="footnote-back">↩</a></li>`)
            .join('');
        src += `\n\n<section class="footnotes"><ol>${items}</ol></section>`;
    }

    return src;
}

/** Replace :emoji_name: codes in rendered HTML */
function _emojiReplace(html) {
    return html.replace(/:([a-z0-9_+\-]+):/g, (m, n) => _EMOJI[n] ?? m);
}

let _unsub      = null;
let _readmeSha  = null;   // current blob SHA from GitHub (needed for PUT)
let _readmeFrom = null;   // "github" | null
let _readmeMode = "preview"; // "edit" | "preview"

export function init() {
    window.addEventListener("projectSelected", onProjectSelected);
    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "overview") _loadOverview();
    });

    document.getElementById("btn-save-notes")
        .addEventListener("click", saveNotes);

    document.getElementById("readme-tab-edit")
        .addEventListener("click", () => _setReadmeMode("edit"));
    document.getElementById("readme-tab-preview")
        .addEventListener("click", () => _setReadmeMode("preview"));

    // Ctrl+S in the textarea saves without leaving
    document.getElementById("overview-notes")
        .addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                saveNotes();
            }
        });

    _loadOverview();
}

function onProjectSelected() {
    _loadOverview();
}

function _loadOverview() {
    if (!currentProject) return;
    const p = currentProject;

    // Reset README state for new project
    _readmeSha  = null;
    _readmeFrom = null;
    _readmeMode = "preview";
    _setReadmeStatus("");

    document.getElementById("overview-description").textContent =
        p.description || "No description.";

    document.getElementById("meta-type").textContent    = p.type    || "—";
    document.getElementById("meta-status").textContent  = p.status  || "—";
    document.getElementById("meta-created").textContent = fmtDate(p.createdAt);
    document.getElementById("meta-updated").textContent = fmtDate(p.updatedAt);

    const githubRow = document.getElementById("meta-github-row");
    const githubLink = document.getElementById("meta-github");
    if (p.githubRepo) {
        githubLink.href        = p.githubRepo;
        githubLink.textContent = p.githubRepo.replace(/^https?:\/\/(www\.)?github\.com\//, "");
        githubRow.style.display = "";
    } else {
        githubRow.style.display = "none";
    }

    document.getElementById("overview-notes").value = p.notes || "";
    _renderPreview(p.notes || "");
    _applyReadmeMode(_readmeMode);

    _loadGithubInfo(p.githubRepo || "");
    if (p.githubRepo) _loadReadme(p.githubRepo);
    _loadStats();
}

/* ── Language colour map (top ~30 languages) ── */
const LANG_COLORS = {
    JavaScript:"#f1e05a", TypeScript:"#3178c6", Python:"#3572A5", Java:"#b07219",
    "C#":"#178600", "C++":"#f34b7d", C:"#555555", Go:"#00ADD8", Rust:"#dea584",
    Ruby:"#701516", PHP:"#4F5D95", Swift:"#F05138", Kotlin:"#A97BFF", Dart:"#00B4AB",
    HTML:"#e34c26", CSS:"#563d7c", Shell:"#89e051", Lua:"#000080", Scala:"#c22d40",
    Haskell:"#5e5086", R:"#198CE7", Julia:"#a270ba", Elixir:"#6e4a7e",
    Clojure:"#db5855", "F#":"#b845fc", Vue:"#41b883", GLSL:"#5686a5",
    GDScript:"#355570", Makefile:"#427819",
};

function _ghParseRepo(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== "github.com") return null;
        const parts = u.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
        if (parts.length < 2) return null;
        return { owner: parts[0], repo: parts[1] };
    } catch { return null; }
}

function _ghRelativeTime(dateStr) {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
    return `${Math.floor(diff / (86400 * 365))}y ago`;
}

async function _loadGithubInfo(repoUrl) {
    const section = document.getElementById("github-info-section");
    const statsEl = document.getElementById("github-repo-stats");
    const commitsSection = document.getElementById("github-commits-section");
    const commitsEl = document.getElementById("github-commits");
    const stateEl = document.getElementById("github-load-state");

    if (!repoUrl) {
        section.style.display = "none";
        return;
    }

    const parsed = _ghParseRepo(repoUrl);
    if (!parsed) {
        section.style.display = "none";
        return;
    }

    section.style.display = "";
    stateEl.textContent = "Loading…";
    statsEl.innerHTML = "";
    commitsSection.style.display = "none";

    const { owner, repo } = parsed;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    try {
        const [repoRes, commitsRes] = await Promise.all([
            fetch(base, { headers: { Accept: "application/vnd.github+json" } }),
            fetch(`${base}/commits?per_page=7`, { headers: { Accept: "application/vnd.github+json" } }),
        ]);

        if (!repoRes.ok) {
            stateEl.textContent = repoRes.status === 404 ? "Repo not found" : `Error ${repoRes.status}`;
            return;
        }

        const repoData = await repoRes.json();
        stateEl.textContent = "";

        // ── Stats row ──
        const lang = repoData.language || null;
        const langDot = lang
            ? `<span class="github-lang-dot" style="background:${LANG_COLORS[lang] || "#8a8a8a"}"></span>${escHtml(lang)}`
            : "";

        statsEl.innerHTML = `
            ${lang ? `<div class="github-stat">${langDot}</div>` : ""}
            <div class="github-stat">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                <span class="github-stat-val">${repoData.stargazers_count.toLocaleString()}</span> stars
            </div>
            <div class="github-stat">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 5C7 3.89543 7.89543 3 9 3C10.1046 3 11 3.89543 11 5C11 6.10457 10.1046 7 9 7C7.89543 7 7 6.10457 7 5Z"/><path d="M17 5C17 3.89543 17.8954 3 19 3C20.1046 3 21 3.89543 21 5C21 6.10457 20.1046 7 19 7C17.8954 7 17 6.10457 17 5Z"/><path d="M9 19C9 17.8954 9.89543 17 11 17C12.1046 17 13 17.8954 13 19C13 20.1046 12.1046 21 11 21C9.89543 21 9 20.1046 9 19Z"/><path d="M9 7V13C9 15.2091 10.7909 17 13 17H11C11 17 19 17 19 7"/></svg>
                <span class="github-stat-val">${repoData.forks_count.toLocaleString()}</span> forks
            </div>
            <div class="github-stat">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <span class="github-stat-val">${repoData.open_issues_count.toLocaleString()}</span> issues
            </div>
            <div class="github-stat">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Pushed <span class="github-stat-val">&nbsp;${_ghRelativeTime(repoData.pushed_at)}</span>
            </div>`;

        // ── Commits ──
        if (commitsRes.ok) {
            const commits = await commitsRes.json();
            if (Array.isArray(commits) && commits.length > 0) {
                commitsEl.innerHTML = commits.map(c => {
                    const msg   = c.commit.message.split("\n")[0];
                    const author = c.commit.author.name;
                    const when  = _ghRelativeTime(c.commit.author.date);
                    const sha   = c.sha.slice(0, 7);
                    const url   = c.html_url;
                    const avatar = c.author?.avatar_url
                        ? `<img class="github-commit-avatar" src="${escHtml(c.author.avatar_url)}&s=44" alt="" loading="lazy">`
                        : `<span class="github-commit-avatar" style="display:inline-block"></span>`;
                    return `<div class="github-commit">
                        ${avatar}
                        <div class="github-commit-body">
                            <div class="github-commit-msg" title="${escHtml(msg)}">${escHtml(msg)}</div>
                            <div class="github-commit-meta">${escHtml(author)} · ${when}</div>
                        </div>
                        <a class="github-commit-sha" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${sha}</a>
                    </div>`;
                }).join("");
                commitsSection.style.display = "";
            }
        }
    } catch (err) {
        stateEl.textContent = "Failed to load";
        console.error("GitHub API error:", err);
    }
}

async function _loadStats() {
    if (!currentProjectId) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    try {
        const _catId = currentProject.sourceCategoryId || currentProject.id;
        const [tasksSnap, mediaSnap] = await Promise.all([
            getCountFromServer(refs.kanbanTasks(db, uid, currentProjectId)),
            getCountFromServer(query(collection(db, `users/${auth.currentUser?.uid}/links`), where("categoryId", "==", _catId))),
        ]);
        document.getElementById("stat-tasks").textContent = tasksSnap.data().count;
        document.getElementById("stat-media").textContent = mediaSnap.data().count;
    } catch { /* getCountFromServer not supported on older SDK — silently skip */ }
}

async function saveNotes() {
    if (!currentProjectId) return;
    const uid     = auth.currentUser?.uid;
    const content = document.getElementById("overview-notes").value;
    const p       = currentProject;

    // Always save to Firestore
    try {
        await updateDoc(refs.project(db, uid, currentProjectId), { notes: content });
    } catch (err) {
        console.error(err);
        toast("Error saving notes", "error");
        return;
    }

    // If project has a GitHub repo, also push to GitHub
    if (p?.githubRepo) {
        const parsed = _ghParseRepo(p.githubRepo);
        if (parsed) {
            const pat = await _getGhPat(uid);
            if (pat) {
                _setReadmeStatus("Pushing to GitHub…");
                try {
                    await _pushReadme(parsed.owner, parsed.repo, content, pat);
                    _setReadmeStatus("Saved & pushed to GitHub", true);
                    setTimeout(() => _setReadmeStatus(""), 3000);
                } catch (err) {
                    console.error("README push failed:", err);
                    _setReadmeStatus("Saved locally (GitHub push failed)", false, true);
                    setTimeout(() => _setReadmeStatus(""), 4000);
                }
                return;
            }
        }
    }

    // Local-only save hint
    const hint = document.getElementById("notes-saved-hint");
    hint.textContent = "Saved";
    hint.classList.add("visible");
    setTimeout(() => hint.classList.remove("visible"), 2000);
}

/** Load README.md from GitHub and populate the textarea. */
async function _loadReadme(repoUrl) {
    const parsed = _ghParseRepo(repoUrl);
    if (!parsed) return;
    const { owner, repo } = parsed;
    const uid = auth.currentUser?.uid;
    const pat = await _getGhPat(uid);

    _setReadmeStatus("Loading README.md from GitHub…");
    try {
        const headers = { Accept: "application/vnd.github+json" };
        if (pat) headers["Authorization"] = `Bearer ${pat}`;

        const resp = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/README.md`,
            { headers }
        );

        if (resp.status === 404) {
            // No README yet — keep any locally saved notes
            _readmeSha  = null;
            _readmeFrom = "github";
            _setReadmeStatus("No README.md in repo — content will be created on save");
            setTimeout(() => _setReadmeStatus(""), 3000);
            return;
        }
        if (!resp.ok) throw new Error(`GitHub ${resp.status}`);

        const data    = await resp.json();
        _readmeSha    = data.sha;
        _readmeFrom   = "github";

        // Decode base64 content (GitHub returns it with line-breaks)
        const decoded = decodeURIComponent(
            escape(atob(data.content.replace(/\n/g, "")))
        );
        document.getElementById("overview-notes").value = decoded;
        _renderPreview(decoded);
        _applyReadmeMode("preview");
        _setReadmeStatus("Loaded from GitHub", true);
        setTimeout(() => _setReadmeStatus(""), 3000);
    } catch (err) {
        console.error("README load failed:", err);
        _setReadmeStatus("Could not load README.md from GitHub", false, true);
        setTimeout(() => _setReadmeStatus(""), 3000);
    }
}

/** Push textarea content to GitHub as README.md. */
async function _pushReadme(owner, repo, content, pat) {
    // base64-encode with full Unicode support
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const body = {
        message: 'Update README.md from joni.no',
        content: encoded,
    };
    if (_readmeSha) body.sha = _readmeSha;

    const resp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/README.md`,
        {
            method:  "PUT",
            headers: { "Authorization": `Bearer ${pat}`, "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        }
    );
    if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.message || `GitHub ${resp.status}`);
    }
    const result = await resp.json();
    _readmeSha = result.content?.sha || _readmeSha;
}

/** Load PAT from Firestore settings. */
async function _getGhPat(uid) {
    if (!uid) return null;
    try {
        const snap = await getDoc(doc(db, "users", uid, "settings", "github"));
        return snap.exists() ? (snap.data().pat || null) : null;
    } catch { return null; }
}

/** Set edit/preview mode and re-render if switching to preview. */
function _setReadmeMode(mode) {
    if (mode === "preview") {
        _renderPreview(document.getElementById("overview-notes").value);
    }
    _applyReadmeMode(mode);
}

function _applyReadmeMode(mode) {
    _readmeMode = mode;
    const textarea = document.getElementById("overview-notes");
    const preview  = document.getElementById("readme-preview");
    const tabEdit  = document.getElementById("readme-tab-edit");
    const tabPrev  = document.getElementById("readme-tab-preview");
    if (!textarea || !preview) return;
    if (mode === "edit") {
        textarea.style.display = "";
        preview.style.display  = "none";
        tabEdit.classList.add("active");
        tabPrev.classList.remove("active");
    } else {
        textarea.style.display = "none";
        preview.style.display  = "";
        tabEdit.classList.remove("active");
        tabPrev.classList.add("active");
    }
}

function _renderPreview(md) {
    const preview = document.getElementById("readme-preview");
    if (!preview) return;
    const src  = _mdPreprocess(md || '*No content yet.*');
    let   html = marked.parse(src);
    html = _emojiReplace(html);
    preview.innerHTML = html;
}

/** Update the small status line under the textarea. */
function _setReadmeStatus(msg, ok = false, warn = false) {
    const el = document.getElementById("readme-status");
    if (!el) return;
    el.textContent = msg;
    el.className   = "readme-status" + (ok ? " readme-status--ok" : warn ? " readme-status--warn" : "");
}
