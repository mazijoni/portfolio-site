/**
 * analytics.js — Portfolio site visit analytics viewer.
 * Reads from the `site_analytics` Firestore collection (admin-only read).
 * Tracking is written from index.html (includes browser, os, device, lang, ip, city, country).
 */

import {
    collection, getDocs, query, orderBy, limit,
    deleteDoc, doc,
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

    if (document.getElementById('app-analytics')?.classList.contains('active')) {
        _fetchAndRender();
    }
}

async function _fetchAndRender() {
    _loaded = true;
    const body = document.getElementById('analytics-body');
    if (!body) return;

    body.innerHTML = '<p class="ws-placeholder">Loading analytics&#8230;</p>';

    try {
        const snap = await getDocs(
            query(collection(_db, 'site_analytics'), orderBy('ts', 'desc'), limit(200))
        );

        const allDocs = snap.docs;
        const toDelete = allDocs.slice(10);
        if (toDelete.length > 0) {
            await Promise.all(toDelete.map(d => deleteDoc(doc(_db, 'site_analytics', d.id))));
        }

        const visits = allDocs.slice(0, 10).map(d => ({ id: d.id, ...d.data() }));
        _render(visits);
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

    const now     = Date.now();
    const week7Ms = now - 7 * 86_400_000;

    const dayBuckets  = {};
    const refCounts   = {};
    const browserCnts = {};
    const osCnts      = {};
    const deviceCnts  = { desktop: 0, mobile: 0, tablet: 0 };
    const countryCnts = {};
    const cityCnts    = {};

    visits.forEach(v => {
        const ms = v.ts?.toDate?.()?.getTime() ?? 0;

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

        const br = v.browser || _browserFromUA(v.ua || '');
        browserCnts[br] = (browserCnts[br] || 0) + 1;

        const os = v.os || _osFromUA(v.ua || '');
        osCnts[os] = (osCnts[os] || 0) + 1;

        const dev = v.device || _deviceFromUA(v.ua || '');
        if (dev in deviceCnts) deviceCnts[dev]++;
        else deviceCnts.desktop++;

        /* Location */
        if (v.country) {
            countryCnts[v.country] = (countryCnts[v.country] || 0) + 1;
        }
        if (v.city && v.country) {
            const loc = `${v.city}, ${v.country}`;
            cityCnts[loc] = (cityCnts[loc] || 0) + 1;
        }
    });

    const days7 = [];
    for (let i = 6; i >= 0; i--) {
        const d   = new Date(now - i * 86_400_000);
        const key = `${d.getFullYear()}-${_p(d.getMonth()+1)}-${_p(d.getDate())}`;
        days7.push({ key, label: d.toLocaleDateString('en', { weekday: 'short' }), count: dayBuckets[key] || 0 });
    }
    const maxDay = Math.max(...days7.map(d => d.count), 1);

    const topRefs     = Object.entries(refCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topBrowsers = Object.entries(browserCnts).sort((a, b) => b[1] - a[1]);
    const topOS       = Object.entries(osCnts).sort((a, b) => b[1] - a[1]);
    const topCountries= Object.entries(countryCnts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topCities   = Object.entries(cityCnts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const recent10 = visits.slice(0, 10);

    body.innerHTML = `
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

        <div class="an-breakdown-row">
            ${topBrowsers.length ? `
            <div class="an-section an-breakdown-col">
                <div class="an-section-label">Browsers</div>
                <div class="an-pills">
                    ${topBrowsers.map(([br, cnt]) => `
                        <div class="an-pill">
                            <span class="an-pill-name">${_esc(br)}</span>
                            <span class="an-pill-cnt">${cnt}</span>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            ${topOS.length ? `
            <div class="an-section an-breakdown-col">
                <div class="an-section-label">OS</div>
                <div class="an-pills">
                    ${topOS.map(([os, cnt]) => `
                        <div class="an-pill">
                            <span class="an-pill-name">${_esc(os)}</span>
                            <span class="an-pill-cnt">${cnt}</span>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            <div class="an-section an-breakdown-col">
                <div class="an-section-label">Devices</div>
                <div class="an-pills">
                    ${Object.entries(deviceCnts).filter(([,c]) => c > 0).map(([dev, cnt]) => `
                        <div class="an-pill">
                            <span class="an-pill-name">${_esc(dev)}</span>
                            <span class="an-pill-cnt">${cnt}</span>
                        </div>
                    `).join('')}
                </div>
            </div>

            ${topCountries.length ? `
            <div class="an-section an-breakdown-col">
                <div class="an-section-label">Countries</div>
                <div class="an-pills">
                    ${topCountries.map(([c, cnt]) => `
                        <div class="an-pill">
                            <span class="an-pill-name">${_esc(c)}</span>
                            <span class="an-pill-cnt">${cnt}</span>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            ${topCities.length ? `
            <div class="an-section an-breakdown-col">
                <div class="an-section-label">Cities</div>
                <div class="an-pills">
                    ${topCities.map(([c, cnt]) => `
                        <div class="an-pill">
                            <span class="an-pill-name">${_esc(c)}</span>
                            <span class="an-pill-cnt">${cnt}</span>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
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
            ${recent10.length === 0
                ? '<p class="ws-placeholder">No visits recorded yet.</p>'
                : `<div class="an-recent an-recent--geo">
                    <div class="an-recent-hdr">
                        <span>Time</span>
                        <span>Referrer</span>
                        <span>Browser / OS</span>
                        <span>Device</span>
                        <span>Location</span>
                        <span>IP</span>
                        <span></span>
                    </div>
                    ${recent10.map(v => {
                        const ts      = v.ts?.toDate?.();
                        const ref     = _refHost(v.ref || '');
                        const browser = v.browser || _browserFromUA(v.ua || '');
                        const os      = v.os      || _osFromUA(v.ua || '');
                        const device  = v.device  || _deviceFromUA(v.ua || '');
                        const location = v.city && v.country
                            ? `${v.city}, ${v.country}`
                            : (v.country || '—');
                        const ip = v.ip || '—';
                        return `<div class="an-recent-row" data-id="${_esc(v.id)}">
                            <span class="an-recent-time">${_esc(ts ? ts.toLocaleString() : '—')}</span>
                            <span class="an-recent-ref">${_esc(ref)}</span>
                            <span class="an-recent-browser">${_esc(browser)} / ${_esc(os)}</span>
                            <span class="an-recent-device">${_esc(device)}</span>
                            <span class="an-recent-loc">${_esc(location)}</span>
                            <span class="an-recent-ip">${_esc(ip)}</span>
                            <button class="an-del-btn" title="Delete">&#x2715;</button>
                        </div>`;
                    }).join('')}
                </div>`}
        </div>
    `;

    body.querySelectorAll('.an-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('.an-recent-row');
            const id  = row?.dataset.id;
            if (!id) return;
            btn.disabled = true;
            try {
                await deleteDoc(doc(_db, 'site_analytics', id));
                row.remove();
            } catch (err) {
                console.error(err);
                btn.disabled = false;
            }
        });
    });
}

/* ── UA fallbacks ── */
function _browserFromUA(ua) {
    if (/Edg\//.test(ua))           return 'Edge';
    if (/OPR\//.test(ua))            return 'Opera';
    if (/SamsungBrowser/.test(ua))   return 'Samsung';
    if (/Firefox\//.test(ua))        return 'Firefox';
    if (/Chrome\//.test(ua))         return 'Chrome';
    if (/Safari\//.test(ua))         return 'Safari';
    return 'Other';
}
function _osFromUA(ua) {
    if (/Windows/.test(ua))          return 'Windows';
    if (/Android/.test(ua))          return 'Android';
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
    if (/Mac OS X/.test(ua))         return 'macOS';
    if (/Linux/.test(ua))            return 'Linux';
    return 'Other';
}
function _deviceFromUA(ua) {
    if (/Mobi|Android|iPhone|BlackBerry|IEMobile|Opera Mini/.test(ua)) return 'mobile';
    if (/iPad|Tablet/.test(ua)) return 'tablet';
    return 'desktop';
}
function _refHost(raw) {
    if (!raw.trim()) return 'direct';
    try { return new URL(raw).hostname.replace(/^www\./, '') || raw; } catch { return raw; }
}
function _p(n) { return String(n).padStart(2, '0'); }
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
