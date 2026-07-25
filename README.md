# Prahlad Singh — Portfolio Website

A single-page, dark-sidebar developer portfolio built as one self-contained HTML file. Features a Three.js particle-network background, an animated terminal "cat about.md" intro, live GitHub repo data pulled from the GitHub REST API, scroll/hover micro-interactions, and a fully responsive mobile nav.

## ✨ Features

- **Single-file build** — all HTML, CSS, and JS live in one `index.html`, no build step required.
- **Sections**: About, Skills, Experience, Projects, GitHub, Education, Contact — client-side tab routing (no page reloads).
- **Live GitHub integration** — fetches profile + all public repos from `api.github.com` at runtime (stats, languages, stars, forks, links).
- **Three.js visuals** — animated particle-network canvas behind the whole page, plus a rotating wireframe icosahedron/octahedron in the sidebar.
- **Terminal typewriter intro** on the About section.
- **Animated skill bars, counters, and scroll-reveal** effects (`IntersectionObserver`).
- **3D tilt-on-hover** for cards (projects, skills, experience, repos, etc.).
- **Fully responsive** — collapses to a horizontal mobile nav bar under 900px, sidebar/Three.js sidebar scene hidden on mobile.
- **Custom cursor glow** effect (desktop only).

## 🗂 File Structure

```
index.html      → everything (markup, styles, scripts) in a single file
Prahlad.jpg     → profile avatar (falls back to "PS" initials if missing)
prahlad_resume.pdf → resume, linked from sidebar + contact section
```

## 🚀 Running Locally

No build tools needed — it's static HTML.

```bash
# Option 1: just open it
open index.html

# Option 2: serve it (recommended, avoids some browser file:// restrictions)
python3 -m http.server 8000
# then visit http://localhost:8000
```

> Serving over `http://` (rather than `file://`) is recommended since the page makes live `fetch()` calls to the GitHub API.

## ⚙️ Configuration / Personalizing

To reuse this template for someone else, update:

| What | Where |
|---|---|
| Name, role, location | `.s-name`, `.s-role`, `.s-location` in the sidebar, and the `<title>` tag |
| Avatar image | Replace `Prahlad.jpg`, or edit the `<img src="...">` in `.avatar` |
| GitHub username | Change `PrahladWebDev` in the two `fetch()` calls inside `fetchFullGitHub()` |
| Social links | `mailto:`, LinkedIn, WhatsApp, Portfolio, GitHub `href`s in `.socials` and the Contact section |
| Resume file | Replace `prahlad_resume.pdf` and keep filenames matching the `href="...“ download` links |
| About / What I Do text | `.info-block .ib-text` in the About section |
| Skills & proficiency bars | `.skill-block` blocks — tags in `.skill-tags`, bar percentages via `data-w` attributes |
| Experience timeline | `.exp-item` blocks under `#section-experience` |
| Projects | `.proj-card` blocks under `#section-projects` (name, description, feature list, stack tags, links) |
| Education | `.edu-card` blocks under `#section-education` |
| Color theme | CSS custom properties in `:root` (`--black`, `--white`, `--accent`, etc.) |

## 🧰 Tech Used

- Vanilla HTML/CSS/JS (no framework, no bundler)
- [Three.js r128](https://threejs.org/) (loaded via CDN) for the background/sidebar 3D scenes
- [GitHub REST API](https://docs.github.com/en/rest) for live repo/profile data
- Google Fonts: Syne, Space Grotesk, Space Mono

## 📱 Browser Support

Modern evergreen browsers (Chrome, Firefox, Safari, Edge). Relies on `IntersectionObserver`, CSS custom properties, `fetch`, and WebGL (for the Three.js scenes) — these are all standard in current browsers but the 3D backgrounds will silently no-op if WebGL isn't available.

## 📄 License

Personal portfolio — feel free to fork the structure/animations for your own site, but please swap out the content (name, projects, resume, links) before publishing.
