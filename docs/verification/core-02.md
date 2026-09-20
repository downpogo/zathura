# CORE-02 Verification

Date: 2026-09-07. Owner: OpenCode / CORE-02 fixture agent.
Status: done for fixture/test foundations; not native-reader/platform acceptance.
Dependency: CORE-01 Windows compile/release/UIA gate confirmed in core-01.md.

## Subsequent Windows Verification

Parent installed Python 3.12.10 using `winget install --id Python.Python.3.12
--exact --scope user --accept-source-agreements --accept-package-agreements
--silent --disable-interactivity` with prior user authorization/notice. Created
`$env:TEMP\zathura-fixtures-venv` and installed fixtures/requirements.txt there.
With FIXTURE_PYTHON pointing to its Scripts/python.exe, Windows `pnpm test` passed
9/9 including all parser checks and byte-for-byte regeneration. The fixture copy
exists at C:\zathura\fixtures\pdfs. Windows regeneration is now verified;
the later historical agent notes describe the earlier state before this setup.

## Deliverables

- `fixtures/pdfs/`: nine actual PDF inputs and generated `manifest.json` with exact bytes, SHA-256, page counts, expected behavior, targets, public test passwords, provenance and licenses.
- `fixtures/README.md`, `LICENSE.txt`, `requirements.txt`: usage, original-asset CC0 dedication, pinned dev-only setup for Windows and WSL.
- `scripts/generate-fixtures.py`: deterministic content, object graphs, original bitmap images and four-glyph TrueType font. No downloaded assets, system fonts or sensitive data.
- `tests/fixtures.test.mjs`: integrates with existing `pnpm test`; missing prerequisites fail explicitly rather than skipping tests.
- `tests/validate-fixtures.py`: seven parser/regeneration checks.
- Only the CORE-02 handoff section changed in `docs/implementation-plan.md`.

No package.json, lockfile, source, native source, root README, shared entrypoint,
or concurrent CORE-03 files were edited. No commits. No application dependency
additions are requested from the parent agent. Developers running the full suite
now need the separately installed fixture Python tools described below.

## Corpus Metrics

| File | Physical Pages | Actual Bytes |
| --- | ---: | ---: |
| basic.pdf | 1 | 756 |
| navigation.pdf | 4 | 3,619 |
| page-sizes.pdf | 3 | 1,436 |
| cjk-embedded.pdf | 1 | 3,126 |
| scan.pdf | 1 | 1,204 |
| encrypted.pdf | 1 | 1,170 |
| corrupt.pdf | Invalid | 65 |
| long-text.pdf | 300 | 841,086 |
| image-heavy.pdf | 12 | 9,446,080 |

Image-heavy has 12 distinct 512x512 RGB image streams, 9,437,184 decoded bytes.
Long text contains 35 synthetic body lines and a unique page marker per page.
These are modest reproducible baseline inputs, not measured performance results
or representative maximum document sizes. All binaries are present, not deferred
to retrieval instructions. Hashes are in the manifest and verified by tests.

Navigation has direct `/Fit` outline targets on physical pages 1, 4 and 2;
nested named `chapter-three` targets page 3, `/FitH` top 740. A destinationless
parent has a child; `does-not-exist` is deliberately unresolved. Page 1 has
three link rectangles: direct page 2 `/XYZ` (40, 700, zoom 1.25), named page 3,
and broken named target. The HTML-like outline title must display literally.
The manifest records the entire expected hierarchy.

Encryption uses public passwords `core02-user` / `core02-owner` and deliberately
wrong `wrong-password`. RC4-128 is legacy compatibility test coverage, not
recommended encryption and not comprehensive AES/permission coverage.

## Commands And Results

Executed from the repository root on WSL2 Ubuntu 24.04.4 x86_64, Python
3.12.3; project Node/pnpm environment from CORE-01. No webview is involved.

```sh
python3 --version
python3 -m pip --version
ls /tmp/opencode
python3 -m venv /tmp/opencode/core02-venv
/tmp/opencode/core02-venv/bin/python -m pip install -r fixtures/requirements.txt
/tmp/opencode/core02-venv/bin/python scripts/generate-fixtures.py
FIXTURE_PYTHON=/tmp/opencode/core02-venv/bin/python pnpm test
/tmp/opencode/core02-venv/bin/python tests/validate-fixtures.py
unshare --user --map-root-user --net env FIXTURE_PYTHON=/tmp/opencode/core02-venv/bin/python pnpm test
unshare --user --map-root-user --net /tmp/opencode/core02-venv/bin/python tests/validate-fixtures.py
```

Setup installed **pypdf 6.1.1** (BSD-3-Clause) and **fonttools 4.59.2** (MIT) in
the external venv; no transitive packages were required. Only pip setup accessed
the network. Final two commands run in a new network namespace with no external
network connectivity and both passed after final regeneration:

- `pnpm test`: **9 passed, 0 failed/skipped** (3 bootstrap, 1 corpus wrapper, 5 concurrent CORE-03 tests).
- Direct Python validation: **7 passed**, including strict parsing of all valid documents and all page content streams, text extraction, outline hierarchy and target resolution, image decompression and dimensions, embedded TrueType glyph tables/Unicode extraction, varying media boxes/rotation, passwords and malformed-input rejection.
- Reproducibility: generated all PDFs and manifest in a temporary directory, compared **every byte** against checked-in files, and removed temporary outputs. Includes deterministic encryption and font timestamps.

An initial generator run failed because pypdf's high-level annotation helper
expects its own destination-builder shape, not an already-constructed PDF array.
Resolved by registering explicit annotation dictionaries using the pinned object
API. No failed/partial outputs remain in the corpus. Direct validator imports no
longer create Python bytecode in the workspace.

Optional-tool probe `command -v pdfinfo pdftoppm pdftotext qpdf powershell.exe`
found only PowerShell; no independent Poppler/qpdf rendering check was available.
Windows probe:

```sh
powershell.exe -NoProfile -Command "Get-Command python,py -ErrorAction SilentlyContinue | Select-Object Name,Source | Format-Table -AutoSize"
```

Resolved only `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`
(app alias), no `py` launcher. No usable Windows Python environment was established
or installed in this task. Windows setup commands are documented, not claimed run.

## Acceptance And Limits

All CORE-02 criteria are met: required categories present, original redistributable
assets with provenance/license, known targets/passwords, actual long/image-heavy
metrics, tests proven without network after setup, construction tools dev-only.
The existing Node test runner was reused rather than adding another JS framework.

No CORE-02 implementation blockers remain. Native Windows remains the primary
reader target, but **Windows Python regeneration, macOS and native Linux runs are
unverified**. Byte identity across other Python/zlib builds is not claimed; pinned
tools and byte comparisons make differences explicit. The small embedded font
covers four Japanese/Chinese shared characters only, not Korean/full CJK or
external CMap/system-font fallback. Basic Latin uses PDF's standard Helvetica.

The validator uses a real PDF parser, not regex validity checks, but pypdf both
constructs and parses the files. Fonttools additionally parses the embedded font.
Neither establishes PDF.js compatibility, visual correctness, full PDF standards
conformance or native reader performance. CORE-04 must independently render these
fixtures in the packaged matching PDF.js worker offline, including CJK and scan,
password success/wrong retry/cancel, and recovery from corrupt input. CORE-05/08
own lifecycle races and navigation behavior. UI cancellation cannot be tested by
the parser. No reader, installer, cross-platform or benchmark gate is closed here.
