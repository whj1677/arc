import type { ArchitectureDocument } from '../architecture-workspace';
import { renderArchitectureSvg, renderFeatureDataflowSvg } from '../export/diagram-svg';
import type { ArcApi } from '../shared';

export type Resolution = 'standard' | 'hd' | 'auto_large';
export type FileFormat = 'png' | 'svg';
type ArchitectureOptions = Omit<Parameters<typeof renderArchitectureSvg>[0], 'doc'>;
type FeatureOptions = Parameters<typeof renderFeatureDataflowSvg>[0];
type VersionKey = Pick<ArchitectureDocument, 'project_id' | 'branch_key' | 'version'>;

export async function readExportVersion(invoke: ArcApi['invoke'], key: VersionKey) {
  const { document } = await invoke<{ document: ArchitectureDocument }>('architecture_get', {
    project_id: key.project_id, branch_key: key.branch_key, version: key.version, document_only: true,
  });
  if (document.version !== key.version || document.branch_key !== key.branch_key || document.project_id !== key.project_id)
    throw Error('返回的架构文档与选定保存版本不一致。');
  return document;
}

export function pngDimensions(width: number, height: number, resolution: Resolution) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw Error('图表尺寸无效');
  const side = Math.max(width, height);
  const preferred = resolution === 'standard' ? 2 : resolution === 'hd' ? 3 : Math.max(1.5, Math.min(3, 12000 / side));
  const scale = Math.min(preferred, 16384 / side, Math.sqrt(64000000 / (width * height)));
  return { scale, pixelWidth: Math.max(1, Math.floor(width * scale)), pixelHeight: Math.max(1, Math.floor(height * scale)) };
}

export async function svgToPngBase64(svg: string, width: number, height: number, resolution: Resolution) {
  const dimensions = pngDimensions(width, height, resolution);
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  try {
    await image.decode();
  } catch (cause) {
    throw new Error('无法解码独立 SVG 图表。', { cause });
  }
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.pixelWidth;
  canvas.height = dimensions.pixelHeight;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw Error('浏览器无法创建 PNG 画布。');
    context.fillStyle = '#f8fafc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png');
    const prefix = 'data:image/png;base64,';
    if (!data.startsWith(prefix) || data.length === prefix.length) throw Error('画布未生成 PNG 图像。');
    return { ...dimensions, base64: data.slice(prefix.length) };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

type ExportSource =
  | { mode: 'architecture'; key: VersionKey; options: ArchitectureOptions }
  | { mode: 'feature'; options: FeatureOptions };

export async function exportSavedDiagram(invoke: ArcApi['invoke'], source: ExportSource, format: FileFormat, resolution: Resolution) {
  const exportedAt = new Date().toISOString();
  let diagram: ReturnType<typeof renderArchitectureSvg>;
  let name: string;
  if (source.mode === 'architecture') {
    const doc = await readExportVersion(invoke, source.key);
    diagram = renderArchitectureSvg({ ...source.options, doc, exportedAt });
    const root = doc.modules.find(m => m.id === source.options.selectedModuleId);
    name = [doc.title, root?.name, 'v' + doc.version].filter(Boolean).join('-');
  } else {
    diagram = renderFeatureDataflowSvg({ ...source.options, exportedAt });
    name = [source.options.featureName, source.options.diagramView, source.options.explanation.result_id].join('-');
  }
  const payload = format === 'svg' ? { content_utf8: diagram.svg }
    : { content_base64: (await svgToPngBase64(diagram.svg, diagram.width, diagram.height, resolution)).base64 };
  return invoke<{ canceled: boolean; file_path: string | null; bytes: number }>('export_diagram_file', {
    project_id: source.mode === 'architecture' ? source.key.project_id : source.options.explanation.result.binding.project_id,
    format, suggested_name: name + '.' + format, ...payload,
  });
}
