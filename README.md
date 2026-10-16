# HTML to PDF Studio

A local Electron desktop tool for converting HTML files to PDFs and adjusting print layout before export.

## Start the app

From this directory:

```sh
npm install
npm start
```

After dependencies are installed once, you can also double-click **Start HTML to PDF Studio.command** in Finder. To open a file immediately from Terminal, use `npm start -- --open "/path/to/Resume.html"`.

Choose an HTML file with **Browse**, paste a path and press **Load**, or drag an HTML file into the app. The PDF preview refreshes as settings change. Use **Export PDF** to save the final document.

## Formatting controls

- Use the HTML document's own `@page` and print styles, or override page size, orientation, and page margins.
- Choose detected sections or enter a CSS selector, then set per-section margins, padding, font scale, text and background colors, line height, page breaks, and keep-together behavior.
- Section and page changes save automatically and regenerate the PDF preview. Export waits for any pending edit to finish rendering.
- Use section presets for tighter spacing, smaller text, or added space above a section.
- Switch between light and dark app themes; choose colors with a picker or enter any supported CSS color.
- Adjustment cards summarize active spacing, typography, color, and page-break rules. Invalid values and selectors are highlighted inline.
- Undo and redo section/page edits with `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` (`Cmd/Ctrl+Y` also redoes). Open a file with `Cmd/Ctrl+O` and export with `Cmd/Ctrl+E`.
- PDF export suggests a filename based on the HTML file, remembers the last output folder, and confirms before replacing an existing PDF.
- Use the custom File, Edit, View, and Help menus for document actions, adjustment history, themes, and a shortcut reference.
- On macOS, use the custom window controls in the app bar to close, minimize, or enter full screen.
- The macOS app bundle uses the custom PDF Studio document icon.
- Add advanced CSS overrides for other print-specific fixes.
- Settings are saved locally per source file. The source HTML is never rewritten.

## Command line

Convert beside the input file:

```sh
npm run convert -- "/path/to/Resume.html"
```

Choose an output path:

```sh
npm run convert -- "/path/to/Resume.html" --output "/path/to/Resume.pdf"
```

The CLI reuses formatting settings saved by the desktop app for that HTML file.

## macOS app bundle

The Apple Silicon app bundle is at `release/mac-arm64/HTML to PDF Studio.app`. Rebuild it from this folder with:

```sh
npm run package:mac
```

## Technology

- Electron provides the desktop window, native file dialogs, and Chromium rendering.
- The app previews the generated PDF itself, so the preview shows the same page breaks and layout that will be exported.
- All conversion runs locally on the Mac. The selected HTML and generated PDF are not uploaded.

The desktop UI uses Electron's bundled Chromium; it does not depend on the separate Google Chrome installation. The `.command` launcher starts the local app from this folder.
