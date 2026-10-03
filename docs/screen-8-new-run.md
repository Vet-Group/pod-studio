# Screen 8 "New run" and Recipes

Status: draft for review, updated 2026-10-03 with the worker answers in issue #10
Contract: Worker API `2.0.0-draft.2`, PR #11 head `a2a4c84`
Preview: `design/wireframes/screen-8/index.html` (static wireframe, demo data, no network)

## 1. Why a new screen

Screen 1 (Design library) only has a "Create mockups" box with three fields: scene, product
type and extra instructions. A designer cannot pick a skill, model, aspect ratio, copies,
output size, follow-up steps or quality checks there. The current production queue shows
those choices matter:

| Fact from the current queue | Design consequence |
|---|---|
| 3,722 redesign rows; 3,604 (96.8%) use 1:1 | Default ratio 1:1, but follow the product type |
| Every row downloads at 2K | Default smallest accepted size 2048 px |
| 1 or 2 copies per image | Default 1 copy, stepper up to the contract maximum of 8 |
| 30 prompt templates, about 2,300 characters each, pasted into every row, in 3 groups (POD redesign, embroidery, IP cleanup) | Replace pasted prompts with versioned skills behind a Recipe |
| Ratio follows product type: washed cap 16:9, flag 3:4, mug 1:1 | Product type sets the default ratio |
| 915 of 1,135 pipeline rows (81%) skip background removal | Background removal is off unless the recipe turns it on |
| QC rules live inside prompts (16 of 30 require a white background) and differ from the niche QA in the plan | QC rules belong to each recipe, not one global list |

## 2. Concepts

- **Recipe**: a saved, reusable setup created on Screen 6 (Skills and operations) by an admin or
  skill author. It fixes the skill version, provider, allowed models, redesign intent, default
  follow-up steps, product-type defaults and reviewer checks. Designers choose a recipe; they
  never paste a prompt.
- **Run**: one submission from Screen 8. A run selects inputs and a recipe and adjusts a few
  settings.
- **Job**: what the worker sees. A run creates one `redesign` job per input. Follow-up jobs are
  created by the webapp later. The worker never sees the recipe or the run.

### Recipe fields (webapp only)

| Field | Example | Notes |
|---|---|---|
| `name`, `description` | POD redesign | Shown on the recipe card |
| `skillVersionId` | `pod-redesign` 1.4.0 | Published, immutable skill version; becomes `job.skill` |
| `provider` | `chatgpt` | Fixed per recipe; shown read-only on Screen 8 |
| `allowedModels` | `[]` or `["nano-banana-pro", "imagen-4"]` | Empty list means the account default model only |
| `intent` | `variation`, `restyle`, `cleanup` | Maps to `RedesignParams.intent` |
| `defaultSteps.background` | `false` | Preselects the "Remove background" step |
| `productDefaults` | Mug 1:1, T-shirt 1:1, Washed cap 16:9, Garden flag 3:4 | Default ratio per product type |
| `reviewerChecks` | "White background", "No text or watermark" | Shown on Screen 8 and on the Design review checklist |
| `status` | `draft`, `published`, `archived` | Only published recipes appear on Screen 8 |

Recipes in the preview:

| Recipe | Skill | Provider | Models | Intent | Background step | Reviewer checks |
|---|---|---|---|---|---|---|
| POD redesign | `pod-redesign` 1.4.0 | `chatgpt` | account default | `variation` | off | White background; no text or watermark; subject centered with safe margins |
| Embroidery redesign | `embroidery-redesign` 1.1.0 | `gemini` (Google Flow, browser) | `nano-banana-pro`, `imagen-4` | `restyle` | on | At most 12 thread colors; no gradients or photo textures; lines thick enough to stitch |
| IP cleanup | `ip-safe-cleanup` 2.0.1 | `chatgpt` | account default | `cleanup` | off | No logos, characters or trademarks; keep the original layout; second reviewer for IP risk |

## 3. Screen layout

Desktop first (1280-1440 px): form on the left, sticky "Run summary" on the right. At 1150 px and
below the summary stops being sticky and recipe cards stack. At 760 px and below a sticky bottom
bar keeps the submit button in view. No horizontal overflow at 1024, 760 or 390 px.

Header: "Start a generation run", with a "Job queue" button and the current job count.

