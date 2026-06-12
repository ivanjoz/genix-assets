import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// Raw source images. Already-processed ones are prefixed "<id>--".
const SOURCE_DIR = path.resolve(process.cwd(), 'images-source');
// Category folders live under here; counter.txt holds the last-used id.
const IMAGES_DIR = path.resolve(process.cwd(), 'docs/images');
const COUNTER_FILE = path.join(IMAGES_DIR, 'counter.txt');

const LIST_HEADER =
  '# Ecommerce Images List\n\n| Name | Description | Elements | Dominant Colors | Background | Aspect Ratio | Lighting |\n|------|-------------|----------|-----------------|------------|--------------|----------|\n';

// Conversion settings (AVIF via avifenc, resize via ImageMagick).
const MAX_PIXELS = 1400000; // 1.4 Megapixels
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
// Small variant ("<id>.s.avif"): ~0.12 MP thumbnail.
const SMALL_MAX_PIXELS = 120000; // 0.12 Megapixels
const SMALL_MAX_FILE_SIZE = 40 * 1024; // 40 KB
const INITIAL_QUALITY = 80;
const SMALL_INITIAL_QUALITY = 75; // starting quality for small thumbnails
const MIN_QUALITY = 65; // Quality floor
const SPEED = 2; // avifenc speed 0..10 (0 = slowest, best compression)

const SOURCE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
// A source already processed in a previous pass.
const PROCESSED_RE = /^\d+--/;

/** Folder names that are NOT image categories. */
const RESERVED = new Set(['_inbox']);

