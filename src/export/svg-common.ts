import type { Rect } from '../ui/flow-layout';

export interface DiagramExportMetadata {
  diagramTitle: string;
  projectName: string;
  scopeLabel: string;
  versionLabel: string;
  baselineLabel?: string;
  statusLabel: string;
  pendingReviewCount?: number;
  exportedAt: string;
}

interface DiagramCounts { nodeCount: number; edgeCount: number; externalBoundaryCount: number }
export interface DiagramExportResult extends DiagramCounts {
  svg: string;
  width: number;
  height: number;
  scopeSummary: string;
}

export const arrowColors = {
  default: '#326380', external: '#755795', uncertain: '#97621c', exception: '#b53a36', return: '#28715f',
} as const;

const sans = '"Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif';
const mono = 'Consolas, "Cascadia Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace';

export function escapeXml(value: string) {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function emWidth(char: string) {
  if (/\p{Mark}|\u200d/u.test(char)) return 0;
  if (/[MWmw@%&#]/.test(char)) return 0.95;
  if (/[A-Z]/.test(char)) return 0.72;
  return char.codePointAt(0)! < 128 ? 0.6 : 1;
}

export function svgTextWidth(text: string, fontSize: number) {
  return Array.from(text).reduce((sum, ch) => sum + emWidth(ch) * fontSize, 0);
}

export function wrapSvgLines(text: string, maxWidthPx: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replaceAll('\t', '    ').split('\n')) {
    let line = '', width = 0;
    for (const char of paragraph) {
      const next = emWidth(char) * fontSize;
      if (line && width + next > maxWidthPx) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += char;
      width += next;
    }
    lines.push(line);
  }
  return lines;
}

export function svgText(lines: readonly string[], x: number, y: number, fontSize: number, options: {
  lineHeight?: number; color?: string; weight?: number; mono?: boolean; anchor?: 'start' | 'middle' | 'end';
} = {}) {
  const lineHeight = options.lineHeight ?? Math.ceil(fontSize * 1.5);
  return `<text xml:space="preserve" font-family="${escapeXml(options.mono ? mono : sans)}" font-size="${fontSize}" fill="${options.color ?? '#203646'}" font-weight="${options.weight ?? 400}" text-anchor="${options.anchor ?? 'start'}">${lines.map((line, i) =>
    `<tspan x="${x}" y="${y + i * lineHeight}"${line ? ` textLength="${Number(svgTextWidth(line, fontSize).toFixed(2))}" lengthAdjust="spacingAndGlyphs"` : ''}>${escapeXml(line)}</tspan>`).join('')}</text>`;
}

export function finishDiagram(meta: DiagramExportMetadata, body: string, bounds: Rect, counts: DiagramCounts, legend: string): DiagramExportResult {
  const margin = 32, width = Math.max(720, Math.ceil(bounds.width + 2 * margin));
  const textWidth = Math.min(width - 2 * margin, 1400);
  const title = wrapSvgLines(meta.diagramTitle, textWidth, 24);
  const details = [`工程：${meta.projectName}　·　版本：${meta.versionLabel}`, `范围：${meta.scopeLabel}`]
    .flatMap(s => wrapSvgLines(s, textWidth, 14));
  const headerHeight = 36 + title.length * 34 + details.length * 22;
  const review = meta.pendingReviewCount ? `　·　待复核 ${meta.pendingReviewCount} 项` : '';
  const footer = [`图例　${legend}`, `快照 / 代码基线：${meta.baselineLabel || '未记录'}`,
    `来源状态：${meta.statusLabel}${review}　·　导出时间：${meta.exportedAt}`].flatMap(s => wrapSvgLines(s, textWidth, 14));
  const footerY = Math.ceil(headerHeight + bounds.height + margin * 2), height = footerY + footer.length * 22 + 32;
  const markers = Object.entries(arrowColors).map(([name, color]) =>
    `<marker id="arrow-${name}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L8 4 L0 8 Z" fill="${color}"/></marker>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escapeXml(meta.diagramTitle)}</title><defs>${markers}</defs><rect width="${width}" height="${height}" fill="#f8fafc"/><rect width="${width}" height="${headerHeight}" fill="#173a47"/>` +
    svgText(title, margin, 40, 24, { color: '#ffffff', weight: 700, lineHeight: 34 }) +
    svgText(details, margin, 37 + title.length * 34, 14, { color: '#dceff0', lineHeight: 22 }) +
    `<g transform="translate(${margin - bounds.x} ${headerHeight + margin - bounds.y})">${body}</g><rect x="0" y="${footerY}" width="${width}" height="${height - footerY}" fill="#e8eff2"/>` +
    svgText(footer, margin, footerY + 28, 14, { lineHeight: 22 }) + '</svg>';
  return { svg, width, height, scopeSummary: meta.scopeLabel, ...counts };
}
