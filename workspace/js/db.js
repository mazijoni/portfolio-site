/**
 * db.js — Firestore collection reference helpers.
 *
 * Firestore structure:
 *
 *   users/{uid}/
 *     projects/{projectId}          ← project documents
 *     projects/{projectId}/
 *       board_items/{itemId}        ← board cards (notes, links, images)
 *       nodes/{nodeId}              ← node flow nodes
 *       node_edges/{edgeId}         ← node flow edges
 *       media/{itemId}              ← media / links / notes
 *       kanban_tasks/{taskId}       ← kanban tasks
 */

import {
    collection, doc
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

export const refs = {
    /** users/{uid}/projects */
    projects: (db, uid) =>
        collection(db, "users", uid, "projects"),

    /** users/{uid}/projects/{pid}/board_items */
    boardItems: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "board_items"),

    /** users/{uid}/projects/{pid}/nodes */
    nodes: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "nodes"),

    /** users/{uid}/projects/{pid}/node_edges */
    nodeEdges: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "node_edges"),

    /** users/{uid}/projects/{pid}/media */
    media: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "media"),

    /** users/{uid}/projects/{pid}/kanban_tasks */
    kanbanTasks: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "kanban_tasks"),

    /** users/{uid}/links  (used by workspace media section — do NOT use for Link Gallery) */
    links: (db, uid) =>
        collection(db, "users", uid, "links"),

    /** users/{uid}/gallery-links  (Link Gallery app — standalone from workspace) */
    galleryLinks: (db, uid) =>
        collection(db, "users", uid, "gallery-links"),

    /** users/{uid}/gmail-contacts */
    gmailContacts: (db, uid) =>
        collection(db, "users", uid, "gmail-contacts"),

    /** users/{uid}/settings/links — single doc for Link Gallery settings (categories, etc.) */
    linkSettings: (db, uid) =>
        doc(db, "users", uid, "settings", "links"),

    /** users/{uid}/settings/eurovision — single doc for Eurovision ballot, room, and history */
    eurovisionSettings: (db, uid) =>
        doc(db, "users", uid, "settings", "eurovision"),

    /** users/{uid}/projects/{pid} — single project doc */
    project: (db, uid, pid) =>
        doc(db, "users", uid, "projects", pid),

    /** users/{uid}/sheet-sources — saved URL-based sheets for the Sheet Viewer app */
    sheetSources: (db, uid) =>
        collection(db, "users", uid, "sheet-sources"),

    /** user_profiles/{uid} — public profile written on login (email, displayName) */
    userProfile: (db, uid) =>
        doc(db, "user_profiles", uid),

    /** user_profiles — top-level collection for user lookups by email */
    userProfiles: (db) =>
        collection(db, "user_profiles"),

    /** users/{uid}/memberships — projects shared with this user */
    memberships: (db, uid) =>
        collection(db, "users", uid, "memberships"),

    /** users/{uid}/memberships/{membershipId} — single membership doc */
    membershipDoc: (db, uid, membershipId) =>
        doc(db, "users", uid, "memberships", membershipId),

    /** users/{uid}/projects/{pid}/anim_scenes */
    animScenes: (db, uid, pid) =>
        collection(db, "users", uid, "projects", pid, "anim_scenes"),

    /** users/{uid}/settings/features — per-user feature flags (written by admin) */
    featuresSettings: (db, uid) =>
        doc(db, "users", uid, "settings", "features"),

    /** admin/serviceConfig — global admin-managed service domain settings */
    serviceConfig: (db) =>
        doc(db, "admin", "serviceConfig"),
};
