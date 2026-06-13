# Instructions for the AI Agent: Ecommerce Image Processing Workflow

## Context
You are an automated agent that documents, categorizes and converts ecommerce
stock images. Raw source images live in `images-source/`. Use the
`scripts/manage-store-images.ts` script for all file-system and markdown work —
never edit files or convert images by hand.

For each source image you: read it with vision, decide its category and
metadata, then run one script command that converts it to `docs/images/<category>/<id>.avif`
(numeric id from `counter.txt`), records its row in that folder's `IMAGES_LIST.md`
**and a Spanish row in that folder's `IMAGES_LIST.ES.md`** (Name, Description and
Elements translated to Spanish), and renames the source to `<id>--<name>` so it is
skipped next time.

## Workflow Loop — 3 steps, repeated

### Step 1: Find the next source image
```bash
bun scripts/manage-store-images.ts --next
```
Prints one source filename, e.g. `store-scanner-for-checkout.jpg`.
*If it prints "No images left.", the task is complete — stop.*

### Step 2: Analyze the image with vision
Read `images-source/<FILENAME>` (the exact name from Step 1) with your vision
capabilities — source JPG/PNG/WebP files are read directly. Determine:
- **Description**: SEO-optimized product description.
- **Elements**: Objects, products, or people in the image.
- **Description (Spanish)**: the `--desc` description translated to Spanish, for `--desc-es`.
- **Elements (Spanish)**: the `--elements` list translated to Spanish, for `--elements-es`.
- **Dominant Colors**: Primary subject colors.
- **Background**: a single phrase combining **type** + **color**, where type is
  one of `solid`, `clean`, `texture`, or `complex` — e.g. `clean - white`,
  `complex - retail interior`. This whole phrase is the `--bg` value.
- **Aspect Ratio**: `W:H` with a colon, e.g. `1:1`, `4:5`, `3:2`, `16:9`.
- **Lighting**: `dark`, `light`, or `neutral`.
- **Category**: pick exactly ONE folder by primary subject/use. See
  `docs/images/CATEGORIES.md`, or list folders with:
  ```bash
  bun scripts/manage-store-images.ts --cats
  ```

### Step 3: Convert, file and document
One command converts the source to `<id>.avif` inside the chosen category,
writes its metadata row to `IMAGES_LIST.md`, writes the translated
Name/Description/Elements row to `IMAGES_LIST.ES.md`, and marks the source as
processed:
```bash
bun scripts/manage-store-images.ts --process \
  --source "store-scanner-for-checkout.jpg" \
  --category "[CATEGORY_FOLDER]" \
  --desc "[DESCRIPTION]" \
  --elements "[ELEMENTS]" \
  --colors "[COLORS]" \
  --bg "[BACKGROUND_TYPE_AND_COLOR]" \
  --ratio "[RATIO]" \
  --lighting "[LIGHTING]" \
  --desc-es "[DESCRIPTION_IN_SPANISH]" \
  --elements-es "[ELEMENTS_IN_SPANISH]"
```
Pass the exact filename from Step 1 as `--source`. Then go back to **Step 1**
and continue until `--next` reports "No images left."

## Constraints
- `--category` must be one of the existing folders (run `--cats` to confirm).
- Pick the single best-fitting category; do not duplicate images across folders.
- Keep descriptions professional and suitable for ecommerce.
- Never rename images or edit any `IMAGES_LIST.md` / `IMAGES_LIST.ES.md` by hand — always use the script.
- Always pass both `--desc-es` and `--elements-es` so the Spanish list stays in sync with the English one.
- The output `.avif` is named by its numeric id, which is also its **Name** in the list.
