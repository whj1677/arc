import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import type {Snapshot} from '../shared';
import {readSource, relativePath} from './snapshot';

type Language = 'c'|'cpp'|'python'|'javascript'|'typescript'|'tsx'|'java';
type Kind = 'function'|'method'|'constructor'|'destructor'|'class'|'struct'|'interface';
type Node = Parser.SyntaxNode;
export interface CodeSymbol {
  id:string; name:string; qualified_name:string; kind:Kind; file:string; start_line:number; end_line:number;
  signature:string; language:Language; has_body:boolean; public_entry:boolean;
}
export interface CodeCall {
  caller_id:string; callee_name:string; qualifier:string; file:string; line:number; target_ids:string[];
  syntax:'direct'|'member'|'scoped';
}
export interface CodeModule { dir:string; files:string[]; symbol_count:number; key_symbols:string[] }
export interface CodeIndex {
  schema_version:number; snapshot_id:string; fingerprint:string; files:string[]; symbols:CodeSymbol[]; calls:CodeCall[];
  modules:CodeModule[]; module_edges:{from:string;to:string;count:number}[]; parse_errors:{file:string;reason:string}[];
}
const version = 1;
const extensions:Record<string,Language> = {
  '.c':'c', '.h':'c', '.cc':'cpp', '.cpp':'cpp', '.cxx':'cpp', '.hh':'cpp', '.hpp':'cpp', '.hxx':'cpp',
  '.py':'python', '.js':'javascript', '.mjs':'javascript', '.cjs':'javascript', '.jsx':'javascript',
  '.ts':'typescript', '.mts':'typescript', '.cts':'typescript', '.tsx':'tsx', '.java':'java',
};
function asset(file:string, dependency:string) {
  if (typeof __dirname === 'string' && path.basename(__dirname) === 'dist') return path.join(__dirname, 'tree-sitter', file);
  const bundled = path.resolve('dist/tree-sitter',file);
  return existsSync(bundled) ? bundled : path.resolve('node_modules', dependency, file);
}
let runtime:Promise<void>|undefined;
const languages = new Map<Language, Promise<Parser.Language>>();
function grammar(language:Language) {
  let loaded = languages.get(language);
  if (!loaded) {
    loaded = Parser.Language.load(asset(`tree-sitter-${language}.wasm`, 'tree-sitter-wasms/out'));
    languages.set(language, loaded);
  }
  return loaded;
}

const typeKinds:Record<string,Kind> = {
  class_specifier:'class', class_declaration:'class', class_definition:'class', struct_specifier:'struct',
  interface_declaration:'interface', abstract_class_declaration:'class', record_declaration:'class',
};
const functionNodes = ['function_definition','function_declarator','function_declaration','function_signature',
  'generator_function_declaration','method_definition','method_declaration','constructor_declaration',
  'method_signature','abstract_method_signature','arrow_function','function_expression','generator_function'];
const callNodes = new Set(['call_expression','call','method_invocation','new_expression','object_creation_expression']);
const indexNodes = [...Object.keys(typeKinds), ...functionNodes, ...callNodes, 'namespace_definition','internal_module'];
const typeSymbol = (kind:Kind) => kind === 'class' || kind === 'interface' || kind === 'struct';
const field = (node:Node, key:string) => node.childForFieldName(key);
const separator = (language:Language) => language === 'cpp' || language === 'c' ? '::' : '.';
function declaratorName(node:Node) {
  let part:Node|null = field(node,'declarator');
  while (part && part.type.endsWith('_declarator')) {
    part = field(part,'declarator') ?? (part.type === 'reference_declarator' ? part.lastNamedChild : null);
  }
  return part?.text;
}

