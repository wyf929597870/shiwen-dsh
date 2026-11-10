# Reading notes style alignment QA — 2026-11-10

Result: passed for the inspected desktop and Android web views.

## Current target

The user requested consistency with the existing application. The existing Materials/Review pages and Android record editor now take precedence for typography, theme and spacing. The third selected design remains the layout reference only. The preceding mock-focused assessment is preserved in `docs/design/reading-notes/mock-fidelity-qa.md`; its oversized typography recommendation is superseded here.

## Evidence

Screenshots are in `docs/design/reading-notes/style-alignment/`:

- Desktop reference: `desktop-materials.jpg`, `desktop-review.jpg`; before: `desktop-before.jpg`.
- Desktop corrected: `desktop-after-light.png`, `desktop-after-dark.png`, 1440 × 1000.
- Android reference: `mobile-editor.jpg`; before: `mobile-before.jpg`.
- Android corrected: `mobile-after-light.png`, `mobile-after-dark.png`, 390 × 844.
- Reference and corrected screenshots were viewed together. Desktop uses the real DSH host, theme and production plugin components with an isolated temporary library. Android uses the actual application shell with the development bridge.

## Findings and correction

1. P2 — Independent desktop typography was visibly larger than existing pages: title 36px vs 28px, reflection 21px vs 16px. Corrected title to 28px and reflection to 16px/1.9; inherited the host font family. Reduced section headings and metadata accordingly.
2. P2 — Desktop padding and colors diverged from the app. Reused 28px vertical and responsive horizontal page padding, host theme tokens, field surfaces and primary foreground. Removed the decorative section marker. Corrected the calendar/book icon theme handling.
3. P2 — Android inherited desktop editor styling and added inner padding on top of shell padding. Removed the duplicate inset; reused the native editor's 13px monospace text, label size, field corners and primary button shape/colors. Reading input retains a comfortable 1.9 line-height.
4. P2 — Light theme controls and icons lacked consistency/contrast. Corrected light and dark theme foregrounds and inspected both modes on both platforms.

## Verification and boundaries

- Measured desktop result: title 28px, reflection 16px, page padding 28px 30.24px at 1440px, white light-theme fields and white primary-button text.
- Measured Android result: reflection 13px, labels 13px, primary button 16px with 24px corner radius; no duplicated page padding. Document width equals viewport width (390px), with no horizontal overflow.
- Plugin build, Android preview build and UI reference check passed. Desktop console error log was empty during the inspected flow.
- Functional save/excerpt/statistics verification from the preceding implementation remains recorded in the archived report. This correction changes CSS only; no library records or classification data were modified.
- This is browser verification of the desktop host and Android web UI, not a physical-phone or installed-Electron regression claim.
- Temporary desktop viewport override was reset after capture.

## Delivery validation

- Linux 0.1.14 DEB and signed Android 0.1.8 APK rebuilt successfully in their fixed `release/<platform>/` directories. Prior package copies were replaced only after successful builds.
- Release JVM test task and release lint/build completed; Java/Kotlin test outputs were up-to-date for this CSS-only correction. APK signature verification and both package SHA-256 checks passed.
- Confirmed Android corrected styles inside the delivered APK and removed duplicate build outputs/staging.

## Follow-up: clipped book selector text

The user reported Chinese glyphs clipped in the desktop book selector. Computed CSS confirmed a 42px border-box height with 12px top/bottom padding, leaving only 16px of text space. The shared reading-note CSS now gives the book/date controls 44px height with 8px vertical padding (26px inner space). Browser inspection confirmed the updated dimensions and complete Chinese placeholder/selected title in light and dark desktop themes. Screenshots: `docs/design/reading-notes/select-fix/light.png`, `dark.png`, `selected.png`. The last shows a temporary unsaved book selection in an isolated test library, not a saved user record.
