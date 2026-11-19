/**
 * Builds the skill customers install into Claude Code.
 *
 * The skill's source (skill/src) never contains the product name. This fills
 * in the name, slug and manifest file name from the one constant, and writes
 * the result to skill/dist/<slug>-metrics/.
 *
 *   pnpm skill:build
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILENAME, PRODUCT_NAME, PRODUCT_SLUG } from '@app/config';

const root = fileURLToPath(new URL('../skill', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist', `${PRODUCT_SLUG}-metrics`);

const values: Record<string, string> = {
  PRODUCT_NAME,
  PRODUCT_SLUG,
  MANIFEST_FILENAME,
};

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(source, output, { recursive: true });

function fill(directory: string): number {
  let files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files += fill(path);
      continue;
    }
    const text = readFileSync(path, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`${relative(root, path)}: unknown placeholder ${whole}`);
      }
      return value;
    });
    writeFileSync(path, text);
    files += 1;
  }
  return files;
}

console.log(`Built ${fill(output)} files into ${relative(join(root, '..'), output)}`);
