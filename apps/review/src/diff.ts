/** Lines a pull request adds, with their line numbers in the new file. */
export interface AddedLine {
  line: number;
  text: string;
}

/** Read a unified diff patch (GitHub's `patch` field): the added lines and the changed line numbers. */
export function parsePatch(patch: string | undefined): {
  added: AddedLine[];
  changed: Set<number>;
} {
  const added: AddedLine[] = [];
  const changed = new Set<number>();
  if (!patch) return { added, changed };
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('+') && !row.startsWith('+++')) {
      added.push({ line, text: row.slice(1) });
      changed.add(line);
      line += 1;
    } else if (row.startsWith('-') && !row.startsWith('---')) {
      // A removal changes the code at this point in the new file.
      changed.add(line);
    } else if (!row.startsWith('\\')) {
      line += 1;
    }
  }
  return { added, changed };
}
