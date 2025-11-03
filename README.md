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
© 2025 Maze_Development. All rights reserved.
```

---

## 🔧 Technical Notes

- **Logo Image:** `img/logo_2.png`
- **Canvas ID:** `particleCanvas`
- **Intersection Observer:** Used for section reveal animations
- **Form Handling:** preventDefault with console logging
- **Smooth Scroll:** Implemented for all anchor links