# Reading notes design QA — 2026-11-10

final result: passed

## Target and evidence

- Selected direction: third generated design, focused editor with optional collapsed excerpts and same-book history.
- Source: the selected image-generation mockup (local design reference, not distributed) (1487 × 1058).
- Implementation: `http://127.0.0.1:4179/`, production ReadingNotesPage and ReviewPage with an isolated temporary SQLite library.
- Desktop evidence: `docs/design/reading-notes/desktop-final.jpg`, CSS viewport and captured pixels 1487 × 1058, effective screenshot scale 1. Both source and implementation were opened together in one comparison input.
- Responsive evidence: `docs/design/reading-notes/mobile-final.jpg` and `android-final.jpg`, 390 × 844. The latter uses the Android app shell with a development-only bridge, not a physical device.
- State difference: final desktop evidence is editing the saved sample, showing its actual 209-character count, a chapter, and three saved history rows. The image's illustrative count of 126 is intentionally not copied.

## Findings and fixes

1. P2, initial metadata row: chapter/page labels wrapped vertically. Added nowrap and constrained responsive columns. Final labels are horizontal and controls remain within the viewport.
2. P2, initial editor: typography was too small relative to the selected image. Increased desktop heading/editor type and adjusted line height; final sample fits the editor without an unnecessary scrollbar.
3. P2, Android: repeated page heading and overly wide book button reduced useful writing space. Removed the duplicate heading inside the native shell and constrained the button column.
4. P2, light theme: mint outline/text had insufficient contrast. Used dark green for light-theme accents and white text on primary buttons.

Post-fix desktop comparison and Android capture show no remaining P0/P1/P2 issues. All changes above were recaptured before handoff.

## Fidelity surfaces

- Typography: system/CJK fallback, clear title/section/body hierarchy, 21px desktop writing area and 16px narrow-screen input. Native platform rendering is retained; smaller metadata/history text follows the existing app's density.
- Spacing/layout: one focused column, book/date/context controls, large reflection area, collapsed excerpts, restrained save row and compact history. Source-like 54px desktop content inset; narrow layouts stack controls without horizontal overflow.
- Colors: charcoal base, muted secondary copy, mint business accent; existing light mode remains supported with stronger accent contrast. Decorative image texture was not added to functional controls.
- Assets: existing Shiwen logo and official MIT-licensed Tabler book icon. No custom-drawn asset substitutes. The isolated preview's surrounding navigation is illustrative; production retains the existing host navigation.
- Copy/content: optional excerpts explicitly excluded from reflection counts; real save/edit/recovery states replace static mock copy. Native date display and full ISO history dates are intentional for unambiguous dating.
- Full-size comparison made the editor, metadata, disclosure and history text legible; no additional region crop was necessary.

## Functional verification

- New book, multi-excerpt entry with independent page fields, save, edit, history expansion and draft restoration checked through the browser.
- Adding two excerpts left the sample reflection at 209 characters. Saving and editing retained one note; Review's selected-day reading-note total remained 209.
- Mobile adapter reads full records after paginated summaries, preserving excerpts and source segments. Stable retry identity, stale revision rejection, independent note dates and portable metadata are covered by Node tests.
- 71 focused store/review/sync/contract tests passed; four reading-note tests reran successfully after the native summary/full-record fix.
- No real library was opened or changed by these preview tests. Physical-device upgrade/synchronization testing is not claimed for this build.

## Implementation checklist

- [x] Selected layout implemented in desktop and Android entry points.
- [x] Optional excerpts stored separately from reflection text.
- [x] Existing Review totals reused without double counting.
- [x] Historical mixed records left untouched.
- [x] Keyboard focus styling, input labels, narrow layout and light theme checked.
- [x] Preview left available; temporary viewport override reset.
