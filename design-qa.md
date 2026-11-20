# Reading notes card redesign QA — 2026-11-14

final result: passed

## Scope and evidence

Compared the selected composite design side by side with the isolated desktop preview (1440 × 1024) and the Android app-shell preview using a simulated native bridge (390 × 844). See `docs/design/reading-notes/card-redesign/desktop-comparison.png` and `mobile-comparison.png`. Sample note content and count differ from the mock. The desktop preview has an illustrative sidebar; the Android preview preserves the production application shell and navigation. These comparisons pass for the inspected preview scope, not as a claim about an installed device.

## Findings and fixes

- Android navigation did not expose the reading panel. Added the entry and verified navigation, book creation, saving and card display in the isolated app-shell preview.
- The mobile toolbar consumed too much of the initial viewport. Compacted it while retaining book selection, search, chapter, filtering, sorting and the new-note action.
- An inherited Android header rule added padding inside each note card. Removed that extra padding, recaptured and compared the result.
- Unnamed chapters sorted ahead of named chapters. Moved them last and verified with a saved isolated note.
- Excerpt typography was smaller than the design emphasis. Changed it to 20px desktop and 17px mobile, then captured and reviewed both views again.

The desktop reading list, search and side editor were exercised. Mobile chapter grouping, 390 × 844 and 360 × 800 layouts, full-screen editor, returning to a draft and excerpt-only saving were exercised. The real application footer is intentionally retained instead of replacing it with the mock's isolated bottom button. Colors follow existing light/dark theme tokens; the screenshots use light theme. Existing book icons are retained. No mock author is added to real records. Mock and preview contain different sample text and different sidebar detail.

## Validation and remaining risks

Focused tests: 24 passed. Mobile suite: 89 passed, 6 skipped. Desktop and Android Web builds, source audit, Android UI reference check and Kotlin/JVM canonical probe passed. The installed Android device was not modified under the agreed no-install scope; actual Android runtime, software keyboard, safe-area and cross-device v2 sync remain unverified.

Explicit note types write reading-note v2 immediately; older clients cannot read v2 and there is no capability negotiation. Do not deploy or enable writes until all synchronized clients can read v2.

---

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

---

# Reading split view and writing sources — 2026-11-14

final result: passed

## Inspected scope

Implemented the selected third direction: desktop excerpt list beside a reading/editing pane, mobile list/detail/editor, and desktop writing sources. Mobile retains reading-note creation/editing and has no article-creation action. The existing Markdown article editor remains; this change does not introduce the rich-text toolbar shown in the concept.

Browser verification used production ReadingNotesPage and WritingSources components with an isolated temporary SQLite library. The preview article editor exercises the same quote-insertion helper; it is a fixture rather than the complete desktop host. No personal library was used. Screenshots are under `docs/design/reading-notes/split-view/`.

## Visual comparison

Opened and compared each saved reference alongside its latest screenshot: `desktop-reading-comparison.jpg`, `desktop-writing-comparison.jpg`, and `mobile-reading-comparison.jpg`. Original desktop concepts are 1595 × 986; desktop captures are 1656 × 965. Mobile concept is 852 × 1846, compared at the equivalent 390 × 844 viewport. Comparison boards preserve aspect ratios; these are layout/visual reviews, not pixel-diff claims.

- Layout and spacing: desktop uses a narrow independent list and a constrained reading column; mobile uses one view at a time. Reduced excessive mobile reflection spacing. Lists use separators and a single selected background rather than repeated bordered cards.
- Typography: serif excerpt text is distinct from sans-serif reflection and muted metadata. Expanded writing excerpts use 18px/1.8 and reflections 16px/1.8. Mobile excerpt uses 21px. Retained host font fallbacks and theme tokens.
- Colors: inspected dark desktop/mobile and light desktop. Corrected the quote button foreground to dark ink on mint; measured RGB(20,46,39) on RGB(141,221,193).
- Assets: reused the existing product logo and book icon. The isolated preview navigation is intentionally simpler than the real application shell.
- Copy and states: shows actual book/chapter/page data without inventing missing pages. Original text and personal reflections remain distinct. The mobile concept's creation button is replaced by the retained note actions per the user's correction. Reference/sample note counts differ. The desktop reading capture is read mode; inline editing was exercised separately.

## Findings fixed and verified

