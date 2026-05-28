/**
 * analytics.js — Portfolio site visit analytics viewer.
 * Reads from the `site_analytics` Firestore collection (admin-only read).
 * Tracking is written client-side from index.html.
 */

import {
    collection, getDocs, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

let _db;
let _loaded = false;

export function initAnalytics(db) {
    _db = db;

    const navBtn = document.querySelector('.hub-app-btn[data-app="analytics"]');
    if (!navBtn) return;

    navBtn.addEventListener('click', () => {
        if (!_loaded) _fetchAndRender();
    });

    const refreshBtn = document.getElementById('analytics-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            _loaded = false;
            _fetchAndRender();
        });
    }
}

async function _fetchAndRender() {
    _loaded = true;
    const body = document.getElementById('analytics-body');
    if (!body) return;

    body.innerHTML = '<p class="ws-placeholder">Loading analytics&#8230;</p>';

    try {
        const snap = await getDocs(
            query(collection(_db, 'site_analytics'), orderBy('ts', 'desc'), limit(2000))
        );
        _render(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        const msg = err.code === 'permission-denied'
            ? 'Access denied — admin only.'
            : _esc(err.message);
        body.innerHTML = `<p class="ws-placeholder" style="color:var(--danger)">${msg}</p>`;
    }
}

function _render(visits) {
    const body = document.getElementById('analytics-body');
    if (!body) return;

    const now    = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs  = todayStart.getTime();
    const week7Ms  = now - 7  * 86_400_000;
    const month30Ms= now - 30 * 86_400_000;

    let todayCnt = 0, week7Cnt = 0, month30Cnt = 0;
    const dayBuckets = {};
    const refCounts  = {};

    visits.forEach(v => {
        const ms = v.ts?.toDate?.()?.getTime() ?? 0;
        if (ms >= todayMs)   todayCnt++;
        if (ms >= week7Ms)   week7Cnt++;
        if (ms >= month30Ms) month30Cnt++;

        if (ms >= week7Ms) {
            const d   = new Date(ms);
            const key = `${d.getFullYear()}-${_p(d.getMonth()+1)}-${_p(d.getDate())}`;
            dayBuckets[key] = (dayBuckets[key] || 0) + 1;
        }

        const rawRef = (v.ref || '').trim();
        if (rawRef) {
            let host = rawRef;
            try { host = new URL(rawRef).hostname.replace(/^www\./, ''); } catch {}
            refCounts[host] = (refCounts[host] || 0) + 1;
        }
    });

    // Build 7-day bar data
    const days7 = [];
    for (let i = 6; i >= 0; i--) {
        const d   = new Date(now - i * 86_400_000);
        const key = `${d.getFullYear()}-${_p(d.getMonth()+1)}-${_p(d.getDate())}`;
        days7.push({ key, label: d.toLocaleDateString('en', { weekday: 'short' }), count: dayBuckets[key] || 0 });
    }
    const maxDay = Math.max(...days7.map(d => d.count), 1);

    const topRefs   = Object.entries(refCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const recent20  = visits.slice(0, 20);
    const allCount  = visits.length >= 2000 ? '2000+' : visits.length;

    body.innerHTML = `
        <div class="an-stats">
            <div class="an-stat">
                <div class="an-stat-num">${todayCnt}</div>
                <div class="an-stat-label">Today</div>
            </div>
            <div class="an-stat">
                <div class="an-stat-num">${week7Cnt}</div>
                <div class="an-stat-label">7 days</div>
            </div>
            <div class="an-stat">
                <div class="an-stat-num">${month30Cnt}</div>
                <div class="an-stat-label">30 days</div>
            </div>
            <div class="an-stat an-stat--accent">
                <div class="an-stat-num">${allCount}</div>
                <div class="an-stat-label">All time</div>
            </div>
        </div>

        <div class="an-section">
            <div class="an-section-label">Last 7 days</div>
            <div class="an-chart">
                ${days7.map(d => `
                    <div class="an-bar-col">
                        <div class="an-bar-wrap">
                            <div class="an-bar" style="height:${Math.round(d.count / maxDay * 100)}%"
                                 title="${d.count} visit${d.count !== 1 ? 's' : ''}"></div>
                        </div>
                        <div class="an-bar-count">${d.count || ''}</div>
                        <div class="an-bar-label">${_esc(d.label)}</div>
                    </div>
                `).join('')}
            </div>
        </div>

        ${topRefs.length ? `
        <div class="an-section">
            <div class="an-section-label">Top referrers</div>
            <div class="an-refs">
                ${topRefs.map(([host, cnt]) => `
                    <div class="an-ref-row">
                        <span class="an-ref-host">${_esc(host)}</span>
                        <span class="an-ref-cnt">${cnt}</span>
                    </div>
                `).join('')}
            </div>
        </div>` : ''}

        <div class="an-section">
            <div class="an-section-label">Recent visits</div>
            ${recent20.length === 0
                ? '<p class="ws-placeholder">No visits recorded yet.</p>'
                : `<div class="an-recent">
                    <div class="an-recent-hdr">
                        <span>Time</span><span>Referrer</span><span>Browser</span>
                    </div>
                    ${recent20.map(v => {
                        const ts  = v.ts?.toDate?.();
                        const ref = _refHost(v.ref || '');
                        return `<div class="an-recent-row">
                            <span class="an-recent-time">${_esc(ts ? ts.toLocaleString() : '—')}</span>
                            <span class="an-recent-ref">${_esc(ref)}</span>
                            <span class="an-recent-browser">${_esc(_browser(v.ua || ''))}</span>
                        </div>`;
                    }).join('')}
                </div>`}
        </div>
    `;
}

/* ── helpers ── */
function _p(n) { return String(n).padStart(2, '0'); }

function _refHost(raw) {
    if (!raw.trim()) return 'direct';
    try { return new URL(raw).hostname.replace(/^www\./, '') || raw; } catch { return raw; }
}

function _browser(ua) {
    if (/Edg\//.test(ua))                         return 'Edge';
    if (/OPR\//.test(ua))                          return 'Opera';
    if (/SamsungBrowser/.test(ua))                 return 'Samsung';
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
    if (/Firefox\//.test(ua))                      return 'Firefox';
    if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
    if (/Mobile/.test(ua))                         return 'Mobile';
    return 'Other';
}

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
