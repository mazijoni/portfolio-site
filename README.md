# MAZE_DEVELOPMENT Portfolio - Style Guide & Documentation

## 🎨 Color Palette

### Primary Colors
| Color Name | Hex Code | RGB | Usage |
|------------|----------|-----|-------|
| **Background Dark** | `#0a0a0a` | `rgb(10, 10, 10)` | Main background |
| **Background Secondary** | `#151515` | `rgb(21, 21, 21)` | Footer, mobile menu |
| **Background Card** | `#1a1a1a` | `rgb(26, 26, 26)` | Cards, form inputs |
| **Text Primary** | `#ffffff` | `rgb(255, 255, 255)` | Headings, main text |
| **Text Secondary** | `#a0a0a0` | `rgb(160, 160, 160)` | Body text, descriptions |
| **Accent Purple** | `#c772fe` | `rgb(199, 114, 254)` | Primary accent, hover states |
| **Border Color** | `#2a2a2a` | `rgb(42, 42, 42)` | Card borders, dividers |

### Gradient Overlay
```css
linear-gradient(135deg, rgba(10, 10, 10, 0.85), rgba(123, 97, 255, 0.15))
```

---

## 📐 Typography

### Font Family
- **Primary:** `'Poppins', sans-serif`
- **Weights Used:** 300, 400, 500, 600, 700

### Font Sizes
| Element | Size | Weight |
|---------|------|--------|
| Hero Title (h1) | 4rem | 700 |
| Hero Subtitle (h2) | 1.8rem | 400 |
| Section Title | 2.5rem | 700 |
| Skill Card Title | 1.3rem | - |
| Project Card Title | 1.5rem | - |
| Body Text | 1.1rem | - |
| Navigation Links | - | 500 |

---

## 📱 Responsive Breakpoints

```css
@media (max-width: 768px) {
  /* Mobile adjustments */
  - Hero h1: 2.5rem
  - Hero h2: 1.3rem
  - Section title: 2rem
  - Single column layouts
}
```

---

## 🎭 Animation Details

### Keyframe Animations

**Fade In Up**
```css
Duration: 1s
Easing: ease
Transform: translateY(30px) → translateY(0)
Opacity: 0 → 1
```

**Bounce (Scroll Indicator)**
```css
Duration: 2s
Pattern: infinite
Movement: 0px → -10px → -5px → 0px
```

### Transition Effects
- **Default:** `0.3s ease`
- **Section Reveal:** `0.8s ease`
- **Card Hover:** `transform 0.3s ease, border-color 0.3s ease`

---

## 🎯 Interactive Elements

### Hover States
| Element | Hover Effect |
|---------|--------------|
| Navigation Links | Purple color + underline animation |
| Skill Cards | Translate up 5px + purple border |
| Project Cards | Translate up 8px + gradient background + purple border |
| Buttons | Purple background fill |

### Particle Background
- **Particle Count:** 100
- **Connection Distance:** 120px
- **Mouse Interaction Radius:** 150px
- **Particle Color:** `rgba(123, 97, 255, opacity)`

---

## 📦 Component Structure

### Header
- Fixed position
- Backdrop blur: 10px
- Opacity: 0.95
- Smooth scroll links

### Sections
- Max width: 1400px
- Padding: 6rem 5%
- Intersection observer threshold: 0.15

### Cards
- Background: `var(--bg-card)`
- Border: 1px solid `var(--border-color)`
- Padding: 2rem
- Hover effects on all cards

---

## 🔗 Contact Information

### Email
`jonatan.lund.ermesjo@gmail.com`

