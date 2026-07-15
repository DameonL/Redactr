# Redactr

A free, browser-based PDF redaction tool. Everything runs client-side — documents are never uploaded to a server — and redaction is *true* redaction: the selected text is removed from the PDF content stream itself, not just covered with a black box.

## Features

- **Text-selection redaction** — select text directly on the page (like in any PDF viewer) and it is marked for redaction character-by-character, using the document's real font metrics for exact placement.
- **Rectangle redaction** — drag a box over any region; overlapping text is removed and overlapping images are blacked out at the pixel level.
- **Auto-redact search** — type a term (e.g. a name or email) to find and mark every occurrence across the document. Wrap the query in slashes (`/\d{3}-\d{2}-\d{4}/`) to search by regular expression.
- **Redaction templates** — save reusable patterns (plain text or regex, single page or whole document), and import/export them as JSON.
- **Preview before committing** — pending redactions are outlined in red; Preview Redactions shows the actual redacted output, which you can confirm or cancel.
- **True content removal** — text-showing operators are rewritten so redacted glyphs are gone from the file, with the remaining text kept in its exact original position. Form XObjects are processed recursively and images intersecting a redaction are blacked out.
- **Optional rasterization** — the Rasterize toggle exports pages as flat images instead of vector content, for an extra guarantee that no text survives.
- **Offline capable** — installs as a PWA; after the first visit it works without a network connection.
- Light/dark theme, zoom, page navigation, pan mode, and undo.

## Getting started

Prerequisites: [Node.js](https://nodejs.org) 20.19+ (or 22.12+) and npm.

```bash
git clone <this repository>
cd Redactr
npm install
npm run dev
```

### Other scripts

| Command | Description |
| --- | --- |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Build and serve the production bundle locally |
| `npm test` | Run the regression test suite (vitest) |

## Usage

1. **Open a document** — click *Select File* and choose a PDF. The file is read locally in your browser.
2. **Mark redactions** (in Redact mode, the default):
   - *Select text* with the cursor to redact exactly those characters, or
   - *Drag a rectangle* over any area, or
   - Use the *search bar* to auto-redact every match of a term or `/regex/`, or
   - Open *Redaction Templates* to apply saved patterns.

   Pending redactions appear as red outlines. Use *Undo* (Ctrl/⌘+Z) to remove the last one, or *Reset* to clear everything.
3. **Preview** — click *Preview Redactions* to see the document with the redactions actually applied, then *Confirm Redaction* or *Cancel*.
4. **Export** — click *Export* to download the redacted PDF. Enable *Rasterize* first if you want the output flattened to images.

## How redaction works

Redactr parses each page's content stream and rewrites the text-showing operators (`Tj`, `TJ`, `'`, `"`). Glyphs whose bounding boxes intersect a redaction rectangle are deleted and replaced with kerning adjustments that reproduce their exact advance width, so the surviving text does not shift. Images that intersect a redaction are decoded, painted over, and re-embedded. Because the content is removed rather than hidden, the redacted text cannot be recovered from the output file.

Key modules:

- `src/pdfStreamRedactor.ts` — content-stream orchestrator (decode, operator dispatch, re-encode)
- `src/redaction/graphicsState.ts` — graphics/text state tracking (one reducer for all state operators)
- `src/redaction/textShowRedactor.ts` — glyph hit-testing and rewriting of text-showing operators
- `src/pdfFontHandler.ts` — font metrics from `/Widths`, CID `/W` arrays, embedded fonts (fontkit), or built-in AFM tables
- `src/components/TextSelectionLayer.tsx` — maps on-screen text selection to PDF-space rectangles

## Testing

`npm test` runs a regression suite that builds PDFs exercising character/word spacing, horizontal scaling, the `'`/`"` operators, and font-metric edge cases, redacts them, and replays the output through an independent interpreter of the PDF spec to assert that every surviving glyph keeps its exact position and no redacted text survives.

## Tech stack

[Preact](https://preactjs.com/) + [Vite](https://vite.dev/), [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, [pdf-lib](https://pdf-lib.js.org/) for document manipulation, [fontkit](https://github.com/foliojs/fontkit) and AFM metrics for font handling, and [pako](https://github.com/nodeca/pako) for stream compression.

## License

MIT — see [LICENSE](LICENSE).
