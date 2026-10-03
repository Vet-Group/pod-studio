# POD Studio wireframe (7 screens)

An interactive prototype for reviewing UX before coding. All data is DEMO data; it makes no network calls and does not connect to real systems.
All on-screen copy is English, matching the web app.

## Open

Open `index.html` directly in a browser (runs offline, with CSS/JS/SVG embedded in the file).

## Contents

| Screen | Main contents | Task |
| --- | --- | --- |
| 1 Studio: Design library | Store-scoped design library, upload drawer, mockup creation drawer, queue | P1-05, P1-09, P1-11 |
| 2 Review: Design review | Original design beside its mockup, A to approve, R to reject (with a reason), arrow keys to switch images | P1-10 |
| 3 Listing: Listing content | Product analysis tab, content editor, listing preview | P2-01, P2-02 |
| 4 Products: Products & push | Variant table, mandatory dry run, draft push, separate permission check for publishing | P2-03 to P2-10 |
| 5 Team: Stores & members | Store selection, owner and granted permissions, push/publish toggles, member invites | P1-03, P1-04, P2-05 |
| 6 Skills: Skills & operations | Versioned skills, AI accounts (running, resting, session expired), workers | P3-01 to P3-04, P3-11 |
| 7 Niche: Niche data | 5-step niche master data editor, all 17 sections of schema 2.0, minimum count for each field, exactly 4 style variants, scoring on 6 market criteria, validator with a Fix button, builds do not automatically publish | P3-09, P3-10 |

Three themes: 01 Creative (light), 02 Operations (information-dense), 03 Darkroom (dark, for design review).

Screen 8 (New run) is a separate proposal in `screen-8/`, spec in `docs/screen-8-new-run.md`.

## Tests

```bash
node design/wireframes/test-wireframes.mjs
```

Requires Chrome/Chromium; set its path with the `CHROME_PATH` variable (defaults to Playwright's Chromium on this machine). The script uses CDP directly and requires no package installation. Checks: navigation across 7 screens, focus and Esc returning focus to the opening button, A/R/arrow keys, permission matrix, minimum-count rules, validator errors, scoring and builds on screen 7, no horizontal overflow or clipped navigation labels at 1024/760/390 across all 7 screens, a UI quality floor across 7 screens × 4 widths × 3 visual directions (text meets WCAG AA contrast, no text below 11px, buttons and selection controls at least 32px and 44px at 390px, toasts do not cover sticky action bars), screenshots saved to `screenshots/`.

Most recent run: 109/109 passed.

## Limitations

- This is a wireframe, not the final design system. Color and typography tokens will move to `packages/ui` in P3-08.
- Figures, times, store names and accounts are fake data.