### Social Links
- **GitHub:** [github.com/mazijoni](https://github.com/mazijoni)
- **LinkedIn:** [linkedin.com/in/jonatan-lund-ermesjo](https://www.linkedin.com/in/jonatan-lund-ermesjo-b8b332353/)
- **YouTube:** [youtube.com/@maze_joni](https://www.youtube.com/@maze_joni)
- **TikTok:** [tiktok.com/@maze_development](https://www.tiktok.com/@maze_development)

---

## 💼 Featured Projects

### 1. Tower Defense
- **Emoji:** 🏰
- **Demo:** [View Demo](https://mazijoni.github.io/fordypning/index.html)
- **Repo:** [GitHub](https://github.com/mazijoni/fordypning)

### 2. Escape Room
- **Emoji:** 🗝️
- **Demo:** [View Demo](https://mazijoni.github.io/escape_room/index.html)
- **Repo:** [GitHub](https://github.com/mazijoni/escape_room)

### 3. School Finder
- **Emoji:** 🏫
- **Demo:** [View Demo](https://mazijoni.github.io/schools-web/index.html)
- **Repo:** [GitHub](https://github.com/mazijoni/schools-web)

---

## 🛠️ Skills Categories

### Frontend Development
- HTML5 / CSS3
- JavaScript / TypeScript
- React / Electron
- Responsive Design

### Backend Development
- Node.js
- Python
- Database Management

### Tools & Technologies
- Git / GitHub
- Google Drive / OneDrive
- VsCode / Godot

### Other Skills
- Game Development
- Fast Learner
- Problem Solving
- Team Collaboration

---

## 📋 Design Principles

1. **Dark Theme:** Consistent dark color scheme for modern aesthetic
2. **Minimalism:** Clean, uncluttered layouts
3. **Interactivity:** Smooth animations and hover effects
4. **Accessibility:** Proper contrast ratios and semantic HTML
5. **Responsiveness:** Mobile-first approach
6. **Performance:** Optimized animations and particle system

---

## 🔐 Authentication + Media Collection

Two restricted pages using **Firebase Authentication** (Email/Password + Google Sign-In) and **Firebase Firestore** for persistent storage.

### Pages
| File | Purpose |
|------|---------|
| `login.html` | Sign in / create account page |
| `private.html` | Members-only media collection dashboard |

### How the auth flow works
1. User visits `private.html` → auth check runs
2. If **not signed in** → redirected to `login.html?redirect=private.html`
3. User signs in → redirected back to `private.html`
4. "Sign out" button → redirected to `login.html`

---

### 📁 Media Collection Dashboard (`private.html`)

A gallery that saves images and videos from Reddit, YouTube, and any other URL.

**Features:**
- **Sidebar:** Category list with counts; add/delete user-defined categories
- **Add Media panel:** Paste any URL — Reddit posts, YouTube links, direct image/video URLs, or generic links
- **Auto-detection:** Reddit posts are fetched via the Reddit JSON API (`{url}.json?raw_json=1`), extracting title, thumbnail, and media type. YouTube IDs are extracted for thumbnails automatically
- **Gallery grid:** Flat media cards matching the site design; click "Open" to visit the source, "Media" for direct media URL, "Delete" to remove
- **Search:** Live filter by title, source, or subreddit
- **Bookmarklet:** Drag the purple bookmark button to your bookmarks bar. Clicking it on any page opens `private.html` pre-filled with that page's URL and title

**Firestore data structure:**
```
users/{uid}/media/{docId}
  url        — original page URL
  title      — post/page title
  category   — user-defined category name
  type       — 'image' | 'video' | 'youtube' | 'link'
  source     — 'reddit' | 'youtube' | hostname
  mediaUrl   — direct image/video URL (if detected)
  ytId       — YouTube video ID (if YouTube)
  subreddit  — subreddit name (if Reddit)
  addedAt    — Unix timestamp

users/{uid}/categories/{name}
  name       — category display name
```

---

### Firebase setup required
1. [console.firebase.google.com](https://console.firebase.google.com) → your project
2. **Authentication → Sign-in method** → enable **Email/Password** and **Google**
3. **Authentication → Settings → Authorized domains** → add `localhost` for local dev
4. **Firestore Database** → Create database (start in **test mode** for dev, then apply rules below)
5. **Firestore → Rules** → paste the following security rules:

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

This ensures each user can only read and write their own data.

---

### Styling rules
Both pages follow the exact same design language as `index.html`:
- Same CSS variables (`:root`)
- Same animated SVG background (`.anime-container` + `.line` paths)
- Same fixed frosted-glass header with `MAZE_DEVELOPMENT` logo
- Same flat card style: no `border-radius`, `border: 1px solid var(--border-color)`, hover lifts with `border-color: var(--accent-purple)`
- Buttons use transparent background + border, fill purple on hover
- Same custom scrollbar, same Poppins font stack, same footer text

---

## 🎨 Custom Scrollbar

```css
Width: 8px
Track: #0a0a0a
Thumb: #2a2a2a
Thumb Hover: #c772fe
```

---

## 📄 Footer

```
Ø 2025 Maze_Development. No rights reserved.
```

---

## �️ Workspace App (`workspace/`)

A private, Firebase-authenticated project management tool embedded in the portfolio. Accessible at `workspace/index.html`.

### Layout Structure
```
┌─────────────────────────────────────────────────────────┐
│  Site Header (fixed, 52px)                              │
├──────────────────┬──────────────────────────────────────┤
│  Sidebar (240px) │  Topbar (52px)                       │
│  - Projects list │  - Project title, type, status badge │
│  - Nav links     │  - Edit / Delete buttons             │
│                  ├──────────────────────────────────────┤
│                  │  Tabs (44px) — Overview / Board /    │
│                  │               Nodes / Media / Kanban │
│                  ├──────────────────────────────────────┤
│                  │  Section content (scrollable)        │
└──────────────────┴──────────────────────────────────────┘
```

| Variable | Value | Description |
|----------|-------|-------------|
| `--header-h` | `52px` | Fixed top header |
| `--sidebar-w` | `240px` | Collapsible left sidebar |
| `--topbar-h` | `52px` | Per-project top bar |
| `--tabs-h` | `44px` | Section tab bar |

### Color System
The workspace follows the same design tokens as the portfolio:

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-dark` | `#0a0a0a` | Page background |
| `--bg-secondary` | `#151515` | Sidebar, topbar, toolbar strips |
| `--bg-card` | `#1a1a1a` | Cards, modals, inputs |
| `--bg-card-hover` | `#202020` | Card hover state |
| `--bg-input` | `#141414` | Form inputs |
| `--text-primary` | `#ffffff` | Headings, main text |
| `--text-secondary` | `#a0a0a0` | Body text, descriptions |
| `--text-muted` | `#585858` | Labels, placeholders, disabled |
| `--accent` | `#c772fe` | Active states, highlights |
| `--border` | `#2a2a2a` | Default borders |
| `--border-hover` | `#3a3a3a` | Hovered / focused borders |
| `--danger` | `#e05555` | Delete, error |
| `--success` | `#55c87a` | Saved, done |
| `--warn` | `#e0aa44` | Warning, paused |

### Spacing Scale
| Usage | Value |
|-------|-------|
| Section body padding | `1.5rem` |
| Toolbar padding | `0.85rem 1.5rem` |
| Card internal padding | `1.25rem` |
| Compact card (e.g. site card body) | `0.65rem 0.85rem` |
| Creator card | `0.85rem 1rem` |
| Modal form padding | `1.2rem 1.3rem`, gap `1rem` |
| Kanban board padding | `1.5rem` |

### Sections

#### Overview
3-column grid of info cards (Description / Details / Activity) + Quick Notes textarea.

#### Board
Free-form canvas with a collapsible palette sidebar. Drag-and-drop cards (Note, Heading, Link, Image, Todo, Divider). Pan using space+drag or middle mouse.

#### Nodes
Visual flowchart editor. Node types: Start, End, Decision, Process, Data, Note, Image. Drag from ports to connect with SVG edges.

#### Media
Pinterest-style masonry grid (`columns: 4 200px`) split into: **Sites** (16:9 thumbnail grid), **Media** (images + videos, natural height), **Creators** (auto-grid, avatar + platform badge), **Persons/Characters** (same layout). Click a creator to open a slide-up panel showing all their linked content.

**Creator/person platform badge auto-detection** (from URL):
| Domain | Badge class | Label |
|--------|-------------|-------|
| youtube.com / youtu.be | `.yt` | YT |
| twitter.com / x.com | `.tw` | X |
| instagram.com | `.ig` | IG |
| tiktok.com | `.ttk` | TikTok |
| twitch.tv | `.twitch` | Twitch |
| vimeo.com | `.other` | Vimeo |

Custom badge label + color can override defaults via the edit modal.

**Video embed detection** (from `link.url`):
- YouTube (`watch?v=`, `/shorts/`, `/embed/`, `/live/`, `youtu.be`) → `youtube-nocookie.com` iframe
- Vimeo → `player.vimeo.com` iframe
- Direct `.mp4 / .webm / .ogg / .mov / .m4v` → `<video controls>`
- Thumbnail only (`thumbUrl`) → click-to-open with play overlay
- Unrecognized URL → link placeholder

#### Kanban
5-column board: Backlog / To Do / In Progress / Review / Done. Cards have title, description, priority badge (Low / Medium / High).

### Firestore Data Structure (`workspace/`)
```
users/{uid}/projects/{docId}
  name, type, status, description, notes
  createdAt, updatedAt

users/{uid}/boards/{projectId}/cards/{cardId}
  type, x, y, w, h, text, url, imageUrl, items[]

users/{uid}/nodes/{projectId}/nodes/{nodeId}
  type, x, y, label

users/{uid}/nodes/{projectId}/edges/{edgeId}
  from, to

users/{uid}/links/{docId}
  categoryId (= projectId)
  type       — 'site' | 'video' | 'image' | 'creator' | 'person'
  name, url, profileUrl
  imageUrl, thumbUrl, avatarUrl
  description, badgeLabel, badgeColor
  creatorId, personId, personIds[]
  createdAt

users/{uid}/tasks/{projectId}/items/{taskId}
  title, desc, priority, status
  createdAt, updatedAt
```

---

## �🔧 Technical Notes

- **Logo Image:** `img/logo_2.png`
- **Canvas ID:** `particleCanvas`
- **Intersection Observer:** Used for section reveal animations
- **Form Handling:** preventDefault with console logging
- **Smooth Scroll:** Implemented for all anchor links