import path from 'node:path';
import type {CodeCall, CodeIndex, CodeSymbol} from './code-index';
import type {CodeIndexSummary} from '../shared';

export function codeIndexSummary(index: CodeIndex): CodeIndexSummary {
  const names = new Map(index.symbols.map(symbol => [symbol.id, symbol.qualified_name]));
  return {
    modules: index.modules.map(module => ({
      dir: module.dir, file_count: module.files.length, files: module.files, symbol_count: module.symbol_count,
      key_symbols: module.key_symbols.map(id => names.get(id)!),
    })),
    module_edges: [...index.module_edges].sort((a, b) => b.count - a.count),
    total_files: index.files.length,
    total_symbols: index.symbols.length,
    total_calls: index.calls.length,
  };
}

type Page = {offset?: number; limit?: number};
function inDirectory(file: string, dir?: string) {
  const prefix = dir?.replace(/\/$/, '');
  return !prefix || prefix === '.' || file === prefix || file.startsWith(prefix + '/');
}

function page<T>(items: T[], {offset = 0, limit = 40}: Page) {
  const rows = items.slice(offset, offset + limit);
  return {rows, total: items.length, next_offset: offset + rows.length < items.length ? offset + rows.length : null};
}

function location({id, qualified_name, file, start_line, end_line}: CodeSymbol) {
  return {id, qualified_name, file, start_line, end_line};
}

function graphLocation(symbol:CodeSymbol) {
  return {...location(symbol),signature:symbol.signature};
}

export function listModules(index: CodeIndex, args: Page & {dir?: string; shared_state_offset?: number; shared_state_limit?: number}) {
  const {rows, total, next_offset} = page(index.modules.filter(module => inDirectory(module.dir, args.dir)), args);
  const ids = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
  const modules = rows.map(module => ({
    dir: module.dir, file_count: module.files.length, files: module.files.slice(0, 24),
    files_truncated: module.files.length > 24, symbol_count: module.symbol_count,
    key_symbols: module.key_symbols.map(id => location(ids.get(id)!)),
  }));
  const dirs = new Set(rows.map(module => module.dir));
  const edges = index.module_edges.filter(edge => dirs.has(edge.from) || dirs.has(edge.to)).sort((a, b) => b.count - a.count);
  const states = index.shared_states.filter(state => dirs.has(path.posix.dirname(state.file)) || state.access_dirs.some(dir => dirs.has(dir)));
  const {shared_state_offset = 0, shared_state_limit = 16} = args;
  return {
    modules, total, next_offset, module_edges: edges.slice(0, 100), module_edge_count: edges.length,
    shared_states: states.slice(shared_state_offset, shared_state_offset + shared_state_limit), shared_state_count: states.length,
    indexed_file_count: index.files.length, parse_error_count: index.parse_errors.length, parse_errors: index.parse_errors.slice(0, 12),
  };
}

export function listSymbols(index: CodeIndex, args: Page & {dir?: string; path?: string; query?: string; kind?: string}) {
  const query = args.query?.toLowerCase();
  const matches = index.symbols.filter(symbol => inDirectory(symbol.file, args.dir) &&
    (!args.path || symbol.file === args.path) && (!args.kind || symbol.kind === args.kind) &&
    (!query || symbol.qualified_name.toLowerCase().includes(query)));
  const {rows: symbols, total, next_offset} = page(matches, args);
  return {symbols, total, next_offset};
}

export function getCallGraph(index: CodeIndex, args: Page & {symbol: string; file?: string; direction?: 'outgoing'|'incoming'|'both'; depth?: number}) {
  const {symbol, file, direction = 'both', depth = 2} = args;
  const matches = index.symbols.filter(s => (!file || s.file === file) && (s.id === symbol || s.name === symbol || s.qualified_name === symbol));
  // A C/C++ declaration in a header and its unique definition are one graph entry point.
  const definitions = matches.filter(s => s.has_body);
  const roots = definitions.length && matches.every(s => (s.language === 'c' || s.language === 'cpp') &&
    s.qualified_name === matches[0].qualified_name && s.kind === matches[0].kind) ? definitions : matches;
  if (roots.length !== 1) {
    return {roots: roots.slice(0, 40).map(graphLocation), match_count: roots.length, ambiguous: roots.length > 1, edges: [], total: 0, next_offset: null};
  }
  const byId = new Map(index.symbols.map(s => [s.id, s]));
  const calls = new Set<CodeCall>();
  function traverse(incoming: boolean) {
    const adjacent = new Map<string, CodeCall[]>();
    for (const call of index.calls) {
      for (const id of incoming ? call.target_ids : [call.caller_id]) {
        const group = adjacent.get(id);
        if (group) group.push(call);
        else adjacent.set(id, [call]);
      }
    }
    let frontier = [roots[0].id];
    const visited = new Set(frontier);
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const call of adjacent.get(id) ?? []) {
          calls.add(call);
          for (const neighbor of incoming ? [call.caller_id] : call.target_ids) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
  }
  if (direction !== 'incoming') traverse(false);
  if (direction !== 'outgoing') traverse(true);
  const {rows, total, next_offset} = page([...calls], args);
  const edges = rows.map(call => ({
    caller: graphLocation(byId.get(call.caller_id)!), callee_name: call.callee_name, qualifier: call.qualifier, syntax:call.syntax,
    file: call.file, line: call.line, targets: call.target_ids.map(id => graphLocation(byId.get(id)!)),
  }));
  return {roots: roots.map(graphLocation), match_count: 1, ambiguous: false, edges, total, next_offset};
}