interface Scope { end:number; name:string; kind?:Kind; caller?:string }
function declaration(node:Node, scope:Scope, lang:Language) {
  let owner = node;
  let spelling = field(node,'name')?.text;
  let kind = typeKinds[node.type];
  if (kind) {
    if (!field(node,'body')) return;
    if (!spelling && node.parent?.type === 'type_definition') spelling = field(node.parent,'declarator')?.text;
  } else {
    if (node.type === 'function_declarator') {
      // Accept a header prototype, excluding function pointers and declarators owned by definitions.
      let parent = node.parent;
      while (parent?.type === 'pointer_declarator' || parent?.type === 'reference_declarator') parent = parent.parent;
      if (parent?.type !== 'declaration' && parent?.type !== 'field_declaration') return;
      owner = parent;
      spelling = declaratorName(node);
    } else if (node.type === 'function_definition' && lang !== 'python') {
      spelling = declaratorName(node);
    } else if (['arrow_function','function_expression','generator_function'].includes(node.type)) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator' || parent?.type === 'public_field_definition' || parent?.type === 'field_definition') {
        owner = parent;
        spelling = (field(parent,'name') ?? field(parent,'property'))?.text;
      }
    }
    kind = (scope.kind && typeSymbol(scope.kind)) || spelling?.includes('::') || node.type.startsWith('method_') ? 'method' : 'function';
  }
  if (!spelling) return;
  const sep = separator(lang);
  const qualified = scope.name && !spelling.startsWith(scope.name+sep) ? scope.name+sep+spelling : spelling;
  const parts = qualified.split(sep);
  const name = parts.at(-1)!;
  if (kind === 'method' || node.type === 'constructor_declaration') {
    if (name.startsWith('~') || (lang === 'python' && name === '__del__')) kind = 'destructor';
    else if (node.type === 'constructor_declaration' || name === 'constructor' || name === '__init__' || (lang === 'cpp' && name === parts.at(-2))) kind = 'constructor';
  }
  return {owner, body:field(node,'body'), qualified, name, kind};
}

function callSpelling(node:Node):{name:string;qualifier:string;syntax:CodeCall['syntax']}|undefined {
  if (node.type === 'method_invocation') {
    const name = field(node,'name');
    const object = field(node,'object');
    if (name) return {name:name.text, qualifier:object?.text ?? '', syntax:object ? 'member' : 'direct'};
    return;
  }
  let callee = field(node,'function') ?? field(node,'constructor') ?? field(node,'type');
  if (!callee) return;
  const receiver = field(callee,'object') ?? field(callee,'argument');
  const qualifiers:string[] = [];
  while (callee?.type === 'qualified_identifier') {
    const scope = field(callee,'scope');
    if (scope) qualifiers.push(scope.text);
    callee = field(callee,'name');
  }
  if (receiver && callee) callee = field(callee,'field') ?? field(callee,'property') ?? field(callee,'attribute');
  if (callee?.type === 'template_method' || callee?.type === 'template_function') callee = field(callee,'name');
  if (!callee || !['identifier','field_identifier','property_identifier','type_identifier','operator_name','destructor_name'].includes(callee.type)) return;
  return {name:callee.text, qualifier:receiver?.text ?? qualifiers.join('::'), syntax:receiver ? 'member' : qualifiers.length ? 'scoped' : 'direct'};
}

function publicEntry(owner:Node, scope:Scope, file:string, lang:Language, name:string, signature:string) {
  if (lang === 'python') return !scope.name && !name.startsWith('_');
  if (lang === 'java') return /\bpublic\b/.test(signature);
  if (lang !== 'cpp' && lang !== 'c') return owner.parent?.type === 'export_statement' || owner.parent?.parent?.type === 'export_statement';
  if (!/\.h(?:h|pp|xx)?$/i.test(file)) return false;
  if (scope.kind !== 'class' && scope.kind !== 'struct') return !/\bstatic\b/.test(signature);
  for (let sibling=owner.previousNamedSibling; sibling; sibling=sibling.previousNamedSibling) {
    if (sibling.type === 'access_specifier') return sibling.text === 'public';
  }
  return scope.kind === 'struct';
}

