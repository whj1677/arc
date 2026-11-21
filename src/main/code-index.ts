import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import type {Snapshot} from '../shared';
import {readSource, relativePath} from './snapshot';

type Language = 'c'|'cpp'|'python'|'javascript'|'typescript'|'tsx'|'java';
type Kind = 'function'|'method'|'constructor'|'destructor'|'class'|'struct'|'interface'|'initializer';
type Node = Parser.SyntaxNode;
export interface CodeSymbol {
  id:string; name:string; qualified_name:string; kind:Kind; file:string; start_line:number; end_line:number;
  signature:string; language:Language; has_body:boolean; public_entry:boolean;
}
export interface CodeCall {
  caller_id:string; callee_name:string; qualifier:string; file:string; line:number; target_ids:string[];
  syntax:'direct'|'member'|'scoped'|'reference'|'indirect';
}
export interface CodeModule { dir:string; files:string[]; symbol_count:number; key_symbols:string[] }
export interface SharedState {name:string; file:string; line:number; access_dirs:string[]; location_kind?:'extern_declaration'}
export interface CodeIndex {
  schema_version:number; snapshot_id:string; fingerprint:string; files:string[]; symbols:CodeSymbol[]; calls:CodeCall[];
  modules:CodeModule[]; module_edges:{from:string;to:string;count:number}[]; shared_states:SharedState[]; parse_errors:{file:string;reason:string}[];
}
const version = 3;
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

interface Scope {
  end:number; name:string; kind?:Kind; caller?:CodeSymbol; bodyStart?:number;
  locals?:Map<string,number>; imports?:Map<string,string|null>; internal?:boolean;
}
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
  const absolute = callee.type === 'qualified_identifier' && !field(callee,'scope');
  const qualifiers:string[] = [];
  while (callee?.type === 'qualified_identifier') {
    const scope = field(callee,'scope');
    if (scope) qualifiers.push(scope.text);
    callee = field(callee,'name');
  }
  if (receiver && callee) callee = field(callee,'field') ?? field(callee,'property') ?? field(callee,'attribute');
  if (callee?.type === 'template_method' || callee?.type === 'template_function') callee = field(callee,'name');
  if (!callee || !['identifier','field_identifier','property_identifier','type_identifier','operator_name','destructor_name'].includes(callee.type)) return;
  return {name:callee.text, qualifier:receiver?.text ?? (absolute ? '::' : '') + qualifiers.join('::'),
    syntax:receiver ? 'member' : absolute || qualifiers.length ? 'scoped' : 'direct'};
}

const isHeader = (file:string) => /\.h(?:pp|h|xx)?$/i.test(file);
function publicEntry(owner:Node, scope:Scope, file:string, lang:Language, name:string, signature:string, isStatic:boolean) {
  if (lang === 'python') return !scope.name && !name.startsWith('_');
  if (lang === 'java') return /\bpublic\b/.test(signature);
  if (lang !== 'cpp' && lang !== 'c') return owner.parent?.type === 'export_statement' || owner.parent?.parent?.type === 'export_statement';
  if (!isHeader(file)) return false;
  if (scope.kind !== 'class' && scope.kind !== 'struct') return !isStatic;
  for (let sibling=owner.previousNamedSibling; sibling; sibling=sibling.previousNamedSibling) {
    if (sibling.type === 'access_specifier') return sibling.text === 'public';
  }
  return scope.kind === 'struct';
}

// Only value uses in an executable body or a file-scope initializer can be
// references. Delay matching names until later translation units are indexed.
interface ValueUse {caller:CodeSymbol; name:string; qualifier:string; line:number}
interface ImportedCall {qualifier:string|null; lexical:string; block:boolean}
interface CppFacts {
  uses:ValueUse[]; globals:Map<string,SharedState[]>; initializers:Map<string,CodeSymbol>; internal:Set<string>;
  imports:Map<CodeCall,ImportedCall>; members:Map<string,Set<string>>;
}
const statementScopes = new Set(['compound_statement','for_statement','for_range_loop','if_statement','while_statement','switch_statement']);
const cIndexNodes = [...indexNodes, 'declaration','parameter_declaration','init_declarator','identifier',
  ...statementScopes,'using_declaration','preproc_def','preproc_function_def'];

