# Screen 8 "New run" (proposal)

A copy of the main wireframe with one extra screen, New run, placed second in the navigation. The
other seven screens are unchanged. Spec: `docs/screen-8-new-run.md`.

This stays a separate copy until the plan adopts Screen 8. At that point it replaces
`design/wireframes/index.html`, and the navigation in `apps/web/src/lib/screens.ts` and
`tasks/validate-tasks.mjs` move to eight screens in the same change.

## Open

Open `index.html` directly in a browser. It runs offline with demo data and makes no network calls.

## Tests

```bash
node design/wireframes/screen-8/test-wireframes.mjs
```

Same runner as the main wireframe (Chromium over CDP, `CHROME_PATH` to override). On top of the
main checks, it covers Screen 8: recipe defaults, product-type ratio, copies limit, sizes, follow-up
steps, the 14-day storage rule, the sticky queue bar on phones, and the job payload validated with
Ajv against `packages/contracts/schemas`. That payload check needs Worker API `2.0.0-draft.2`
(PR #11). Against draft.1 it fails because `model` and the redesign fields do not exist yet. Set
`CONTRACTS_DIR` to validate against another `packages/contracts` checkout.

Screenshots of Screen 8 go to `screenshots/` here; `SCREENSHOTS=0` skips them.
