export interface DiffLine {
  type: 'same' | 'add' | 'del';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface SplitCell {
  type: 'same' | 'add' | 'del' | 'empty';
  line?: number;
  text: string;
}

export interface SplitDiffRow {
  left: SplitCell;
  right: SplitCell;
}

export type UnifiedDisplayItem =
  | DiffLine
  | { type: 'gap'; hidden: number };

export type SplitDisplayItem =
  | { type: 'row'; row: SplitDiffRow }
  | { type: 'gap'; hidden: number };

export interface LineDiffResult {
  lines: DiffLine[];
  split: SplitDiffRow[];
  stats: { added: number; removed: number; unchanged: number };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const raw = text.split(/\r\n|\n|\r/);
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  return raw;
}

/**
 * Pure line-level diff with prefix/suffix trimming and bounded LCS table.
 * Falls back cleanly on huge divergent regions without stalling the renderer.
 */
export function computeLineDiff(before: string, after: string): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    lines.push({ type: 'same', oldLine: i + 1, newLine: i + 1, text: a[i] });
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const m = midA.length;
  const n = midB.length;

  if (m === 0) {
    for (let j = 0; j < n; j++) {
      lines.push({ type: 'add', newLine: prefix + j + 1, text: midB[j] });
    }
  } else if (n === 0) {
    for (let i = 0; i < m; i++) {
      lines.push({ type: 'del', oldLine: prefix + i + 1, text: midA[i] });
    }
  } else if (m * n <= 250_000) {
    const stride = n + 1;
    const dp = new Uint32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
      const row = i * stride;
      const nextRow = (i + 1) * stride;
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[row + j] = dp[nextRow + j + 1] + 1;
        } else {
          const down = dp[nextRow + j];
          const right = dp[row + j + 1];
          dp[row + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        lines.push({
          type: 'same',
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: midA[i],
        });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
        lines.push({ type: 'del', oldLine: prefix + i + 1, text: midA[i] });
        i++;
      } else {
        lines.push({ type: 'add', newLine: prefix + j + 1, text: midB[j] });
        j++;
      }
    }
    while (i < m) {
      lines.push({ type: 'del', oldLine: prefix + i + 1, text: midA[i] });
      i++;
    }
    while (j < n) {
      lines.push({ type: 'add', newLine: prefix + j + 1, text: midB[j] });
      j++;
    }
  } else {
    for (let i = 0; i < m; i++) {
      lines.push({ type: 'del', oldLine: prefix + i + 1, text: midA[i] });
    }
    for (let j = 0; j < n; j++) {
      lines.push({ type: 'add', newLine: prefix + j + 1, text: midB[j] });
    }
  }

  for (let k = 0; k < suffix; k++) {
    const ai = a.length - suffix + k;
    const bi = b.length - suffix + k;
    lines.push({ type: 'same', oldLine: ai + 1, newLine: bi + 1, text: a[ai] });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const item of lines) {
    if (item.type === 'add') added++;
    else if (item.type === 'del') removed++;
    else unchanged++;
  }

  const split: SplitDiffRow[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const current = lines[idx];
    if (current.type === 'same') {
      split.push({
        left: { type: 'same', line: current.oldLine, text: current.text },
        right: { type: 'same', line: current.newLine, text: current.text },
      });
      idx++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (idx < lines.length && lines[idx].type !== 'same') {
      if (lines[idx].type === 'del') dels.push(lines[idx]);
      else adds.push(lines[idx]);
      idx++;
    }
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) {
      const d = dels[k];
      const ad = adds[k];
      split.push({
        left: d ? { type: 'del', line: d.oldLine, text: d.text } : { type: 'empty', text: '' },
        right: ad ? { type: 'add', line: ad.newLine, text: ad.text } : { type: 'empty', text: '' },
      });
    }
  }

  return { lines, split, stats: { added, removed, unchanged } };
}

export function collapseUnifiedContext(lines: DiffLine[], context = 3): UnifiedDisplayItem[] {
  const hasChange = lines.some(line => line.type !== 'same');
  if (!hasChange) return lines;
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'same') {
      const start = Math.max(0, i - context);
      const end = Math.min(lines.length - 1, i + context);
      for (let j = start; j <= end; j++) keep[j] = 1;
    }
  }
  const out: UnifiedDisplayItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i]);
      i++;
    } else {
      let hidden = 0;
      while (i < lines.length && !keep[i]) {
        hidden++;
        i++;
      }
      if (hidden <= 2) {
        for (let k = i - hidden; k < i; k++) out.push(lines[k]);
      } else {
        out.push({ type: 'gap', hidden });
      }
    }
  }
  return out;
}

export function collapseSplitContext(rows: SplitDiffRow[], context = 3): SplitDisplayItem[] {
  const hasChange = rows.some(row => row.left.type !== 'same' || row.right.type !== 'same');
  if (!hasChange) return rows.map(row => ({ type: 'row', row }));
  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].left.type !== 'same' || rows[i].right.type !== 'same') {
      const start = Math.max(0, i - context);
      const end = Math.min(rows.length - 1, i + context);
      for (let j = start; j <= end; j++) keep[j] = 1;
    }
  }
  const out: SplitDisplayItem[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      out.push({ type: 'row', row: rows[i] });
      i++;
    } else {
      let hidden = 0;
      while (i < rows.length && !keep[i]) {
        hidden++;
        i++;
      }
      if (hidden <= 2) {
        for (let k = i - hidden; k < i; k++) out.push({ type: 'row', row: rows[k] });
      } else {
        out.push({ type: 'gap', hidden });
      }
    }
  }
  return out;
}