1. Returning from mobile detail initially restored scroll before the shell had resized. Restoration now waits for layout; browser retest retained page 2 and scrollTop 498 exactly.
2. Mobile more-menu inherited desktop positioning. Corrected its top/bottom rules; the delete action remains inside the 844px viewport (y640–684).
3. Hidden desktop toolbar styles suppressed mobile new/back actions. Restored them and exercised new-note save at 360px width.
4. Navigation could leave selection outside the current page. Selection and paging are synchronized; saved records remain selected, and draft switching uses the existing discard check.
5. Empty record types created a blank filter option and a React key warning. Filtered invalid/empty types and verified the final selector and clean subsequent console log.
6. Source loading and errors could resemble missing records. Added explicit states and request cancellation checks; reflection-only notes remain quotable with personal-reflection attribution.

## Validation

- Browser: note selection, edit/save, new/save, pagination, detail return, scroll restoration, 360/390/412px layouts, long text, more menu, source search/expansion, association without changing article text, citation insertion at the saved cursor, and removing association without removing inserted text.
- Focused reading/navigation/mobile adapter/sync and writing-source test files pass. Full suite initially passed 49/53 files; the four environment-dependent files passed when rerun outside the sandbox (network/process restrictions caused the initial failures). The latest focused five-file rerun passes.
- Final desktop plugin build, Android Web build, source audit (532 files), and `git diff --check` pass.
- Temporary browser viewport override reset. Local preview: `node scripts/preview-reading-workspace.mjs`, port 4183, temporary sample library.

## Boundaries

No installed Electron or physical Android regression is claimed. Native keyboard/safe-area behavior and real cross-device synchronization remain device checks. No installer was packaged or installed, and no release was published. Existing unrelated workspace edits are preserved. The older sections above describe prior work and are not delivery claims for this change.

## Packaging follow-up — 2026-11-14

At the user's subsequent request, built Linux 0.1.22 (`release/linux/shiwen-dsh_0.1.22_amd64.deb`) and signed Android 0.1.32 / versionCode 35 (`release/android/shiwen-android-0.1.32.apk`). Version numbers exceed the previous local delivery (Linux 0.1.21, Android 0.1.31 / 34); installed Linux was 0.1.21 and no Android device was connected.

Both packaging commands passed. Android UI-reference check and release lint/build passed; the release JVM test task was up-to-date. Verified DEB/APK embedded versions, both SHA-256 files, APK signature matching the previous release, and the reading/writing UI resources inside the packages. Standard artifact collection retained only the new successful package and checksum in each platform release directory. No installation, Git tag, commit, remote upload, or GitHub Release was performed.

---

# Reading measure correction — 2026-11-14

final result: passed

The user supplied a desktop long-form record screenshot and connected an Android phone running 0.1.32. The phone's material detail screen confirmed the 16px shell gutter. Desktop body content previously filled the detail pane without a maximum reading width, especially when the list was collapsed.

Added read-mode classes to the desktop and mobile record views. Desktop read content is limited to 760px and centered within the detail pane, including title, metadata and actions; it keeps 24–56px minimum pane padding and balanced scrollbar gutters. Mobile record content adds 8px to the existing 16px shell inset, for 24px reading gutters. Mobile reading-note details receive the same extra inset. Editors and chat typography are outside this correction. Paragraph spacing is 1.25em and line-height 1.95 in record reading views.

Browser comparison: `docs/design/reading-notes/reading-measure/desktop-comparison.jpg`, original-sized before/after and expanded-list screenshots in the same directory. This is an isolated CSS fixture with production styles and matching record markup, not a full desktop-host interaction test. At 1503 × 1080, collapsed-list body width is 760px and x=371.5px; title and body align. Expanded-list layout also retains a centered 760px column. At 390px and 360px, mobile body starts at 24px and has no horizontal overflow; the desktop browser's non-overlay vertical scrollbar accounts for an additional 15px on the right. Typeface, theme tokens, existing assets and record copy remain unchanged. Viewed the before/after comparison and mobile screenshot before passing this scoped visual check.

Built Linux 0.1.23 and Android 0.1.33 / versionCode 36. UI reference check, release lint/build, source audit and diff whitespace check pass; unchanged release JVM tests were up-to-date. Both checksum files, package versions, APK signature continuity and mobile packaged gutter styles were verified. Install-time phone verification is pending explicit approval after automatic review rejected the attempted update for lack of installation authorization; the phone has not yet been changed by this correction.

## Physical Android follow-up