| Section | Controls | Default | Rules |
|---|---|---|---|
| 1. Inputs | Pick designs from the store library (multi-select); "Upload files" | none selected | Submit stays disabled until at least one input is selected. Uploads land in temporary storage and join the library first. Selected images are sent with role `design`. |
| 2. Recipe | One card per published recipe: name, description, skill slug and version, provider | first recipe | Changing the recipe resets the model to the account default and applies the recipe's default steps. |
| 3. Output | Product type, aspect ratio (8 contract values), copies per input (stepper), smallest accepted size (1K 1024 / 2K 2048 / 4K 4096 px) | product default ratio, 1 copy, 2K | Copies 1-8. Changing product type moves the ratio to that product's default. The hint states the default, that the worker upscales smaller provider images, and that results still under the chosen size are rejected. All three sizes stay available for every recipe. |
| 4. AI | Provider (read-only, "set by recipe"); model | account default | When the recipe lists models, a select offers "Account default" plus those models. When it does not, the model is shown read-only. |
| 5. Steps | Redesign (always on), Remove background, Mockups, Listing content | from recipe; mockups and listing off | Remove background runs once per result before review, on the worker machine, so it uses no AI account quota. Mockups and listing content start only after approval on Design review. |
| 6. Notes for this run | Niche, extra instructions | empty | Niche up to 64 characters; empty uses each design's own niche. Extra instructions up to 4,000 characters with a live counter. |
| Run summary | Redesign jobs now, expected images, follow-up jobs, submit, quality checks, storage note, payload preview | | Submit label: "Queue N redesign jobs". Payload preview shows the first job exactly as the API would receive it. |

After submit the screen shows a confirmation with the number of queued jobs and a link to the
job queue.

## 4. Contract mapping (draft.2, no new fields)

Screen 8 needs nothing beyond `2.0.0-draft.2`. Recipes, runs, steps, reviewer checks and
storage stay inside the webapp.

