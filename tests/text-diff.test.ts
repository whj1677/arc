import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff, collapseUnifiedContext, collapseSplitContext } from '../src/ui/text-diff';

test('computeLineDiff identifies additions, removals and unchanged lines', () => {
  const before = 'line1\nline2\nold3\nline4\n';
  const after = 'line1\nline2\nnew3a\nnew3b\nline4\n';
  const result = computeLineDiff(before, after);

  assert.deepEqual(result.stats, { added: 2, removed: 1, unchanged: 3 });
  assert.deepEqual(
    result.lines.map(item => [item.type, item.oldLine, item.newLine, item.text]),
    [
      ['same', 1, 1, 'line1'],
      ['same', 2, 2, 'line2'],
      ['del', 3, undefined, 'old3'],
      ['add', undefined, 3, 'new3a'],
      ['add', undefined, 4, 'new3b'],
      ['same', 4, 5, 'line4'],
    ],
  );
  assert.equal(result.split.length, 5);
  assert.equal(result.split[2].left.type, 'del');
  assert.equal(result.split[2].right.type, 'add');
  assert.equal(result.split[3].left.type, 'empty');
  assert.equal(result.split[3].right.type, 'add');
});

test('collapse context folds long unchanged stretches while preserving nearby context', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`);
  const after = [...lines];
  after[10] = 'row-11-edited';
  const diff = computeLineDiff(lines.join('\n'), after.join('\n'));

  const unified = collapseUnifiedContext(diff.lines, 2);
  assert.ok(unified.some(item => item.type === 'gap' && item.hidden > 0));
  assert.ok(unified.some(item => item.type === 'del' && item.text === 'row-11'));
  assert.ok(unified.some(item => item.type === 'add' && item.text === 'row-11-edited'));

  const split = collapseSplitContext(diff.split, 2);
  assert.ok(split.some(item => item.type === 'gap' && item.hidden > 0));
  assert.ok(split.some(item => item.type === 'row' && item.row.right.text === 'row-11-edited'));
});

test('handles empty before or after cleanly', () => {
  const created = computeLineDiff('', 'a\nb\n');
  assert.deepEqual(created.stats, { added: 2, removed: 0, unchanged: 0 });
  const deleted = computeLineDiff('a\nb\n', '');
  assert.deepEqual(deleted.stats, { added: 0, removed: 2, unchanged: 0 });
});