The user subsequently explicitly approved the update. Installed 0.1.33 with `adb install -r` successfully, confirmed versionCode 36, and opened the existing materials library and a long-form record. No uninstall or data-clear operation was used. Inspected the title, metadata, links, blockquote and scrolling body on the connected phone: added side gutters are visible, text wraps within the reading area, and existing content remains accessible. The connection indicator returned online during inspection; this is not a full sync regression test. Private-content device screenshots are retained only in `/tmp/shiwen-phone-reading-after.png` and `/tmp/shiwen-phone-reading-after-body.png`, outside the repository. Linux 0.1.23 remains packaged but was not installed in this follow-up.

---

# Desktop record and editor simplification — 2026-11-18

Scope: desktop materials/records only. This section describes this change; older entries above are historical. The existing library storage/search implementations, Android application and article-writing layout were not redesigned.

## Visual target and evidence

- Selected source designs: `docs/design/record-editor/source-reading.png` and `source-editing.png`.
- Browser implementation: an isolated local desktop-host service, seeded with fictional records. No personal library was opened or modified.
- Target and final full-size screenshots: 1488 × 1056 pixels, browser viewport 1488 × 1056 CSS px, density 1; no resampling. Source and implementation images were emitted together in each comparison input.
- First pass: `reading-first-pass.png`, `editing-first-pass.png` in the same evidence directory.
- Final reading/editing: `reading-final.png`, `editing-final.png`. Responsive evidence: `editing-800.png` and `editing-1024.png`.
- Full-view and focused checks: the images were legible at native size; the title/metadata/body, top action bar, search/filter rows and bottom editing controls were individually inspected. DOM geometry additionally verified stable list boundary and title alignment. Separate cropped image files were unnecessary for these text-only screens.

## Findings and iterations

1. First comparison was blocked: [P1] entering edit mode changed the list width and displaced the toolbar; [P2] title/body scale was too small, metadata disappeared in edit mode, search controls occupied too many rows, and the old textarea resize styling remained. Fixed desktop selector precedence, shared canvas width, typography, metadata and compact search/filter rows.
2. Second comparison was blocked: [P2] inherited edit padding still shifted the workspace, heading hierarchy was too weak, and collapsed-list actions covered the record type. Fixed the remaining specificity conflict, heading sizes and collapsed toolbar clearance. Implemented the displayed Ctrl/Cmd+S shortcut rather than displaying an inert hint.
3. Final responsive review found [P2] the materials heading wrapped at 800px and an invisible refresh button remained keyboard-focusable. Fixed narrow header spacing and moved refresh into the visible list menu. Reading/editing title vertical spacing was aligned.

## Required fidelity surfaces

- Typography: existing system Chinese font stack retained; title 38px, body 21px, section headings 28px, metadata 16px. Read/edit hierarchy and wrapping are consistent. The source's slightly larger generated typography is adapted to the real host and 820px readable canvas.
- Spacing/layout: flat list and continuous document canvas; stable columns between reading and editing; secondary information appears on demand; save/cancel and image insertion remain reachable. Checked 1488, 1024 and 800px desktop widths; automated 1320 and 390px fixtures cover responsive behavior.
- Colors/tokens: existing dark theme, mint primary/selection colors and semantic tokens retained. No new independent palette or decorative backgrounds.
- Assets: existing host logo/navigation assets retained. This is a text-focused workspace; no illustrations or placeholder image substitutes were introduced. The existing host rail remains 56px rather than reproducing the generated 78px rail.
- Copy: new record, information, save/cancel and draft states are concise. Draft retained/recovered is distinct from a successful explicit save. Existing records retain their fixed type; new records allow type selection. Date formatting remains the app's ISO format. The source's decorative icons beside text are not needed to understand the actual labeled controls.

## Functional verification

- Real isolated host, through browser UI: reading, editing, information expansion, more menu, collapse/expand list, exact search and result navigation; typing → draft retained → leave for Review → return → last sentence restored → Ctrl+S → persisted reading state.
- Automated regressions: continuous typing debounce, final-character pagehide flush, unmount/remount restoration, delayed restore/navigation protection, delayed save/navigation protection, late record read versus new draft, save/cancel preventing draft resurrection, failed saves retaining text, successful save followed by failed read avoiding resubmission, failed remote cleanup retaining a local versioned clear marker, and shortcut save.
- Existing mobile record editor and search/service/library/writing-source tests included in the focused acceptance run.
- Console checks: no application errors in the inspected flow. Connection retry warnings occurred while deliberately restarting the disposable preview server between builds.

## Boundaries and follow-up

This is source-level delivery plus isolated browser verification. No installer was produced, no installed client was replaced, no release or commit was created. Physical-device IME, process termination mid-request, disk-full/localStorage plus server failures, and concurrent independent clients are not claimed as fully verified. Server revision checks and the existing image-save request identifiers remain in use; this change does not promise to eliminate every multi-client race.