function checkBinary(cmd: string): boolean {
  try {
    return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

function readCounter(): number {
  if (!fs.existsSync(COUNTER_FILE)) return 0;
  const n = parseInt(fs.readFileSync(COUNTER_FILE, 'utf-8').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function writeCounter(n: number) {
  fs.writeFileSync(COUNTER_FILE, String(n) + '\n');
}

/** Returns the list of valid category folders (every dir under IMAGES_DIR). */
function getCategories(): string[] {
  return fs
    .readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !RESERVED.has(d.name))
    .map(d => d.name)
    .sort();
}

function listFileFor(category: string): string {
  return path.join(IMAGES_DIR, category, 'IMAGES_LIST.md');
}

/** Source files still awaiting processing (image ext, no "<id>--" prefix). */
function pendingSources(): string[] {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs
    .readdirSync(SOURCE_DIR)
    .filter(f => SOURCE_EXTS.includes(path.extname(f).toLowerCase()) && !PROCESSED_RE.test(f))
    .sort();
}

/**
 * --next: Prints one unprocessed source filename from images-source/.
 * Prints "No images left." to stderr and exits 0 when none remain.
 */
function nextSource() {
  const files = pendingSources();
  if (files.length === 0) {
    console.error('No images left.');
    process.exit(0);
  }
  console.log(files[0]);
}

/** --cats: Prints the valid category folder names (one per line). */
function printCategories() {
  console.log(getCategories().join('\n'));
}

/**
 * Converts a source image to an AVIF at destPath: resize to maxPixels with
 * magick into a temp PNG, then avifenc with a quality loop down to the floor
 * until the result fits maxFileSize. Returns the final file size in bytes.
 * Throws on failure.
 */
function convertToAvif(srcPath: string, destPath: string, maxPixels: number, maxFileSize: number, initialQuality: number = INITIAL_QUALITY): number {
  const hasAvifenc = checkBinary('avifenc');
  const hasMagick = checkBinary('magick') || checkBinary('convert');
  const magickCmd = checkBinary('magick') ? 'magick' : 'convert';
  if (!hasAvifenc && !hasMagick) {
    throw new Error('Neither avifenc nor ImageMagick found. Install libavif-tools or ImageMagick.');
  }

  let encodeInput = srcPath;
  let tempInput = '';
  let tempDecoded = '';
  try {
    // magick/avifenc can't read AVIF here (no decode delegate). When the input
    // is an AVIF, decode it to PNG with avifdec first and work from that.
    if (path.extname(srcPath).toLowerCase() === '.avif' && checkBinary('avifdec')) {
      tempDecoded = path.join(os.tmpdir(), `genix-dec-${process.pid}-${maxPixels}.png`);
      const dec = spawnSync('avifdec', [srcPath, tempDecoded], { encoding: 'utf8' });
      if (dec.status === 0 && fs.existsSync(tempDecoded)) encodeInput = tempDecoded;
      else tempDecoded = '';
    }

    if (hasAvifenc && hasMagick) {
      tempInput = path.join(os.tmpdir(), `genix-opt-${process.pid}-${maxPixels}.png`);
      const resize = spawnSync(magickCmd, [encodeInput, '-resize', `${maxPixels}@>`, tempInput]);
      if (resize.status === 0 && fs.existsSync(tempInput)) encodeInput = tempInput;
      else tempInput = '';
    }

    let q = initialQuality;
    while (true) {
      if (hasAvifenc) {
        const res = spawnSync('avifenc',
          ['-q', String(q), '-s', String(SPEED), '-j', 'all', encodeInput, destPath],
          { encoding: 'utf8' });
        if (res.status !== 0) throw new Error(`avifenc failed: ${res.stderr || res.stdout || res.status}`);
      } else {
        const res = spawnSync(magickCmd,
          [encodeInput, '-resize', `${maxPixels}@>`, '-quality', String(q), destPath]);
        if (res.status !== 0) throw new Error(`magick failed: ${res.status}`);
      }
      const size = fs.statSync(destPath).size;
      if (size <= maxFileSize || q <= MIN_QUALITY) return size;
      q = Math.max(MIN_QUALITY, q - 5);
    }
  } finally {
    for (const t of [tempInput, tempDecoded]) {
      if (t && fs.existsSync(t)) { try { fs.unlinkSync(t); } catch {} }
    }
  }
}

/**
 * --process: One-shot per image. Converts the source to <id>.avif directly into
 * the chosen category folder, appends its metadata row to that folder's
 * IMAGES_LIST.md (Name = id), then renames the source to "<id>--<name>" so it is
 * skipped next time and bumps counter.txt. Counter is bumped only after the
 * source is safely marked.
 */
function processImage() {
  const args = process.argv;
  const getArg = (key: string) => {
    const idx = args.indexOf(key);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : '';
  };

  const source = getArg('--source');
  const category = getArg('--category');
  const desc = getArg('--desc');
  const elements = getArg('--elements');
  const colors = getArg('--colors');
  const background = getArg('--bg');
  const ratio = getArg('--ratio');
  const lighting = getArg('--lighting');

  if (!source || !category) {
    console.error('❌ Missing required arguments --source and --category');
    process.exit(1);
  }

  const categories = getCategories();
  if (!categories.includes(category)) {
    console.error(`❌ Unknown category "${category}". Valid categories:\n${categories.join('\n')}`);
    process.exit(1);
  }

  const srcPath = path.join(SOURCE_DIR, source);
  if (!fs.existsSync(srcPath)) {
    console.error(`❌ Source not found: images-source/${source}`);
    process.exit(1);
  }
  if (PROCESSED_RE.test(source)) {
    console.error(`❌ Source "${source}" is already processed ("<id>--" prefix).`);
    process.exit(1);
  }

  const parsed = path.parse(source);
  const id = readCounter() + 1;
  const avifName = `${id}.avif`;
  const smallName = `${id}.s.avif`;
  const destPath = path.join(IMAGES_DIR, category, avifName);
  const smallPath = path.join(IMAGES_DIR, category, smallName);

  if (fs.existsSync(destPath)) {
    console.error(`❌ ${category}/${avifName} already exists — id collision`);
    process.exit(1);
  }
  if (fs.existsSync(smallPath)) {
    console.error(`❌ ${category}/${smallName} already exists — id collision`);
    process.exit(1);
  }

  // 1) Convert into the category folder: the full-size image and a small
  //    (~0.16 MP) thumbnail variant named "<id>.s.avif".
  let size: number;
  let smallSize: number;
  try {
    size = convertToAvif(srcPath, destPath, MAX_PIXELS, MAX_FILE_SIZE);
    console.log(`✨ ${source} -> ${category}/${avifName} (${(size / 1024).toFixed(1)} KB)`);
    smallSize = convertToAvif(srcPath, smallPath, SMALL_MAX_PIXELS, SMALL_MAX_FILE_SIZE, SMALL_INITIAL_QUALITY);
    console.log(`✨ ${source} -> ${category}/${smallName} (${(smallSize / 1024).toFixed(1)} KB)`);
  } catch (e) {
    if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch {} }
    if (fs.existsSync(smallPath)) { try { fs.unlinkSync(smallPath); } catch {} }
    console.error(`❌ Conversion failed: ${e}`);
    process.exit(1);
  }

  // 2) Append the metadata row (Name = id).
  const listFile = listFileFor(category);
  const clean = (s: string) => s.replace(/\|/g, '\\|').trim();
  const row = `| ${id} | ${clean(desc)} | ${clean(elements)} | ${clean(colors)} | ${clean(background)} | ${clean(ratio)} | ${clean(lighting)} |\n`;
  let content = fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf-8') : LIST_HEADER;
  if (content && !content.endsWith('\n')) content += '\n';
  fs.writeFileSync(listFile, content + row);
  console.log(`📝 Documented in ${category}/IMAGES_LIST.md`);

  // 3) Mark the source as processed, then bump the counter.
  const markedSource = path.join(SOURCE_DIR, `${id}--${parsed.name}${parsed.ext}`);
  fs.renameSync(srcPath, markedSource);
  writeCounter(id);
  console.log(`   ↳ source marked: ${source} -> ${id}--${parsed.name}${parsed.ext} | counter -> ${id}`);
}

/** Maps each processed id to its marked source path ("<id>--<name>.<ext>"). */
function markedSourcesById(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(SOURCE_DIR)) return map;
  for (const f of fs.readdirSync(SOURCE_DIR)) {
    const m = f.match(/^(\d+)--/);
    if (m && SOURCE_EXTS.includes(path.extname(f).toLowerCase())) map.set(m[1], path.join(SOURCE_DIR, f));
  }
  return map;
}

/**
 * --fill-small: Scans every category folder for full-size "<id>.avif" files
 * that lack their "<id>.s.avif" thumbnail and generates the missing small
 * variant. Prefers the original marked source ("<id>--<name>.<ext>" in
 * images-source/) as input — same as --process — and falls back to the
 * full-size AVIF only if the source is gone. Idempotent: re-running only
 * creates what is missing.
 */
function fillSmall() {
  // Matches "<id>.avif" but not the small "<id>.s.avif".
  const FULL_RE = /^(\d+)\.avif$/;
  const sources = markedSourcesById();
  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const category of getCategories()) {
    const dir = path.join(IMAGES_DIR, category);
    const files = fs.readdirSync(dir).filter(f => FULL_RE.test(f));
    for (const file of files) {
      const id = file.match(FULL_RE)![1];
      const smallName = `${id}.s.avif`;
      const smallPath = path.join(dir, smallName);
      if (fs.existsSync(smallPath)) {
        skipped++;
        continue;
      }
      const input = sources.get(id) ?? path.join(dir, file);
      try {
        const smallSize = convertToAvif(input, smallPath, SMALL_MAX_PIXELS, SMALL_MAX_FILE_SIZE, SMALL_INITIAL_QUALITY);
        created++;
        console.log(`✨ ${category}/${smallName} (${(smallSize / 1024).toFixed(1)} KB)`);
      } catch (e) {
        if (fs.existsSync(smallPath)) { try { fs.unlinkSync(smallPath); } catch {} }
        failed++;
        console.error(`❌ ${category}/${file}: ${e}`);
      }
    }
  }

  console.log(`\nDone. created: ${created}, already present: ${skipped}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

/**
 * --summary: Writes docs/images/SUMMARY.md listing each category and the highest
 * image id ("<id>.avif") in it, one "category:maxnumber" per line. Categories
 * with no images report 0.
 */
function writeSummary() {
  const FULL_RE = /^(\d+)\.avif$/;
  const lines = getCategories().map(category => {
    const dir = path.join(IMAGES_DIR, category);
    let max = 0;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(FULL_RE);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${category}:${max}`;
  });
  const outFile = path.join(IMAGES_DIR, 'SUMMARY.md');
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`\n📝 Wrote ${path.relative(process.cwd(), outFile)}`);
}

const args = process.argv;
if (args.includes('--next')) {
  nextSource();
} else if (args.includes('--cats')) {
  printCategories();
} else if (args.includes('--process')) {
  processImage();
} else if (args.includes('--fill-small')) {
  fillSmall();
} else if (args.includes('--summary')) {
  writeSummary();
} else {
  console.error('Usage: --next | --cats | --fill-small | --summary | --process --source <file> --category <c> [--desc ... --elements ... --colors ... --bg ... --ratio ... --lighting ...]');
  process.exit(1);
}