| Job field | Source on Screen 8 | Contract rule |
|---|---|---|
| `type` | always `redesign` for the jobs created at submit | `JobType` |
| `provider` | recipe | `Provider` pattern |
| `model` | AI section; omitted for "Account default" | optional `ModelId`; the worker uses exactly this model or fails with `provider_refused` |
| `skill` | recipe skill version | `SkillRef` (immutable published version) |
| `prompt`, `systemPrompt` | rendered by the server from the skill version | required `prompt`; designers never edit it |
| `inputs` | selected designs, role `design` | `AssetRef` with presigned GET URL and `sha256` |
| `params.count` | copies per input | `RedesignParams.count` 1-8 |
| `params.ratio` | aspect ratio | `Ratio` enum, required |
| `params.minLongEdge` | smallest accepted size | 512-8192; `complete` returns `422 validation_failed` when any image is smaller |
| `params.intent` | recipe | `variation`, `restyle`, `cleanup`, `upscale`, `background_remove` |
| `params.niche` | Notes niche, else the design's niche | max 64 characters |
| `params.extraInstructions` | Notes extra instructions | max 4,000 characters |
| `priority`, `timeoutSeconds`, `maxAttempts`, `requiredProviderSkills` | server defaults | not shown on Screen 8; the redesign default for `timeoutSeconds` is 2400, enough for 8 images (issue #10) |

`RedesignParams` has `additionalProperties: false`, so the webapp must send only the keys above.
The preview test validates the generated params for all three recipes against the draft.2
schemas in `packages/contracts/schemas` with Ajv.

Example: two inputs, POD redesign, defaults. This is the first of two jobs (lease and server
fields omitted):

```json
{
  "type": "redesign",
  "provider": "chatgpt",
  "params": {
    "count": 1,
    "ratio": "1:1",
    "minLongEdge": 2048,
    "intent": "variation",
    "niche": "Botanical"
  }
}
```

With the Embroidery recipe and a chosen model, the job adds `"model": "nano-banana-pro"`,
`"provider": "gemini"` and `"intent": "restyle"`.

### Follow-up jobs

| Step | When | Job |
|---|---|---|
| Remove background | after each redesign result, before review | `redesign` with `intent: background_remove`, `count: 1`, same `ratio` and `minLongEdge`, one input with role `source_result`. The worker runs it on its machine (rembg), not with the provider |
| Mockups | after approval on Design review | `mockup` with `MockupParams` (`productType`, `count`, `ratio`, `mode`) |
| Listing content | after approval on Design review | `listing_content` with `ListingContentParams` (`locale`, `niche`, `productType`) |

All three use existing job types, intents and asset roles in draft.2.

## 5. Quality checks

Two tiers:

1. **Automatic, on `complete`**: content type PNG, JPEG or WebP, and long edge at least
   `minLongEdge`. The worker reports the real `width` and `height` of each image after any local
   upscale, and the server checks the reported long edge. Smaller images are rejected with
   `422 validation_failed`; the lease stays valid so the worker can upscale or upload a larger file
   and complete again. Reading the size from the image header on the server is later hardening,
   not part of v1.
2. **Reviewer, on Design review**: the recipe's `reviewerChecks` become the checklist next to each
   result. Screen 8 lists them in the Run summary so the designer knows what will be checked.

## 6. Storage lifecycle

- Results land in temporary object storage (the existing MinIO/R2 bucket, under a temporary prefix).
- Results not approved within 14 days are deleted automatically.
- On approval the reviewer chooses where the image goes: keep it in the store library, export it to
  the NAS, or download a zip.
- The production server cannot reach the LAN NAS, so a small agent inside the LAN pulls approved
  images and writes them to the NAS.

The worker contract does not change for any of this.

## 7. Proposed data model (for the implementing task to confirm)

- `recipes`: `id`, `slug`, `name`, `description`, `skill_version_id`, `provider`,
  `allowed_models` (jsonb), `intent`, `default_steps` (jsonb), `product_defaults` (jsonb),
  `reviewer_checks` (jsonb), `status`, `created_by`, timestamps. Shared across stores, like skills.
- `generation_runs`: `id`, `store_id`, `requester_id`, `recipe_id`, `recipe_snapshot` (jsonb),
  `settings` (jsonb), `created_at`.
- `generation_jobs.run_id`: nullable foreign key to `generation_runs`.
- Result assets: an `expires_at` until approval, cleared on approval (exact shape decided with the
  storage task).

## 8. Task split

- **P1-09** keeps the design library, upload, job creation and queue as planned.
- **New task "New run and Recipes"** (after P1-09): Screen 8, recipe CRUD on Screen 6, the
  `recipes` and `generation_runs` tables, job fan-out and follow-up job creation.
- **New task "Temporary results storage and NAS export"**: 14-day expiry, approval destinations,
  LAN export agent.
- **P1-08** (fake worker) needs no change for Screen 8 beyond the draft.2 fields in PR #11.

## 9. Acceptance

The preview test (`node design/wireframes/screen-8/test-wireframes.mjs`, which validates the job
payloads against `packages/contracts/schemas`) passes 136 of 136 checks once contract draft.2 from
PR #11 is on the branch, including:

- 8 navigation items; Screen 8 renders; submit disabled without inputs
- Two inputs create two redesign jobs; defaults are ratio 1:1, 2K, account default model, 1 copy
- Empty niche falls back to each design's niche; background removal off by default
- Washed cap switches the ratio to 16:9; copies stop at 8; Embroidery offers its models and
  turns background removal on
- Every recipe offers 1K, 2K and 4K; the size hint says the worker upscales smaller images
- Payload uses only contract keys and validates against the draft.2 schemas for all three recipes
- 14-day storage rule shown; sticky queue bar hidden on desktop and visible at 390 px
- No horizontal overflow at 1024, 760 and 390 px; WCAG AA contrast; no text under 11 px; tap
  targets at least 44 px at 390 px; visible focus; no network requests; no JavaScript errors

## 10. Decisions and open questions

### Answered by the worker questions in issue #10

The project owner answered both worker questions on 2026-10-02 (issue #10, "Owner answers to the
worker questions"). The answers are provisional: `ngatruong123` can still change them, and a
breaking change would go into contract draft 3. None of them changes the contract.

1. **Background removal: yes, as specified.** The webapp sends a `redesign` job with
   `intent: background_remove` and the earlier result as a `source_result` input. The worker runs
   it on its own machine (rembg `isnet-general-use`, with a chroma key on solid backgrounds), so it
   uses no AI account quota. It stays off by default because 81% of pipeline rows skip it.
2. **4K: keep it visible for every recipe.** Google Flow offers a 4K download for Nano Banana
   Pro; when that download fails, the worker downloads 2K and upscales x2 on its machine. ChatGPT
   output is assumed to stay under 2048 px (standard sizes 1024x1024, 1536x1024, 1024x1536), so
   the worker always upscales it. The worker reports the real size and the server rejects anything
   below `minLongEdge`. Nothing about ChatGPT has been tested with a live account yet.
3. **Timeout:** a full 8-image redesign job needs `timeoutSeconds` 2400 (2 rounds x 240 s, plus
   8 x 120 s download and 8 x 120 s local upscale). Screen 8 does not show it; the server sets it.

### Still open, for the project owner

4. Is 14 days the right expiry for unapproved results? The preview uses 14 days until this is
   decided.
5. Who can create and publish recipes? Proposed default, following ADR 0003 for skills: holders of
   `skill.edit` draft recipes and only holders of `skill.publish` publish them.
