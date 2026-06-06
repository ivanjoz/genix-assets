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
const INITIAL_QUALITY = 80;
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
 * Converts a source image to a <id>.avif at destPath: resize to the 1.4MP cap
 * with magick into a temp PNG, then avifenc with a quality loop down to the
 * floor. Returns the final file size in bytes. Throws on failure.
 */
function convertToAvif(srcPath: string, destPath: string): number {
  const hasAvifenc = checkBinary('avifenc');
  const hasMagick = checkBinary('magick') || checkBinary('convert');
  const magickCmd = checkBinary('magick') ? 'magick' : 'convert';
  if (!hasAvifenc && !hasMagick) {
    throw new Error('Neither avifenc nor ImageMagick found. Install libavif-tools or ImageMagick.');
  }

  let encodeInput = srcPath;
  let tempInput = '';
  try {
    if (hasAvifenc && hasMagick) {
      tempInput = path.join(os.tmpdir(), `genix-opt-${process.pid}.png`);
      const resize = spawnSync(magickCmd, [srcPath, '-resize', `${MAX_PIXELS}@>`, tempInput]);
      if (resize.status === 0 && fs.existsSync(tempInput)) encodeInput = tempInput;
      else tempInput = '';
    }

    let q = INITIAL_QUALITY;
    while (true) {
      if (hasAvifenc) {
        const res = spawnSync('avifenc',
          ['-q', String(q), '-s', String(SPEED), '-j', 'all', encodeInput, destPath],
          { encoding: 'utf8' });
        if (res.status !== 0) throw new Error(`avifenc failed: ${res.stderr || res.stdout || res.status}`);
      } else {
        const res = spawnSync(magickCmd,
          [srcPath, '-resize', `${MAX_PIXELS}@>`, '-quality', String(q), destPath]);
        if (res.status !== 0) throw new Error(`magick failed: ${res.status}`);
      }
      const size = fs.statSync(destPath).size;
      if (size <= MAX_FILE_SIZE || q <= MIN_QUALITY) return size;
      q = Math.max(MIN_QUALITY, q - 5);
    }
  } finally {
    if (tempInput && fs.existsSync(tempInput)) {
      try { fs.unlinkSync(tempInput); } catch {}
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
  const destPath = path.join(IMAGES_DIR, category, avifName);

  if (fs.existsSync(destPath)) {
    console.error(`❌ ${category}/${avifName} already exists — id collision`);
    process.exit(1);
  }

  // 1) Convert into the category folder.
  let size: number;
  try {
    size = convertToAvif(srcPath, destPath);
    console.log(`✨ ${source} -> ${category}/${avifName} (${(size / 1024).toFixed(1)} KB)`);
  } catch (e) {
    if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch {} }
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

const args = process.argv;
if (args.includes('--next')) {
  nextSource();
} else if (args.includes('--cats')) {
  printCategories();
} else if (args.includes('--process')) {
  processImage();
} else {
  console.error('Usage: --next | --cats | --process --source <file> --category <c> [--desc ... --elements ... --colors ... --bg ... --ratio ... --lighting ...]');
  process.exit(1);
}