Implementation checklist: preserve the approved calm canvas; keep secondary information accessible; guard save/restore transitions; retain local draft clear revisions; expose recovery errors and retry; validate related tests and source audit; retain screenshot evidence.

Final interaction-state comparison also caught the inherited bright rectangular focus outline around the entire editor. The desktop document inputs now use a subtle bottom focus indicator and visible caret; other controls keep their keyboard focus treatment. This was checked with the textarea focused, not only in a blurred screenshot.

Recovery review additionally found that a failed draft load could leave navigation disabled without a way to retry. The final implementation exposes retry even when a normal list refresh clears the generic error message; retries re-read the draft and only then enable navigation. Tests cover the failed-load → list-refresh → retry → restored-content sequence.

Expected content difference: the final reading screenshot contains the sentence added during the save/recovery exercise, while the initial reading mock does not. The editing source and final editor include that same sentence. The test library contains three items rather than the mock's four; source ordering was not hardcoded.

Final focused acceptance: 28 tests passed, 0 failed, 0 skipped across the draft, desktop editor, mobile editor, content-search UI, library, search service and writing-source test files. The final plugin build and whitespace check passed. All P1/P2 issues listed above were fixed and re-inspected; remaining differences are the documented host, data and density adaptations. No additional P0/P1/P2 findings remain in the inspected scope.

final result: passed

## Linux packaging follow-up — 2026-11-18

At the user's request, built Linux desktop 0.1.28 with the repository packaging script. The prior installed version and local Linux release were both 0.1.27. Root package/lock versions are now 0.1.28; Android and the independently versioned plugin bundle were not bumped.

Artifact: `release/linux/shiwen-dsh_0.1.28_amd64.deb`, with its adjacent SHA-256 file. The build validates the embedded DEB version, filename, desktop runtime and packaged search dependencies before replacing the previous local Linux release. SHA-256 verification, source audit and whitespace checks passed. Temporary package staging was cleaned by the standard artifact workflow. No installation, Git commit, tag, upload or remote release was performed.

Streamed the final DEB to inspect the embedded `app.asar` manifest (0.1.28) and compiled workbench client. Confirmed the desktop workspace, draft-load retry, restore attempt state and versioned local draft-clear marker are present. This verifies package contents, not an installed-client launch.

---

## Desktop typography correction — 2026-11-18

The user approved a smaller scale after inspecting 0.1.28: title 28px, body 17px with 1.8 line height, section headings 22px, metadata 13px and list titles 15px. This explicit correction supersedes the larger typography in the original generated targets. Only the desktop material CSS changed; save/draft JavaScript and mobile styles are unchanged. Desktop package versions and changelog advance to 0.1.29.

Source evidence: `docs/design/record-editor/reading-final.png` and `editing-final.png`, combined with the approved new numeric typography specification. Revised browser evidence: `reading-compact.png`, `editing-compact.png` and `editing-compact-800.png` in the same directory. Each prior/final pair was emitted together for comparison at 1488 × 1056 CSS/pixel dimensions, density 1, with the same sample document and dark theme. A second viewport was 800 × 700. No resizing or density normalization was required. Native-size text and controls were clearly readable, so additional cropped regions were unnecessary.

Computed browser styles confirmed 28px titles, 17px body with 30.6px line height, 22px headings, 13px metadata and 15px list titles. Reading/editing title bounds start at y=125/124 respectively; both remain aligned at x=530 at the full viewport. The upper document gap is 40px smaller, metadata and paragraph spacing are tighter, and keyboard focus remains a subtle underline. Fonts, colors, host assets, content and all other layout regions retain the existing design. There were no actionable visual findings after the correction. Draft status differs between the reference and revised capture because the revised document had just been saved.

The existing draft-autosave and material-editor browser suites passed: 5 tests, no failures/skips, including 1320px/390px responsive editor fixtures. Real isolated-host UI confirmed restore, Ctrl+S save, reading/editing switching and reachable controls at 800px. Browser console errors: none. No personal library was accessed and no installed-client/physical-device verification is claimed.

final result: passed

Linux 0.1.29 was built into `release/linux/shiwen-dsh_0.1.29_amd64.deb` after verifying installed/source/local-release versions were 0.1.28. DEB metadata, embedded app manifest, packaged typography rules and SHA-256 were checked. The build replaced only the local Linux release artifacts. No installation or remote publication was performed.