function objectName(declarator:Node) {
  let part:Node|null = declarator;
  while (part) {
    if (part.type === 'identifier' || part.type === 'qualified_identifier' || part.type === 'field_identifier') return part;
    const nested:Node|null = field(part,'declarator') ?? (['parenthesized_declarator','reference_declarator'].includes(part.type) ? part.lastNamedChild : null);
    if (part.type === 'function_declarator' && nested?.type !== 'parenthesized_declarator') return;
    part = nested;
  }
}

function shadow(scope:Scope, name:string, start=0) {
  (scope.locals ??= new Map()).set(name,start);
}

function isLocal(scope:Scope, name:string, at:number) {
  return (scope.locals?.get(name) ?? Infinity) <= at;
}

function directBinding(scopes:Scope[], namespaceImports:Map<string,Map<string,string|null>>, name:string, at:number):ImportedCall|'indirect'|undefined {
  for (let i=scopes.length-1; i>=0; i--) {
    const scope = scopes[i];
    if (!scope.kind && namespaceImports.size) break;
    if (isLocal(scope,name,at)) return 'indirect';
    const qualifier = scope.imports?.get(name);
    if (qualifier !== undefined) {
      return {qualifier,lexical:scope.caller ? scope.name.split('::').slice(0,-1).join('::') : scope.name,block:!!scope.caller};
    }
  }
  if (!namespaceImports.size) return;
  const owner = scopes.at(-1)!.name.split('::').slice(0,-1);
  for (let depth=owner.length; depth>=0; depth--) {
    const lexical = owner.slice(0,depth).join('::');
    if (scopes.some(scope=>!scope.kind && scope.name === lexical && isLocal(scope,name,at))) return 'indirect';
    const qualifier = namespaceImports.get(lexical)?.get(name);
    if (qualifier !== undefined) return {qualifier,lexical,block:false};
  }
}