function extract(tree:Parser.Tree, text:string, file:string, lang:Language, index:CodeIndex, namespaces:Set<string>) {
  const root = tree.rootNode;
  const packageName = lang === 'java' ? root.namedChildren.find(n => n.type === 'package_declaration')?.lastNamedChild?.text : '';
  const scopes:Scope[] = [{end:Infinity, name:packageName ?? ''}];
  // Native traversal returns only relevant nodes, in preorder. Ranges determine the lexical owner.
  for (const node of root.descendantsOfType(indexNodes)) {
    while (scopes.at(-1)!.end <= node.startIndex) scopes.pop();
    const scope = scopes.at(-1)!;
    if (node.type === 'namespace_definition' || node.type === 'internal_module') {
      const name = field(node,'name')?.text;
      const qualified = [scope.name,name].filter(Boolean).join(separator(lang));
      if (lang === 'cpp' && name) namespaces.add(qualified);
      scopes.push({end:node.endIndex, name:qualified});
    } else if (callNodes.has(node.type)) {
      if (!scope.caller) continue;
      const target = callSpelling(node);
      if (target) index.calls.push({caller_id:scope.caller, callee_name:target.name, qualifier:target.qualifier, syntax:target.syntax, file, line:node.startPosition.row+1, target_ids:[]});
    } else {
      const site = declaration(node,scope,lang);
      if (!site) continue;
      const {owner, body, qualified, name, kind} = site;
      const id = `${file}:${node.startPosition.row+1}:${node.startPosition.column+1}:${node.type}`;
      const signature = text.slice(owner.startIndex, Math.min(body?.startIndex ?? owner.endIndex, owner.startIndex+400)).replace(/\s+/g,' ').trim().slice(0,240);
      index.symbols.push({id,name,qualified_name:qualified,kind,file,start_line:owner.startPosition.row+1,end_line:owner.endPosition.row+1,
        signature,language:lang,has_body:!!body,public_entry:publicEntry(owner,scope,file,lang,name,signature)});
      scopes.push({end:node.endIndex,name:qualified,kind,caller:typeSymbol(kind) ? undefined : id});
    }
  }
}

const family = (lang:Language) => lang === 'c' ? 'cpp' : ['javascript','typescript','tsx'].includes(lang) ? 'js' : lang;
function resolveCalls(index:CodeIndex) {
  const byId = new Map(index.symbols.map(s => [s.id,s]));
  const names = new Map<string,CodeSymbol[]>();
  for (const s of index.symbols) {
    if (typeSymbol(s.kind)) continue;
    const key = family(s.language)+':'+s.name;
    const bucket = names.get(key) ?? [];
    bucket.push(s);
    names.set(key,bucket);
  }
  for (const call of index.calls) {
    const caller = byId.get(call.caller_id)!;
    const candidates = names.get(family(caller.language)+':'+call.callee_name) ?? [];
    const sep = separator(caller.language);
    const lexical = caller.qualified_name.split(sep).slice(0,-1);
    const ownMember = ['this','self','cls'].includes(call.qualifier);
    const receiver = ownMember ? '' : call.qualifier;
    const suffix = [receiver,call.callee_name].filter(Boolean).join(sep);
    let hits:CodeSymbol[] = [];
    // Walk outward through enclosing scopes before trying file and project-level names.
    for (let depth=lexical.length; depth>=0 && !hits.length; depth--) {
      const qualified = [...lexical.slice(0,depth),suffix].join(sep);
      if (qualified !== call.callee_name) hits = candidates.filter(s => s.qualified_name === qualified);
    }
    if (!hits.length) {
      // A C++ scoped call names its owner explicitly. Never bind ns::f() to an unrelated f().
      if (call.syntax === 'scoped' || ownMember) continue;
      const pool = receiver ? candidates.filter(s => s.kind !== 'function' ||
        ((caller.language === 'python' || family(caller.language) === 'js') && path.posix.parse(s.file).name === receiver)) : candidates;
      const local = pool.filter(s => s.file === caller.file);
      hits = local.length ? local : pool;
      if (new Set(hits.map(s=>s.qualified_name)).size > 1) hits = [];
    }
    if (!hits.length) continue;
    // A matching local prototype often names a definition in a different translation unit.
    const matchedNames = new Set(hits.map(s=>s.qualified_name));
    const definitions = candidates.filter(s=>s.has_body && matchedNames.has(s.qualified_name));
    const local = definitions.filter(s=>s.file === caller.file);
    const targets = local.length ? local : definitions.length ? definitions : hits;
    if (new Set(targets.map(s=>s.file)).size === 1) call.target_ids = targets.map(s=>s.id);
  }
}

