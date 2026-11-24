import { randomUUID } from 'node:crypto';
import { realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const deviceName = /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i;
type SavePicker = (name: string, extension: 'svg' | 'png') => Promise<string | undefined>;

export function diagramSaveDirectory(downloads: string, projectRoot: string) {
  const relative = path.relative(projectRoot, downloads);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return downloads;
  const parent = path.dirname(projectRoot);
  if (parent === projectRoot) throw Error('下载目录位于分析工程中。请选择工程外的下载目录或指定导出路径。');
  return parent;
}

export async function exportDiagramFile(args: Record<string, unknown>, pick: SavePicker, projectRoot?: string) {
  const { format, suggested_name, output_path, content_base64, content_utf8 } = args;
  if (format !== 'svg' && format !== 'png') throw Error('图表文件格式无效');
  if (typeof suggested_name !== 'string' || !suggested_name.trim()) throw Error('图表文件名不能为空');
  const stem = suggested_name.replace(/\.(svg|png)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 128).trim().replace(/[. ]+$/, '') || '图表';
  const name = (deviceName.test(stem) ? '_' : '') + stem + '.' + format;
  let content: Buffer;
  if (format === 'svg') {
    if (typeof content_utf8 !== 'string' || !/^\s*<svg(?=[\s>])/.test(content_utf8) || !/<\/svg>\s*$/.test(content_utf8))
      throw Error('SVG 内容缺少有效的根元素');
    content = Buffer.from(content_utf8, 'utf8');
  } else {
    if (typeof content_base64 !== 'string' || !content_base64.length || content_base64.length % 4
      || /[^a-zA-Z0-9+/=]/.test(content_base64)) throw Error('PNG Base64 编码无效');
    content = Buffer.from(content_base64, 'base64');
    if (!content.subarray(0, 8).equals(pngSignature) || content.length <= 8 || content.toString('base64') !== content_base64)
      throw Error('PNG 文件签名或编码无效');
  }
  const dest = output_path === undefined ? await pick(name, format) : output_path;
  if (dest === undefined) return { canceled: true, file_path: null, bytes: 0 };
  if (typeof dest !== 'string' || !path.isAbsolute(dest) || path.extname(dest).toLowerCase() !== '.' + format
    || /[\x00-\x1f]/.test(dest) || dest.split(/[\\/]/).includes('..')) throw Error('导出需要扩展名匹配的绝对文件路径');
  if (process.platform === 'win32' && (!/^(?:[a-z]:[\\/]|\\\\[^?.])/.test(dest.toLowerCase())
    || dest.slice(path.parse(dest).root.length).split(/[\\/]/).some(part => deviceName.test(part) || /[:<>|?*"]|[. ]$/.test(part))))
    throw Error('无效的 Windows 文件路径');
  const directory = await realpath(path.dirname(dest));
  if (projectRoot !== undefined) {
    const relative = path.relative(await realpath(projectRoot), directory);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
      throw Error('不能将图表导出到分析工程内，请选择工程外的目录');
  }
  const temp = path.join(directory, '.arc-' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, path.join(directory, path.basename(dest)));
  } finally {
    await rm(temp, { force: true });
  }
  return { canceled: false, file_path: dest, bytes: content.length };
}
