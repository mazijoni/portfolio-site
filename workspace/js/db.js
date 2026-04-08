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

    /** users/{uid}/projects/{pid} — single project doc */
    project: (db, uid, pid) =>
        doc(db, "users", uid, "projects", pid),
};