// Recovery in a macro-heavy C file can put block locals under an ERROR at
// file level. Only declarations in real file/namespace/linkage scopes qualify.
function fileDeclaration(node:Node, text:string) {
  if (node.hasError && !/^\s*__attribute__\s*\(\(/.test(text.slice(node.endIndex))) return false;
  let parent = node.parent;
  while (parent && (parent.type.startsWith('preproc_') || ['namespace_definition','declaration_list','linkage_specification'].includes(parent.type))) {
    parent = parent.parent;
  }
  return parent?.type === 'translation_unit';
}

function inspectObject(node:Node, scope:Scope, file:string, facts:CppFacts) {
  let modifiers:string[]|undefined;
  for (const binding of node.childrenForFieldName('declarator')) {
    const nameNode = objectName(binding);
    if (!nameNode) continue;
    const name = nameNode.text;
    modifiers ??= node.namedChildren.filter(n=>n.type === 'storage_class_specifier' || n.type === 'type_qualifier').map(n=>n.text);
    const extern = modifiers.includes('extern') && binding.type !== 'init_declarator';
    if (scope.caller || scope.internal || modifiers.includes('static') || node.type === 'parameter_declaration') {
      if (!extern) shadow(scope,name);
    } else if (!scope.kind) {
      // A const/constexpr literal or array is configuration, not shared state.
      // Keep volatile hardware state and pointers/references to mutable objects.
      if (!modifiers.includes('volatile') && (modifiers.includes('const') || modifiers.includes('constexpr'))) {
        const decl = binding.type === 'init_declarator' ? field(binding,'declarator')! : binding;
        if (!/^[^\[]*[*&]/.test(decl.text)) continue;
      }
      const qualified = scope.name ? scope.name+'::'+name : name;
      const globals = facts.globals.get(qualified) ?? [];
      globals.push({name:qualified,file,line:nameNode.startPosition.row+1,access_dirs:[],...(extern ? {location_kind:'extern_declaration' as const} : {})});
      facts.globals.set(qualified,globals);
    }
  }
}

function valueName(node:Node, text:string, scopes:Scope[]) {
  const name = text.slice(node.startIndex,node.endIndex);
  let expression = node;
  let parent = node.parent;
  if (parent?.type !== 'qualified_identifier' && scopes.some(s=>isLocal(s,name,node.startIndex))) return;
  while (parent?.type === 'qualified_identifier') { expression = parent; parent = parent.parent; }
  const context = parent?.type;
  if (!context || !(context.endsWith('_expression') || ['argument_list','initializer_list','initializer_pair',
    'return_statement','condition_clause','subscript_argument_list','init_declarator'].includes(context))) return;
  if (context === 'init_declarator' && field(parent!,'value')?.id !== expression.id) return;
  const qualifier = expression === node ? '' : text.slice(expression.startIndex,node.startIndex).replace(/\s+/g,'');
  if (qualifier && !/^(?:::)?(?:\w+::)*$/.test(qualifier)) return;
  return {name,qualifier:qualifier === '::' ? '::' : qualifier.replace(/::$/,'')};
}

function extract(tree:Parser.Tree, text:string, file:string, lang:Language, index:CodeIndex, namespaces:Set<string>, facts:CppFacts) {
  const root = tree.rootNode;
  const cpp = lang === 'c' || lang === 'cpp';
  const packageName = lang === 'java' ? root.namedChildren.find(n => n.type === 'package_declaration')?.lastNamedChild?.text : '';
  const scopes:Scope[] = [{end:Infinity, name:packageName ?? ''}];
  const namespaceImports = new Map<string,Map<string,string|null>>();
  let calleeEnd = -1;
  // Native traversal returns only relevant nodes, in preorder. Ranges determine the lexical owner.
  for (const node of root.descendantsOfType(cpp ? cIndexNodes : indexNodes)) {
    while (scopes.at(-1)!.end <= node.startIndex) scopes.pop();
    const scope = scopes.at(-1)!;
    const type = node.type;
    if (type === 'identifier') {
      if (!scope.caller || node.startIndex < scope.bodyStart! || node.startIndex < calleeEnd) continue;
      const value = valueName(node,text,scopes);
      if (value) facts.uses.push({caller:scope.caller,...value,line:node.startPosition.row+1});
    } else if (type === 'declaration' || type === 'parameter_declaration') {
      if (scope.caller || scope.kind || fileDeclaration(node,text)) inspectObject(node,scope,file,facts);
    } else if (type.startsWith('preproc_')) {
      const name = field(node,'name');
      if (name) shadow(scopes[0],name.text);
    } else if (statementScopes.has(type)) {
      const nested:Scope = {...scope,end:node.endIndex,locals:undefined,imports:undefined};
      scopes.push(nested);
      if (type === 'for_range_loop') {
        const declarator = field(node,'declarator'), body = field(node,'body');
        const binding = declarator && objectName(declarator);
        if (body) {
          const names = binding ? [binding] : declarator?.descendantsOfType('structured_binding_declarator')[0]?.namedChildren ?? [];
          for (const name of names) shadow(nested,name.text,body.startIndex);
        }
      }
    } else if (type === 'using_declaration') {
      const target = node.lastNamedChild;
      if (target?.type !== 'qualified_identifier' || node.children.some(child=>child.type === 'namespace' || child.type === 'enum')) continue;
      const qualified = target.text.replace(/\s+/g,'');
      const split = qualified.lastIndexOf('::');
      const qualifier = qualified.slice(0,split) || '::', name = qualified.slice(split+2);
      const imports = scope.kind ? scope.imports ??= new Map() : namespaceImports.get(scope.name) ?? new Map();
      if (!scope.kind) namespaceImports.set(scope.name,imports);
      imports.set(name,!imports.has(name) || imports.get(name) === qualifier ? qualifier : null);
    } else if (type === 'init_declarator') {
      if (scope.caller || scope.kind || !fileDeclaration(node.parent!,text)) continue;
      const binding = objectName(node), value = field(node,'value');
      if (!binding || !value || (!value.namedChildCount && value.type !== 'identifier')) continue;
      const name = binding.text, qualified = scope.name ? scope.name+'::'+name : name;
      const line = binding.startPosition.row+1, id = `${file}:${line}:${binding.startPosition.column+1}:initializer`;
      const start = node.parent!.startIndex;
      const symbol:CodeSymbol = {id,name,qualified_name:qualified,kind:'initializer',file,start_line:line,end_line:node.endPosition.row+1,
        signature:text.slice(start,Math.min(value.startIndex,start+240)).replace(/\s+/g,' ').trim(),language:lang,has_body:false,public_entry:false};
      facts.initializers.set(id,symbol);
      scopes.push({end:node.endIndex,name:qualified,kind:'initializer',caller:symbol,bodyStart:value.startIndex});
    } else if (type === 'namespace_definition' || type === 'internal_module') {
      const name = field(node,'name')?.text;
      const qualified = [scope.name,name].filter(Boolean).join(separator(lang));
      if (lang === 'cpp' && name) namespaces.add(qualified);
      scopes.push({end:node.endIndex, name:qualified,internal:scope.internal || !name});
    } else if (callNodes.has(type)) {
      if (!scope.caller) continue;
      const target = callSpelling(node);
      if (cpp) {
        const callee = field(node,'function');
        if (callee && ['identifier','qualified_identifier','parenthesized_expression','template_function'].includes(callee.type)) calleeEnd = callee.endIndex;
      }
      if (target && scope.kind !== 'initializer') {
        const binding = cpp && target.syntax === 'direct' ? directBinding(scopes,namespaceImports,target.name,node.startIndex) : undefined;
        const call:CodeCall = {caller_id:scope.caller.id,callee_name:target.name,qualifier:target.qualifier,
          syntax:binding === 'indirect' ? binding : target.syntax,file,line:node.startPosition.row+1,target_ids:[]};
        if (binding && binding !== 'indirect') facts.imports.set(call,binding);
        index.calls.push(call);
      }
    } else {
      const site = declaration(node,scope,lang);
      if (!site) continue;
      const {owner, body, qualified, name, kind} = site;
      const id = `${file}:${node.startPosition.row+1}:${node.startPosition.column+1}:${node.type}`;
      const signature = text.slice(owner.startIndex, Math.min(body?.startIndex ?? owner.endIndex, owner.startIndex+400)).replace(/\s+/g,' ').trim().slice(0,240);
      const isStatic = cpp && owner.namedChildren.some(child=>child.type === 'storage_class_specifier' && child.text === 'static');
      const symbol:CodeSymbol = {id,name,qualified_name:qualified,kind,file,start_line:owner.startPosition.row+1,end_line:owner.endPosition.row+1,
        signature,language:lang,has_body:!!body,public_entry:publicEntry(owner,scope,file,lang,name,signature,isStatic)};
      index.symbols.push(symbol);
      // A static inline function in a header can belong to a consumer's translation unit.
      if (cpp && (scope.internal || (kind === 'function' && !isHeader(file) && isStatic))) facts.internal.add(id);
      if (lang === 'cpp' && (kind === 'class' || kind === 'struct')) {
        const members = facts.members.get(qualified) ?? new Set<string>();
        for (const member of body!.descendantsOfType('field_declaration')) {
          let parent = member.parent;
          while (parent?.type.startsWith('preproc_')) parent = parent.parent;
          if (parent?.id !== body!.id) continue;
          for (const declarator of member.childrenForFieldName('declarator')) {
            const binding = objectName(declarator);
            if (binding?.type === 'field_identifier') members.add(binding.text);
          }
        }
        facts.members.set(qualified,members);
      }
      scopes.push({end:node.endIndex,name:qualified,kind,caller:typeSymbol(kind) ? undefined : symbol,bodyStart:body?.startIndex ?? Infinity,internal:scope.internal});
    }
  }
}

const family = (lang:Language) => lang === 'c' ? 'cpp' : ['javascript','typescript','tsx'].includes(lang) ? 'js' : lang;
function resolveCalls(index:CodeIndex, facts:CppFacts) {
  const byId = new Map(index.symbols.map(s => [s.id,s]));
  const names = new Map<string,CodeSymbol[]>();
  for (const s of index.symbols) {
    if (typeSymbol(s.kind)) continue;
    const key = family(s.language)+':'+s.name;
    const bucket = names.get(key) ?? [];
    bucket.push(s);
    names.set(key,bucket);
  }
  const globalNames = new Set([...facts.globals.keys()].map(name=>name.split('::').at(-1)!));
  const locations = new Map<string,SharedState|undefined>();
  for (const [name,sites] of facts.globals) {
    const definitions = sites.filter(s=>!s.location_kind);
    const declaration = sites.find(s=>/\.h(?:pp|h|xx)?$/i.test(s.file)) ?? sites[0];
    locations.set(name,definitions.length === 0 ? declaration : definitions.length === 1 ? definitions[0] : undefined);
  }
  const accesses = new Map<SharedState,Set<string>>();
  for (const use of facts.uses) {
    const {caller,name,qualifier,line} = use;
    const callable = names.has('cpp:'+name), global = globalNames.has(name);
    if (!callable && !global) continue;
    const scope = caller.qualified_name.split('::').slice(0,-1);
    if (!qualifier && facts.members.get(scope.join('::'))?.has(name)) continue;
    if (callable) {
      index.calls.push({caller_id:caller.id,callee_name:name,qualifier,syntax:'reference',file:caller.file,line,target_ids:[]});
    }
    if (!global) continue;
    if (qualifier.startsWith('::')) scope.length = 0;
    const suffix = [qualifier.replace(/^::/,''),name].filter(Boolean).join('::');
    for (let depth=scope.length; depth>=0; depth--) {
      const qualified = [...scope.slice(0,depth),suffix].join('::');
      if (!locations.has(qualified)) continue;
      const state = locations.get(qualified);
      if (state) {
        const dirs = accesses.get(state) ?? new Set();
        dirs.add(path.posix.dirname(caller.file));
        accesses.set(state,dirs);
      }
      break;
    }
  }
  index.shared_states = [...accesses].filter(([,dirs])=>dirs.size >= 2)
    .map(([state,dirs])=>({...state,access_dirs:[...dirs].sort()}))
    .sort((a,b)=>b.access_dirs.length-a.access_dirs.length || a.name.localeCompare(b.name)).slice(0,64);
  const usedInitializers = new Set<string>();
  const references = new Set<CodeCall>();
  for (const call of index.calls) {
    if (call.syntax === 'indirect') continue;
    const caller = byId.get(call.caller_id) ?? facts.initializers.get(call.caller_id)!;
    let candidates = names.get(family(caller.language)+':'+call.callee_name) ?? [];
    if (caller.language === 'c' || caller.language === 'cpp') candidates = candidates.filter(s=>s.file === caller.file || !facts.internal.has(s.id));
    if (!candidates.length) continue;
    const sep = separator(caller.language);
    let imported = facts.imports.get(call);
    const owner = caller.qualified_name.split(sep).slice(0,-1);
    if (imported && !imported.block) {
      const importedDepth = imported.lexical ? imported.lexical.split(sep).length : 0;
      for (let depth=owner.length; depth>importedDepth; depth--) {
        const qualified = [...owner.slice(0,depth),call.callee_name].join(sep);
        if (candidates.some(s=>s.qualified_name === qualified)) { imported = undefined; break; }
      }
    }
    if (imported?.qualifier === null) continue;
    const qualifier = imported?.qualifier ?? call.qualifier;
    const lexical = imported ? imported.lexical.split(sep).filter(Boolean) : owner;
    const ownMember = ['this','self','cls'].includes(call.qualifier);
    const receiver = ownMember ? '' : qualifier.replace(/^::/,'');
    const suffix = [receiver,call.callee_name].filter(Boolean).join(sep);
    let hits:CodeSymbol[] = [];
    // Walk outward through enclosing scopes before trying file and project-level names.
    for (let depth=qualifier.startsWith('::') ? 0 : lexical.length; depth>=0 && !hits.length; depth--) {
      const qualified = [...lexical.slice(0,depth),suffix].join(sep);
      if (qualifier === '::' || imported || qualified !== call.callee_name) hits = candidates.filter(s => s.qualified_name === qualified);
    }
    if (!hits.length) {
      // A C++ scoped call names its owner explicitly. Never bind ns::f() to an unrelated f().
      if (imported || call.syntax === 'scoped' || ownMember || (call.syntax === 'reference' && receiver)) continue;
      const exactFreeName = call.syntax === 'reference' || (call.syntax === 'direct' && (caller.language === 'c' || caller.language === 'cpp'));
      const pool = exactFreeName ? candidates.filter(s=>s.qualified_name === call.callee_name) : receiver ? candidates.filter(s => s.kind !== 'function' ||
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
    // An overload can leave the target unresolved while the registration site is still known.
    if (call.syntax === 'reference') {
      references.add(call);
      if (caller.kind === 'initializer') usedInitializers.add(caller.id);
    }
    if (new Set(targets.map(s=>s.file)).size === 1 && ((!imported && call.syntax !== 'reference') || targets.length === 1)) {
      call.target_ids = targets.map(s=>s.id);
    }
  }
  index.calls = index.calls.filter(call=>call.syntax !== 'reference' || references.has(call));
  for (const id of usedInitializers) index.symbols.push(facts.initializers.get(id)!);
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

async function* indexSources(storage:string, snapshot:Snapshot) {
  const files = snapshot.files.filter(file=>extensions[path.extname(file.path).toLowerCase()]);
  // Bound the decoded text held at once; each read still verifies its frozen hash and path.
  for (let start=0; start<files.length; start+=16) {
    yield* await Promise.all(files.slice(start,start+16).map(file=>readSource(storage,snapshot,file.path)));
  }
}

async function buildIndex(storage:string, snapshot:Snapshot):Promise<CodeIndex> {
  runtime ??= Parser.init({locateFile:(file:string)=>asset(file,'web-tree-sitter')});
  await runtime;
  const index:CodeIndex = {schema_version:version,snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,
    files:[],symbols:[],calls:[],modules:[],module_edges:[],shared_states:[],parse_errors:[]};
  const hasCpp = snapshot.files.some(f=>extensions[path.extname(f.path).toLowerCase()] === 'cpp');
  const namespaces = new Set<string>();
  const facts:CppFacts = {uses:[],globals:new Map(),initializers:new Map(),internal:new Set(),imports:new Map(),members:new Map()};
  const parser = new Parser();
  try {
    for await (const source of indexSources(storage,snapshot)) {
      const file = source.path;
      const ext = path.extname(file).toLowerCase();
      let lang = extensions[ext];
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
        extract(tree,text,file,lang,index,namespaces,facts);
        index.files.push(file);
        if (tree.rootNode.hasError) index.parse_errors.push({file,reason:'语法树含错误节点，已索引可识别部分'});
      } finally { tree.delete(); }
    }
  } finally { parser.delete(); }
  for (const s of index.symbols) {
    if (s.language === 'cpp' && s.kind === 'method' && namespaces.has(s.qualified_name.split('::').slice(0,-1).join('::'))) s.kind = 'function';
  }
  resolveCalls(index,facts);
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
