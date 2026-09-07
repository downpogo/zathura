# PDF Fixtures

Original redistributable synthetic assets, dedicated under CC0-1.0 (LICENSE.txt).
No personal data, downloaded PDFs, third-party images, or third-party font data.
`pdfs/manifest.json` records exact bytes, SHA-256, page counts, provenance,
licenses, destinations, passwords, and expected behavior for each checked-in PDF.
Page targets are **one-based physical pages**, sizes are PDF points; PDF parser
indices are zero-based. All nine PDFs, including performance inputs, are checked in.

## Dev Setup

The existing `pnpm test` runner invokes parser validation and deterministic
regeneration through `tests/fixtures.test.mjs`. Missing tools fail with setup
instructions rather than silently skipping validation. Python and these packages
are development-only, never application/runtime dependencies. No package.json or
lockfile changes are required. Setup requires network access or preloaded wheels;
generation and tests perform no network requests and need no external fonts.

Windows PowerShell, with Python 3.12 installed (outside the repository):

```powershell
py -3.12 -m venv "$env:TEMP\zathura-fixtures-venv"
$env:FIXTURE_PYTHON = "$env:TEMP\zathura-fixtures-venv\Scripts\python.exe"
& $env:FIXTURE_PYTHON -m pip install -r fixtures/requirements.txt
pnpm test
# Only when intentionally regenerating the checked-in corpus:
& $env:FIXTURE_PYTHON scripts/generate-fixtures.py
```

Linux/WSL, Python 3.12 with venv support:

```sh
python3 -m venv /tmp/opencode/core02-venv
/tmp/opencode/core02-venv/bin/python -m pip install -r fixtures/requirements.txt
export FIXTURE_PYTHON=/tmp/opencode/core02-venv/bin/python
pnpm test
# Only when intentionally regenerating the checked-in corpus:
"$FIXTURE_PYTHON" scripts/generate-fixtures.py
```

The executable may be selected with `FIXTURE_PYTHON`; otherwise the test uses
`python` on Windows and `python3` elsewhere. It is a path, not a shell command.
Pin Python/tool versions for regeneration. The test checks exact bytes, so a
toolchain/compression change that changes output requires explicit review rather
than silently updating expected hashes. The generator uses pypdf's object API
(including its pinned private object-registration API); it is not a new PDF parser.

## Coverage And Use

| File | Purpose |
| --- | --- |
| basic.pdf | Single page, selectable Latin text, no outline. |
| navigation.pdf | Four pages; nested direct/named destinations, destinationless parent with child, missing named target, literal HTML-like title; three visible link rectangles on page 1 (direct XYZ, named, broken). |
| page-sizes.pdf | Letter portrait, landscape, square with 90-degree rotation. |
| cjk-embedded.pdf | Embedded original TrueType font, Identity-H/CIDToGIDMap and ToUnicode; text U+65E5 U+672C U+4E2D U+6587 (Japanese/Chinese shared glyphs). Only four glyphs, not comprehensive CJK/CMap fallback coverage. |
| scan.pdf | Raster-only synthetic SCAN 01, no hidden text or OCR layer. |
| encrypted.pdf | RC4-128; user `core02-user`, owner `core02-owner`, wrong `wrong-password`. Public test credentials, never real secrets. |
| corrupt.pdf | Deliberately truncated PDF-like bytes; must fail parsing. |
| long-text.pdf | 300 pages with page markers and 35 lines per page. |
| image-heavy.pdf | 12 distinct 512x512 RGB noise images; 9,437,184 decoded image bytes. |

The manifest is the source of exact on-disk byte sizes. For manual performance
checks record hardware, OS/webview, cold open/first page, jump/scroll/zoom,
process-tree peak memory, and repeated open/close recovery. These modest synthetic
inputs are a reproducible baseline, not a maximum-size guarantee or performance
budget. Image-heavy content tests byte transport and decoding, not photo fidelity.

Parser checks cover object graphs, all page content streams, text extraction,
image stream decoding, outline hierarchy, named/direct/broken destinations,
embedded font glyph tables, password absence/failure/retry/user/owner, corrupt
rejection, and byte-for-byte regeneration. They do not prove rendering fidelity.

CORE-04 must run the actual packaged PDF.js worker offline with these PDFs, check
CJK glyph appearance against the codepoints above, text selection and images,
wrong/correct password and prompt cancellation, and corrupt-file recovery.
CORE-05/08 must verify close-during-password/load, navigation and missing-target
handling. A parser cannot validate UI cancellation or native webview behavior.
No native reader or Windows parser run is claimed here without separate evidence.
