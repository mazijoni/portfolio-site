# Maze Development — Portfolio Site

Studio portfolio and product hub for Maze Development. Built with vanilla HTML/CSS/JS, Three.js, and Firebase.

**Live at:** [mazijoni.github.io](https://mazijoni.github.io)

---

## Site Structure

```
portfolio-site/
├── index.html          — Main studio landing page
├── login.html          — Firebase auth entry point
├── private.html        — Members-only media collection
├── portfolio/          — Personal developer portfolio (Jonatan Lund Ermesjø)
├── workspace/          — Project management platform
├── orbit/              — Orbit Browser product page
└── 3d/                 — GLB models for the hero section
```

---

## Pages

### Main Site (`index.html`)

Four sections:

| # | Section | Content |
|---|---------|---------|
| 01 | **Studio** | 3D Games (Godot · GDScript · Horror), Full-Stack Web (TypeScript · React · Node.js · Firebase), Desktop Tools (Chromium · Electron · Rust · Python) |
| 02 | **Projects** | Featured open-source work (Orbit Browser + GitHub links) |
| 03 | **Products** | Live tools: Orbit Browser, Workspace, Personal Portfolio |
| 04 | **Contact** | Email, GitHub, Itch.io, YouTube, LinkedIn |

Hero background uses **Three.js** to randomly load and wireframe one of the GLB models from `3d/manifest.json` (cube, ico, suzanne, mball, torus, sphere). Falls back to an icosahedron if load fails.

---

### Personal Portfolio (`portfolio/`)

Developer portfolio for **Jonatan Lund Ermesjø** — same design tokens as the main site.

**Skills:**
- Frontend: HTML5 / CSS3 / JavaScript / TypeScript / React
- Backend: Node.js / Python / Firebase
- Game Dev: Godot / Unreal
- Desktop: Electron / Chromium
- Tools: Git / GitHub / VS Code / Blender

---

### Orbit Browser (`orbit/`)

Product landing page for the custom Chromium-based browser.

- GitHub: [github.com/mazijoni/orbit_browser](https://github.com/mazijoni/orbit_browser)

---

### Workspace (`workspace/`)

Firebase-authenticated project management platform.

**Side-nav apps:**
- **Workspace** — Projects with Board, Kanban, Nodes, Media, Overview tabs
- **Links Gallery** — Media links organised by project/category
- **Eurovision 2026** — Tracker
- **Gmail** — Embedded mail client
- **BlueMap** — Map utility

**Workspace layout:**
```
┌──────────────────────────────────────────┐
│  Site Header (fixed, 52px)               │
├──────────────┬───────────────────────────┤
│  Sidebar     │  Topbar (project title)   │
│  (240px)     ├───────────────────────────┤
│              │  Tabs: Overview / Board / │
│              │  Nodes / Media / Kanban   │
│              ├───────────────────────────┤
│              │  Section content          │
└──────────────┴───────────────────────────┘
```

**Firestore data structure:**
```
users/{uid}/projects/{docId}       — name, type, status, description, notes
users/{uid}/boards/{projectId}/cards/{cardId}  — drag-drop canvas cards
users/{uid}/nodes/{projectId}/nodes + edges    — flowchart editor
users/{uid}/links/{docId}          — site | video | image | creator | person
users/{uid}/tasks/{projectId}/items/{taskId}   — kanban cards
```

---

### Private Media Collection (`private.html`)

Members-only gallery for saving images and videos from Reddit, YouTube, and direct URLs.

**Features:** auto-detection of media type & metadata, user-defined categories, bookmarklet, live search.

**Firestore data structure:**
```
users/{uid}/media/{docId}    — url, title, category, type, source, mediaUrl, ytId, subreddit, addedAt
users/{uid}/categories/{name}
```

---

## Design System

### Colors
| Token | Value | Usage |
|-------|-------|-------|
| `--bg-dark` | `#0a0a0a` | Page background |
| `--bg-secondary` | `#151515` | Footer, mobile menu |
| `--bg-card` | `#1a1a1a` | Cards, inputs |
| `--text-primary` | `#ffffff` | Headings |
| `--text-secondary` | `#a0a0a0` | Body text |
| `--accent-purple` | `#c772fe` | Accent, hover states |
| `--border-color` | `#2a2a2a` | Borders, dividers |

### Typography
- **Font:** `Geist` (sans, mono, serif variants)
- **Icons:** Material Symbols Rounded

### Responsive
- Mobile breakpoint: `768px`
- Single-column layouts on mobile, multi-column on desktop

---

## Firebase Setup

1. [console.firebase.google.com](https://console.firebase.google.com) → your project
2. **Authentication → Sign-in method** → enable **Email/Password** and **Google**
3. **Authentication → Settings → Authorized domains** → add `localhost` for local dev
4. **Firestore** → Create database (test mode for dev)
5. **Firestore → Rules:**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

## Contact

| | |
|---|---|
| Email | `jonatan.lund.ermesjo@gmail.com` |
| GitHub | [github.com/mazijoni](https://github.com/mazijoni) |
| LinkedIn | [linkedin.com/in/jonatan-lund-ermesjo](https://www.linkedin.com/in/jonatan-lund-ermesjo-b8b332353/) |
| YouTube | [youtube.com/@maze_joni](https://www.youtube.com/@maze_joni) |
| TikTok | [tiktok.com/@maze_development](https://www.tiktok.com/@maze_development) |

---

```
Ø 2025 Maze_Development. No rights reserved.
```
