/**
 * features.js — Per-user feature flags.
 *
 * Flags live at  users/{uid}/settings/features  and are written by the admin.
 * If no document exists all features default to enabled.
 */

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

export const FEATURE_KEYS = ["links", "gmail", "analytics", "bluemap", "sheet"];

const DEFAULTS = { links: true, gmail: true, analytics: true, bluemap: true, sheet: true };

/**
 * Fine-grained Link-Gallery sub-features. Admin can gate any of these per user
 * (stored nested under `gallery` in the same features doc). The catalogue is the
 * single source of truth shared by the admin panel and the gallery itself.
 */
export const GALLERY_FEATURES = {
    // Views
    viewGrid:        { label: "Grid view",            group: "Views",     default: true },
    viewTiles:       { label: "Tiles view",           group: "Views",     default: true },
    viewList:        { label: "List view",            group: "Views",     default: true },
    viewFeed:        { label: "Feed / Phone view",    group: "Views",     default: true },
    viewCoverflow:   { label: "Coverflow view",       group: "Views",     default: true },
    // Toolbar actions
    actionAdd:       { label: "Add media",            group: "Actions",   default: true },
    actionImport:    { label: "Import from workspace",group: "Actions",   default: true },
    actionAutolink:  { label: "Auto-link all",        group: "Actions",   default: true },
    // Media sections
    sectionImages:   { label: "Images section",       group: "Sections",  default: true },
    sectionVideos:   { label: "Videos section",       group: "Sections",  default: true },
    sectionPeople:   { label: "People section",       group: "Sections",  default: true },
    sectionSites:    { label: "Sites section",        group: "Sections",  default: true },
    // Coverflow options (admin allows; end-user toggles within)
    cfReflection:    { label: "Coverflow reflection", group: "Coverflow", default: true },
    cfAutoplay:      { label: "Coverflow autoplay",   group: "Coverflow", default: true },
    cfExplodeGroups: { label: "Coverflow explode groups", group: "Coverflow", default: true },
    cfCustomize:     { label: "Coverflow user settings", group: "Coverflow", default: true },
};

/** Default map for the gallery sub-features ({ viewGrid: true, … }). */
export function galleryDefaults() {
    const d = {};
    for (const [k, m] of Object.entries(GALLERY_FEATURES)) d[k] = m.default;
    return d;
}

const GALLERY_DEFAULTS = galleryDefaults();

let _features = null;

/**
 * Load the user's feature flags from Firestore.
 * Call once in onUserReady before initHub/renderHubButtons.
 */
export async function loadUserFeatures(db, uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid, "settings", "features"));
        const data = snap.exists() ? snap.data() : {};
        _features = { ...DEFAULTS, ...data };
        // Gallery sub-features deep-merge so missing keys keep their defaults.
        _features.gallery = { ...GALLERY_DEFAULTS, ...(data.gallery || {}) };
    } catch {
        _features = { ...DEFAULTS, gallery: { ...GALLERY_DEFAULTS } };
    }
    return { ..._features };
}

/** Returns true when the feature is enabled (or flags haven't loaded yet). */
export function isFeatureEnabled(feature) {
    if (!_features) return true;
    return _features[feature] !== false;
}

/**
 * Returns true when a Link-Gallery sub-feature is enabled (or flags haven't
 * loaded yet). `key` is a GALLERY_FEATURES key, e.g. "viewCoverflow".
 */
export function isGalleryFeatureEnabled(key) {
    if (!_features || !_features.gallery) return GALLERY_FEATURES[key]?.default !== false;
    return _features.gallery[key] !== false;
}

/** Returns a shallow copy of current flags (all keys present). */
export function getFeatures() {
    return { ...DEFAULTS, ..._features, gallery: { ...GALLERY_DEFAULTS, ...(_features?.gallery || {}) } };
}
