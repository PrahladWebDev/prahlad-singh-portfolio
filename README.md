# Prahlad Singh — Portfolio Website

A single-page, dark-sidebar developer portfolio built as one self-contained HTML file. Features a Three.js particle-network background, an animated terminal "cat about.md" intro, live GitHub repo data pulled from the GitHub REST API, scroll/hover micro-interactions, and a fully responsive mobile nav.

## ✨ Features

- **Single-file build** — all HTML, CSS, and JS live in one `index.html`, no build step required.
- **Sections**: About, Skills, Experience, Projects, Web Store, GitHub, Education, Contact — client-side tab routing (no page reloads).
- **Web Store** — Microsoft-Store-style download hub for APK/EXE builds (Gathalok, Foldd). Edit the `STORE_APPS` array in `index.html`; set `url` to enable a download, `null` shows "Coming soon". Icons live in `store/`.
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
store/          → Web Store app icons (webp)
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
| Color theme | Default **Cloud** (cartoon, soothing) palette lives in `html:not([data-theme])`; other themes (Midnight, Light, Dracula, Forest, Nord, Synthwave) are `html[data-theme="…"]` blocks. Change `--accent`, `--butter`, `--mint`, etc. to re-tint. |

## 🧰 Tech Used

- Vanilla HTML/CSS/JS (no framework, no bundler)
- [Three.js r128](https://threejs.org/) (loaded via CDN) for the background/sidebar 3D scenes
- [GitHub REST API](https://docs.github.com/en/rest) for live repo/profile data
- Google Fonts: Syne, Space Grotesk, Space Mono

## 📱 Browser Support

Modern evergreen browsers (Chrome, Firefox, Safari, Edge). Relies on `IntersectionObserver`, CSS custom properties, `fetch`, and WebGL (for the Three.js scenes) — these are all standard in current browsers but the 3D backgrounds will silently no-op if WebGL isn't available.

## 📄 License

Personal portfolio — feel free to fork the structure/animations for your own site, but please swap out the content (name, projects, resume, links) before publishing.

---

## Cartoon edition — extras

| Feature | Where |
|---|---|
| Waving cartoon mascot (blinks, eyes follow cursor, talks on click) | `#heroMascot` in the About section · JS `initHeroMascot` |
| Cursor sparkle trail (desktop only) | JS `initTrail` |
| Auto day/night theme by local time (click = toggle, double-click = back to Auto) | `#modeBtn` · JS `initThemeSwitcher` · key `prahlad-portfolio-theme-v3` |
| Comic-panel page transitions | `#panel-wipe` · JS `panelWipe()` |
| Drifting clouds + rain/snow toggle | `.drift` clouds · `#weatherBtn` · JS `initWeather` |
| Chunky cartoon icons | `svg.toon` (nav, stats, skills, education, contact) |
| Fun 404 page | `404.html` — add `error_page 404 /404.html;` to the nginx server block, then `sudo nginx -t && sudo systemctl reload nginx` |

---

## Live visitors, wave counter, guestbook & Gmail contact form

These need a tiny backend, so they live in `server/` (Node + Express, no database — data is a JSON file in `server/data/`).

| Feature | Where |
|---|---|
| "N visitors online" pill (Server-Sent Events, tabs of one browser count once) | About → NOW card · JS `initLive` |
| 👋 Wave button + global counter (others see a floating 👋 live) | About hero buttons |
| Guestbook (name + 280-char note, no links, honeypot, rate-limited, emailed to you) | Contact section |
| Contact form sends real email through your Gmail (falls back to `mailto:` if the API is down) | Contact section · `POST /api/contact` |

### One-time setup on the VPS

```bash
cd /var/www/prahladsingh.in/server
cp .env.example .env && nano .env        # set GMAIL_APP_PASSWORD + ADMIN_TOKEN
npm install --omit=dev
npm i -g pm2 && pm2 startOrReload ecosystem.config.js && pm2 save && pm2 startup
```

1. **Gmail app password**: Google Account → Security → turn on 2-Step Verification → *App passwords* → create one → paste the 16 characters into `GMAIL_APP_PASSWORD`. Your normal Gmail password will not work, and it must never go into `index.html` or git.
2. Paste `nginx-api.conf.example` into the site's nginx `server { }` block, then `sudo nginx -t && sudo systemctl reload nginx`.
3. After that, every push to `main` redeploys the API too (see `.github/workflows/deploy.yml`).

Delete a guestbook entry: `curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://prahladsingh.in/api/guestbook/<id>` (the id is in the notification email).
Local testing: `cd server && npm i && node server.js`, then serve the site with a proxy for `/api`, or set `window.PORTFOLIO_API = 'http://127.0.0.1:4000/api'` before the main script and `ALLOWED_ORIGIN=http://localhost:8000` in `.env`.