function summarize(index:CodeIndex) {
  const modules = new Map<string,CodeModule>();
  for (const file of index.files) {
    const dir = path.posix.dirname(file);
    const module = modules.get(dir) ?? {dir, files:[], symbol_count:0, key_symbols:[]};
    module.files.push(file);
    modules.set(dir,module);
  }
  const byId = new Map(index.symbols.map(s => [s.id,s]));
  const incoming = new Map<string,number>();
  const edges = new Map<string,{from:string;to:string;count:number}>();
  for (const call of index.calls) {
    const from = path.posix.dirname(call.file);
    const destinations = new Set<string>();
    for (const id of call.target_ids) {
      incoming.set(id,(incoming.get(id) ?? 0)+1);
      destinations.add(path.posix.dirname(byId.get(id)!.file));
    }
    for (const to of destinations) {
      if (to === from) continue;
      const key = from+'\0'+to;
      const edge = edges.get(key) ?? {from,to,count:0};
      edge.count++;
      edges.set(key,edge);
    }
  }
  const apiKey = (s:CodeSymbol) => family(s.language)+':'+s.qualified_name;
  const publicNames = new Set(index.symbols.filter(s=>s.public_entry).map(apiKey));
  const rank = (s:CodeSymbol) => s.name === 'main' ? 2 : publicNames.has(apiKey(s)) ? 1 : 0;
  const ranked = [...index.symbols].sort((a,b) => rank(b)-rank(a) ||
    (incoming.get(b.id) ?? 0)-(incoming.get(a.id) ?? 0) || Number(b.has_body)-Number(a.has_body));
  for (const symbol of ranked) {
    const module = modules.get(path.posix.dirname(symbol.file))!;
    module.symbol_count++;
    if (module.key_symbols.length < 8 && !typeSymbol(symbol.kind) &&
        !module.key_symbols.some(id=>byId.get(id)!.qualified_name === symbol.qualified_name)) module.key_symbols.push(symbol.id);
  }
  index.modules = [...modules.values()];
  index.module_edges = [...edges.values()];
}

async function buildIndex(storage:string, snapshot:Snapshot):Promise<CodeIndex> {
  runtime ??= Parser.init({locateFile:(file:string)=>asset(file,'web-tree-sitter')});
  await runtime;
  const index:CodeIndex = {schema_version:version,snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,
    files:[],symbols:[],calls:[],modules:[],module_edges:[],parse_errors:[]};
  const hasCpp = snapshot.files.some(f=>extensions[path.extname(f.path).toLowerCase()] === 'cpp');
  const namespaces = new Set<string>();
  const parser = new Parser();
  try {
    for (const {path:file} of snapshot.files) {
      const ext = path.extname(file).toLowerCase();
      let lang = extensions[ext];
      if (!lang) continue;
      const source = await readSource(storage,snapshot,file);
      const text = source.text.replace(/\r\n?/g,'\n');
      if (ext === '.h' && (hasCpp || /\b(?:class|namespace|template)\b|::/.test(text))) lang = 'cpp';
      parser.setLanguage(await grammar(lang));
      let tree:Parser.Tree;
      try { tree = parser.parse(text); }
      catch (error) {
        index.parse_errors.push({file,reason:(error as Error).message});
        parser.reset();
        continue;
      }
      try {
        extract(tree,text,file,lang,index,namespaces);
        index.files.push(file);
        if (tree.rootNode.hasError) index.parse_errors.push({file,reason:'语法树含错误节点，已索引可识别部分'});
      } finally { tree.delete(); }
    }
  } finally { parser.delete(); }
  for (const s of index.symbols) {
    if (s.language === 'cpp' && s.kind === 'method' && namespaces.has(s.qualified_name.split('::').slice(0,-1).join('::'))) s.kind = 'function';
  }
  resolveCalls(index);
  summarize(index);
  return index;
}

export async function getCodeIndex(storage:string, snapshot:Snapshot):Promise<CodeIndex> {
  const id = relativePath(snapshot.source_snapshot_id);
  if (id.includes('/')) throw Error('快照 ID 必须为单一路径段');
  const directory = path.join(storage,'indexes'), cache = path.join(directory,id+'.json');
  try {
    const cached = JSON.parse(await fs.readFile(cache,'utf8')) as CodeIndex;
    if (cached?.schema_version === version && cached.snapshot_id === id && cached.fingerprint === snapshot.fingerprint) return cached;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const index = await buildIndex(storage,snapshot);
  await fs.mkdir(directory,{recursive:true});
  const temporary = cache+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,JSON.stringify(index),{flag:'wx'});
    await fs.rename(temporary,cache);
  } finally { await fs.rm(temporary,{force:true}); }
  return index;
}
