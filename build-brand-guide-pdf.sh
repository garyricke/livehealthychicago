#!/bin/bash
# Build a print-friendly PDF of brand-guide.html.
# Strategy: copy the guide to a tmp file, strip the password gate, inject
# @media print CSS that hides the sidebar/menu/toast and resets the main
# margin, then render with Chrome headless.
#
# Usage: ./build-brand-guide-pdf.sh
# Output: brand-guide.pdf (in the project root)

set -euo pipefail

cd "$(dirname "$0")"

SRC="brand-guide.html"
TMP_HTML="$(mktemp -t brand-guide-print.XXXXXX).html"
OUT_PDF="brand-guide.pdf"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -f "$SRC" ]]; then
  echo "ERROR: $SRC not found" >&2
  exit 1
fi

# Build the print HTML:
#  - Inject print CSS immediately before </style>
#  - Inject a tiny <script> that hides the gate and shows page-content
#    before paint, so the gate never flashes in the PDF.
PRINT_CSS='
/* ── PDF print rules ─────────────────────────────────────── */
@media print {
  @page { size: Letter; margin: 0.5in; }
  html, body { background: #fff !important; }
  body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  #password-gate, #sidebar, #menu-toggle, #toast, .sidebar-pdf-link { display: none !important; }
  #main { margin-left: 0 !important; }
  .section, .section-hero { padding: 36px 40px !important; page-break-inside: avoid; break-inside: avoid; border-bottom: 1px solid #DDE3EA !important; }
  .section-hero { color: #fff !important; }
  .section-hero .section-title, .section-hero .section-subtitle, .section-hero .hero-tagline, .section-hero .hero-meta-item, .section-hero .hero-meta-item strong { color: #fff !important; }
  .pillar-card, .usage-card, .type-scale-row, .logo-card, .icon-rule-card, .voice-card, .rewrite-row, .component-card { page-break-inside: avoid; break-inside: avoid; }
  h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
  a { color: inherit !important; text-decoration: none !important; }
}
/* When opened in print build, always show the page (no gate) */
html.print-build #password-gate { display: none !important; }
html.print-build #page-content { display: block !important; }
'

PRINT_SCRIPT='
<script>
  // Print build: skip the gate
  document.documentElement.classList.add("print-build");
  // Block the gate-restore code that runs later by pre-setting localStorage
  try { localStorage.setItem("lhc_brand_auth", "1"); } catch(e) {}
</script>
'

# Use python for the surgery — sed across multi-line is awkward.
python3 - "$SRC" "$TMP_HTML" "$PRINT_CSS" "$PRINT_SCRIPT" <<'PYEOF'
import sys, pathlib
src, dst, print_css, print_script = sys.argv[1:5]
html = pathlib.Path(src).read_text(encoding="utf-8")

# Inject print CSS before </style>
html = html.replace("</style>", print_css + "\n  </style>", 1)

# Inject the early script in <head> so it runs before the gate logic
html = html.replace("</head>", print_script + "\n</head>", 1)

pathlib.Path(dst).write_text(html, encoding="utf-8")
print("Wrote tmp:", dst)
PYEOF

# Render to PDF
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --hide-scrollbars \
  --no-pdf-header-footer \
  --print-to-pdf-no-header \
  --print-to-pdf="$OUT_PDF" \
  --virtual-time-budget=15000 \
  "file://$TMP_HTML"

rm -f "$TMP_HTML"
echo "✓ Wrote $OUT_PDF"
ls -la "$OUT_PDF"
