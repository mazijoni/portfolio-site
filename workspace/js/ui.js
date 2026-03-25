/**
 * ui.js — Shared UI helpers: modal management, toast, confirm dialog.
 */

/* ── Modal ── */

export function initUI() {
    // ── Sidebar toggle ──
    const sidebar    = document.getElementById("ws-sidebar");
    const toggleBtn  = document.getElementById("ws-sidebar-toggle");
    const mobileBtn  = document.getElementById("ws-mobile-menu-btn");
    const overlay    = document.getElementById("ws-sidebar-overlay");

    function toggleSidebar() {
        if (window.innerWidth <= 560) {
            const isOpen = sidebar.classList.toggle("mobile-open");
            if (overlay) overlay.classList.toggle("visible", isOpen);
        } else {
            const isCollapsed = sidebar.classList.toggle("collapsed");
            document.body.classList.toggle("sidebar-collapsed", isCollapsed);
            if (toggleBtn) toggleBtn.classList.toggle("rotated", isCollapsed);
        }
    }

    if (toggleBtn) toggleBtn.addEventListener("click", toggleSidebar);
    if (mobileBtn) mobileBtn.addEventListener("click", toggleSidebar);
    if (overlay)   overlay.addEventListener("click", () => {
        sidebar.classList.remove("mobile-open");
        overlay.classList.remove("visible");
    });

    // Close mobile sidebar when a project is selected
    document.addEventListener("click", (e) => {
        if (e.target.closest(".ws-project-item") && window.innerWidth <= 560) {
            sidebar.classList.remove("mobile-open");
            if (overlay) overlay.classList.remove("visible");
        }
    });

    // Close modal on backdrop click or [data-modal] button click
    document.addEventListener("click", (e) => {
        const trigger = e.target.closest("[data-modal]");
        if (trigger) {
            closeModal(trigger.dataset.modal);
            return;
        }
        // Close on overlay click (outside .ws-modal)
        if (e.target.classList.contains("ws-modal-overlay")) {
            const id = e.target.id;
            if (id) closeModal(id);
        }
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            document.querySelectorAll(".ws-modal-overlay:not(.hidden)").forEach((el) => {
                closeModal(el.id);
            });
        }
    });
}

export function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
}

export function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
}

export function setModalTitle(modalId, title) {
    const el = document.querySelector(`#${modalId} h2`);
    if (el) el.textContent = title;
}

/* ── Toast ── */

let _toastTimer = null;

/**
 * @param {string} msg
 * @param {"success"|"error"|""} type
 * @param {number} duration ms
 */
export function toast(msg, type = "", duration = 2800) {
    const el = document.getElementById("ws-toast");
    if (!el) return;

    clearTimeout(_toastTimer);
    el.textContent = msg;
    el.className = "ws-toast show" + (type ? " " + type : "");

    _toastTimer = setTimeout(() => {
        el.classList.remove("show");
    }, duration);
}

/* ── Confirm dialog ── */

/**
 * Show a confirmation modal and resolve with true/false.
 * @param {string} msg
 * @returns {Promise<boolean>}
 */
export function confirm(msg) {
    return new Promise((resolve) => {
        const overlay = document.getElementById("modal-confirm");
        document.getElementById("modal-confirm-msg").textContent = msg;
        overlay.classList.remove("hidden");

        const ok     = document.getElementById("btn-confirm-ok");
        const cancel = document.getElementById("btn-confirm-cancel");

        function cleanup(result) {
            overlay.classList.add("hidden");
            ok.removeEventListener("click", onOk);
            cancel.removeEventListener("click", onCancel);
            resolve(result);
        }
        const onOk     = () => cleanup(true);
        const onCancel = () => cleanup(false);

        ok.addEventListener("click", onOk);
        cancel.addEventListener("click", onCancel);
    });
}

/* ── HTML escape ── */
export function escHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/* ── Format Firestore timestamp ── */
export function fmtDate(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
