import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot } from '../shared';
import { allowedPath, previewLimit, worktreeStamp, type Change } from './live-radar-git';
import { decode, excludedEntry, safeFile, sha, sourceDirectoryEntries } from './snapshot';

function frozenFile(storage: string, snapshot: Snapshot, file: string) {
  const id = snapshot.source_snapshot_id;
  if (!allowedPath(id) || id.includes('/')) throw Error('无效快照 ID');
  return safeFile(storage, `snapshots/${id}/${file}`);
}

export function snapshotTree(storage: string, snapshot: Snapshot) {
  const entries = new Map(snapshot.files.filter(f => allowedPath(f.path)).map(f => [f.path, {size: f.bytes, hash: f.content_sha256}]));
  async function* read(paths: Iterable<string>) {
    for (const file of paths) {
      const entry = entries.get(file);
      if (!entry) continue;
      const bytes = await fs.readFile(await frozenFile(storage, snapshot, file));
      if (sha(bytes) !== entry.hash) throw Error('快照缓存哈希不匹配');
      yield [file, bytes] as const;
    }
  }
  return {entries, read};
}

export async function snapshotPreview(storage: string, snapshot: Snapshot, file: string) {
  const entry = snapshot.files.find(f => f.path === file);
  if (!entry) return Buffer.alloc(0);
  const handle = await fs.open(await frozenFile(storage, snapshot, file), 'r');
  try {
    const bytes = Buffer.alloc(Math.min(entry.bytes, previewLimit + 1));
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({autoClose: false})) {
      hash.update(chunk);
      if (size < bytes.length) chunk.copy(bytes, size);
      size += chunk.length;
    }
    if (hash.digest('hex') !== entry.content_sha256) return {missing: true} as const;
    if (size !== entry.bytes) throw Error('快照文件大小不匹配');
    return bytes;
  } finally { await handle.close(); }
}

export async function snapshotChanges(root: string, snapshot: Snapshot) {
  const remaining = new Map(snapshot.files.map(file => [file.path, file]));
  const excluded = new Set(snapshot.excluded.map(item => item.path));
  const changes: Change[] = [];
  // Keep stat identities for unchanged caller previews from this scan as well.
  const unchanged = new Map<string, Change>();
  async function walk(dir: string, prefix: string) {
    for (const item of await sourceDirectoryEntries(dir) ?? []) {
      if (excludedEntry(item.name) || item.isSymbolicLink()) continue;
      const file = prefix + item.name;
      if (!allowedPath(file)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { await walk(full, file + '/'); continue; }
      if (!item.isFile()) continue;
      const before = remaining.get(file);
      remaining.delete(file);
      const input = await safeFile(root, file);
      const stat = await fs.stat(input);
      const change: Change = {path: file, status: before ? 'modified' : 'added', size: stat.size, stamp: worktreeStamp(stat)};
      if (before?.bytes === stat.size || (!before && excluded.has(file))) {
        // A binary/oversized file omitted during capture is only newly comparable
        // if it has since become eligible for the snapshot.
        if (!before && stat.size > 2 * 1024 * 1024) continue;
        const bytes = await fs.readFile(input);
        const end = await fs.stat(input);
        if (stat.size !== end.size || change.stamp !== worktreeStamp(end)) throw Error('扫描期间文件变化，请重试：' + file);
        if (before && sha(bytes) === before.content_sha256) { unchanged.set(file, change); continue; }
        if (!before) {
          if (bytes.includes(0)) continue;
          try { decode(bytes); } catch { continue; }
        }
      }
      changes.push(change);
    }
  }
  await walk(root, '');
  for (const file of remaining.keys()) {
    if (allowedPath(file)) changes.push({path: file, status: 'removed', size: 0, stamp: ''});
  }
  return {changes, unchanged};
}
