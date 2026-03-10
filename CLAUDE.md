# Live Healthy Chicago — Project Notes

## Active File
- **`index-stage.html`** — the working/staging file (password protected)
- `index.html` — public-facing file (no password gate)
- Deployed to Netlify at **livehealthychi.com**

## Architecture
- Single-file React 18 (UMD/CDN) + Babel standalone for JSX
- Tailwind CSS via CDN
- No build step — push `index-stage.html` (or `index.html`) to git → Netlify auto-deploys

## Password Gate (index-stage.html only)
- Password is **"heart"** — stored as SHA-256 hash only (never plaintext in source)
- Hash: `3cb968a982080be1d7a5df98dc49673a8c052d2642ef7730b7753cee5b87c3dd`
- Uses `crypto.subtle.digest('SHA-256', ...)` to hash input before comparing
- Session persisted via `sessionStorage` key `lhc_auth`

## Events (Google Sheets Live Feed)
- CSV URL: `https://docs.google.com/spreadsheets/d/e/2PACX-1vSUS02k2X8ZpE70QyMM0gDAPhvhzEYPt0rOgUgZUZcqZj--zq0P0AdO7HtS4U0uNA_kRm6f8MTZJM4Y/pub?output=csv`
- CORS only works from a real origin (deployed URL or local server via `npx serve .`) — not from `file://`
- **Column mapping (as of Events (2).xlsx):**
  - A(0): LHC Confirmed — filter: `/confirm|yes/i`
  - B(1): Event Date — format `M/D/YYYY`, parsed by `parseSheetDate()`
  - C(2): Host (not displayed)
  - D(3): Event Name → `title`
  - E(4): Event Hours → `time`
  - F(5): Event Description → `description` (short)
  - G(6): Long Description → `longDescription` (shown in popup if present)
  - H(7): Host Contact (not displayed)
  - I(8): LHC Lead (not displayed)
  - J(9): Requested Resources (not displayed)
  - K(10): Location → `location`
  - L(11): Neighborhood → `neighborhood`
  - M(12): Estimated Attendees (not displayed)
  - N(13): Image → `image` (hero in popup if present)
- `parseCSV()` is character-by-character to handle multi-line quoted fields (Long Description cells contain newlines)

## Contact Form
- Netlify Forms — hidden static form in `<body>` for crawler detection
- React form submits via `fetch('/index-stage.html', { method: 'POST', ... })`
- Checks `res.ok || res.status === 303` for success

## Section Order (top → bottom)
1. Hero (looping Vimeo video background)
2. About — "What Is Blood Pressure?"
3. Why It Matters (looping Vimeo video background)
4. Know Your Numbers / BP facts + chart
5. How Live Healthy Chicago Works (model diagram)
6. 27 Priority Neighborhoods (image carousel, hypertension stats overlay)
7. The Coalition (auto-advancing tabs, 6 groups)
8. Events (live from Google Sheets)
9. News / Stories (featured Death Gap article only; 4 mini articles hidden)
10. Take Action CTA
11. Pressure Drop section (hidden, `display: 'none'`)
12. Footer

## Tone / Copy Direction
- Approved headline: **"Stronger Hearts. Healthier Neighborhoods."**
- Copy from one-pager (`one-page-flyer-24feb2026.pdf`) — patient-facing, plain language
- No "doom and gloom" stats, no grant-writing jargon
- Avoid: "silent killer", "ASCVD", "wicked problem"

## Key Assets
- Logo: `https://assets.codepen.io/3457845/logo-Live-Healthy-Chicago.png`
- Model diagram: `https://assets.codepen.io/3457845/LHC%2BModel.webp`
- Favicon: Cloudinary PNG (in `<link rel="icon">` in `<head>`)
- Neighborhood images: all 27 neighborhoods have Cloudinary image URLs
- Event images: Cloudinary URLs in column N of the sheet

## Hypertension Data
- Chicago average: **31.9%**
- Source: `Hypertension Focus Neighborhoods Data.csv` (27 neighborhoods)
- Carousel compares each neighborhood rate to city average with a bar indicator
