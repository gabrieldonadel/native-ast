'use strict';

const path = require('path');
const LANGUAGES = require('./languages.js');

/* ------------------------------------------------------------------ parsers */

const PARSERS = {};          // language id -> tree-sitter parser
const WASM = {
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
};
const NATIVE = {
  swift: 'tree-sitter-swift',
  kotlin: '@tree-sitter-grammars/tree-sitter-kotlin',
};

function setParser(lang, parser) { PARSERS[lang] = parser; }

function nativeParser(lang) {
  const Parser = require('tree-sitter');
  const p = new Parser();
  p.setLanguage(require(NATIVE[lang]));
  return p;
}

async function wasmParser(lang, wasmPath) {
  const file = wasmPath ?? path.join(__dirname, '..', WASM[lang]);
  // The .wasm files ship in the npm tarball but are not in git — they are
  // build output. In a source checkout they have to be built first.
  if (!require('fs').existsSync(file)) {
    throw new Error(
      `${WASM[lang]} not found.\n` +
        `It is build output, not checked into git. To build it:\n` +
        `  git submodule update --init --recursive\n` +
        `  source /path/to/emsdk/emsdk_env.sh\n` +
        `  npm run build:wasm\n` +
        `(installing the package from npm gives you a prebuilt copy instead)`
    );
  }
  const { Parser, Language } = require('web-tree-sitter');
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Language.load(file));
  return p;
}

/** Load every language on one backend. `backend` is 'native' or 'wasm'. */
async function useBackend(backend, langs = ['swift', 'kotlin']) {
  for (const lang of langs) {
    setParser(lang, backend === 'wasm' ? await wasmParser(lang) : nativeParser(lang));
  }
}

/* -------------------------------------------------------------------- edits */

/** A pending text splice. Applied right-to-left so offsets stay valid. */
class Edits {
  constructor() { this.list = []; }
  replace(start, end, text) { this.list.push({ start, end, text }); return this; }
  insert(at, text) { return this.replace(at, at, text); }
  get length() { return this.list.length; }
  apply(src) {
    const sorted = [...this.list].sort((a, b) => b.start - a.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].end > sorted[i - 1].start) {
        throw new Error(`Overlapping edits at ${sorted[i].start}..${sorted[i].end}`);
      }
    }
    let out = src;
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  }
}

function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) walk(child, visit);
}

/* ---------------------------------------------------------------- functions */

class SourceFunction {
  constructor(file, node) { this.file = file; this.node = node; this.L = file.L; }

  get name() { return this.L.functionName(this.node); }
  get selector() { return this.L.selector(this.node); }
  get body() { return this.L.functionBody(this.node); }
  get text() { return this.node.text; }

  get modifiers() {
    const m = this.node.namedChildren.find((c) => c.type === 'modifiers');
    return m ? m.text.split(/\s+/).filter(Boolean) : [];
  }

  /** The declaration parsed with no ERROR or MISSING node anywhere inside. */
  get isWellFormed() {
    let ok = true;
    walk(this.node, (n) => { if (n.type === 'ERROR' || n.isMissing) { ok = false; return false; } });
    return ok;
  }

  parameter(nameOrLabel) {
    return this.L.parameters(this.node).find(
      (p) => this.L.parameterLabel(p) === nameOrLabel || this.L.parameterName(p) === nameOrLabel
    ) ?? null;
  }

  /** Resolve the real local name of a parameter, whatever the author called it. */
  parameterNameFor(label, fallback) {
    const p = this.parameter(label);
    return (p && this.L.parameterName(p)) || fallback;
  }

  addModifier(mod) {
    if (this.modifiers.includes(mod)) return this;                  // idempotent
    const existing = this.node.namedChildren.find((c) => c.type === 'modifiers');
    this.file.edits.insert((existing ?? this.node).startIndex, `${mod} `);
    return this;
  }

  /** Return statements belonging to this function, not to nested closures. */
  returnStatements() {
    const body = this.body;
    if (!body) return [];
    const out = [];
    walk(body, (n) => {
      if (n !== body && this.L.opaqueInFunction.includes(n.type)) return false;
      if (this.L.isReturn(n)) out.push(n);
    });
    return out;
  }

  replaceReturnValue(newExpr) {
    for (const r of this.returnStatements()) {
      const value = r.namedChildren[r.namedChildren.length - 1];
      if (!value || value.text === newExpr) continue;               // idempotent
      this.file.edits.replace(value.startIndex, value.endIndex, newExpr);
    }
    return this;
  }

  /** Top-level statements of this function's body, excluding nested closures. */
  statements() {
    const body = this.body;
    if (!body) return [];
    const stmts = body.namedChildren.find((c) => c.type === 'statements') ?? body;
    return stmts.namedChildren.filter((c) => c.type !== 'comment');
  }

  /**
   * Remove whole statements matching `predicate`, taking each line with them.
   * Consecutive matches are removed as one range, and if that leaves two blank
   * lines back to back one is taken too — so deleting statements does not
   * reformat the surrounding code.
   */
  removeStatements(predicate) {
    const stmts = this.statements();
    const src = this.file.source;

    // Group runs of consecutive matching statements.
    const groups = [];
    for (let i = 0; i < stmts.length; i++) {
      if (!predicate(stmts[i])) continue;
      const group = [stmts[i]];
      while (i + 1 < stmts.length && predicate(stmts[i + 1])) group.push(stmts[++i]);
      groups.push(group);
    }

    for (const group of groups) {
      const first = group[0], last = group[group.length - 1];
      const start = src.lastIndexOf('\n', first.startIndex - 1) + 1;
      let end = last.endIndex;
      while (end < src.length && src[end] !== '\n') end++;
      if (end < src.length) end++;

      const prevLineStart = src.lastIndexOf('\n', start - 2) + 1;
      const prevBlank = start === 0 || src.slice(prevLineStart, start - 1).trim() === '';
      let nextEnd = end;
      while (nextEnd < src.length && src[nextEnd] !== '\n') nextEnd++;
      const nextBlank = end < src.length && src.slice(end, nextEnd).trim() === '';
      if (prevBlank && nextBlank) end = nextEnd + 1;

      this.file.edits.replace(start, end, '');
    }
    return this;
  }

  prependStatement(code) {
    const body = this.body;
    if (!body) throw new Error(`${this.selector} has no body`);
    if (body.text.includes(code)) return this;                      // idempotent
    const indent = this.file.indentOf(body.namedChildren[0] ?? body);
    this.file.edits.insert(body.startIndex + 1, `\n${indent}${code}`);
    return this;
  }

  insertBeforeLastReturn(code) {
    const returns = this.returnStatements();
    const last = returns[returns.length - 1];
    if (!last) throw new Error(`${this.selector} has no return statement`);
    if (this.body.text.includes(code)) return this;                 // idempotent
    this.file.edits.insert(last.startIndex, `${code}\n${this.file.indentOf(last)}`);
    return this;
  }
}

/* -------------------------------------------------------------------- types */

class SourceType {
  constructor(file, node) { this.file = file; this.node = node; this.L = file.L; }

  get name() { return this.L.typeName(this.node); }
  get kind() { return this.node.firstChild?.text; }
  get body() { return this.L.typeBody(this.node); }
  get supertypes() { return this.L.supertypes(this.node).map((s) => this.L.supertypeName(s)); }

  get isWellFormed() {
    let ok = true;
    walk(this.node, (n) => { if (n.type === 'ERROR' || n.isMissing) { ok = false; return false; } });
    return ok;
  }

  functions() {
    const body = this.body;
    if (!body) return [];
    const out = [];
    walk(body, (n) => {
      if (this.L.functionNodes.includes(n.type)) { out.push(new SourceFunction(this.file, n)); return false; }
    });
    return out;
  }

  func(selector) {
    return this.functions().find((f) => f.selector === selector)
        ?? this.functions().find((f) => f.name === selector)
        ?? null;
  }

  /**
   * Make `to` the first supertype, dropping `replacing` and the current first.
   * `class A : UIResponder, UIApplicationDelegate, Extra` -> `class A : ExpoAppDelegate, Extra`.
   * Kotlin supertype text keeps its constructor call, so pass `to` with parens
   * if the target needs them.
   */
  setSupertype(to, { replacing = [] } = {}) {
    const specs = this.L.supertypes(this.node);
    if (specs.length === 0) throw new Error(`${this.name} has no supertype clause`);
    const names = specs.map((s) => this.L.supertypeName(s));
    const bare = to.replace(/\s*\(.*\)\s*$/s, '').trim();
    if (names[0] === bare) return this;                             // idempotent
    const drop = new Set([...replacing, names[0]]);
    const kept = specs.filter((s) => !drop.has(this.L.supertypeName(s)));
    this.file.edits.replace(
      specs[0].startIndex,
      specs[specs.length - 1].endIndex,
      [to, ...kept.map((s) => s.text)].join(', ')
    );
    return this;
  }

  /** Append a supertype, keeping the existing ones. */
  addSupertype(name) {
    const specs = this.L.supertypes(this.node);
    if (specs.length === 0) throw new Error(`${this.name} has no supertype clause`);
    const bare = name.replace(/\s*\(.*\)\s*$/s, '').trim();
    if (specs.map((s) => this.L.supertypeName(s)).includes(bare)) return this;   // idempotent
    this.file.edits.insert(specs[specs.length - 1].endIndex, `, ${name}`);
    return this;
  }

  /** Remove a supertype if present. */
  removeSupertype(name) {
    const specs = this.L.supertypes(this.node);
    const idx = specs.findIndex((s) => this.L.supertypeName(s) === name);
    if (idx < 0) return this;                                       // idempotent
    const spec = specs[idx];
    // Take the preceding comma when there is one, otherwise the following.
    const start = idx > 0 ? specs[idx - 1].endIndex : spec.startIndex;
    const end = idx > 0 ? spec.endIndex : (specs[idx + 1] ? specs[idx + 1].startIndex : spec.endIndex);
    this.file.edits.replace(start, end, '');
    return this;
  }

  appendMember(code) {
    const body = this.body;
    if (!body) throw new Error(`${this.name} has no body`);
    if (body.text.includes(code.trim())) return this;               // idempotent
    this.file.edits.insert(body.lastChild.startIndex, `${code}\n`);
    return this;
  }
}

/* --------------------------------------------------------------------- file */

class SourceFile {
  constructor(source, lang) {
    this.lang = lang;
    this.L = LANGUAGES[lang];
    if (!this.L) throw new Error(`unknown language: ${lang}`);
    if (!PARSERS[lang]) PARSERS[lang] = nativeParser(lang);
    this.source = source;
    this.tree = PARSERS[lang].parse(source);
    this.edits = new Edits();
  }

  /** Leading whitespace of the line the node starts on. */
  indentOf(node) {
    const lineStart = this.source.lastIndexOf('\n', node.startIndex - 1) + 1;
    return this.source.slice(lineStart, node.startIndex).match(/^[ \t]*/)[0];
  }

  get hasParseErrors() { return this.tree.rootNode.hasError; }

  /** Regions the grammar could not parse. Let a plugin fail loudly, not silently. */
  errorRegions() {
    const out = [];
    walk(this.tree.rootNode, (n) => {
      if (n.type === 'ERROR' || n.isMissing) {
        out.push({
          line: n.startPosition.row + 1,
          endLine: n.endPosition.row + 1,
          kind: n.isMissing ? 'missing' : 'error',
          text: n.text,
        });
        return false;
      }
    });
    return out;
  }

  imports() {
    return this.tree.rootNode.namedChildren
      .filter((c) => this.L.importNodes.includes(c.type))
      .map((c) => ({ node: c, module: this.L.importModule(c) }));
  }

  addImport(module, opts = {}) {
    const statement = this.L.renderImport(module, opts);
    const existing = this.imports().find((i) => i.module === module);
    if (existing) {
      if (existing.node.text !== statement) {
        this.edits.replace(existing.node.startIndex, existing.node.endIndex, statement);
      }
      return this;                                                  // idempotent
    }
    const all = this.imports();
    if (all.length) {
      this.edits.insert(all[all.length - 1].node.endIndex, `\n${statement}`);
    } else {
      // No imports yet: go after the package header if there is one.
      const pkg = this.tree.rootNode.namedChildren.find((c) => c.type === 'package_header');
      const anchor = pkg ?? this.tree.rootNode.namedChildren[0];
      if (pkg) this.edits.insert(anchor.endIndex, `\n\n${statement}`);
      else this.edits.insert(anchor.startIndex, `${statement}\n\n`);
    }
    return this;
  }

  types() {
    const out = [];
    walk(this.tree.rootNode, (n) => {
      if (this.L.typeNodes.includes(n.type)) out.push(new SourceType(this, n));
    });
    return out;
  }

  type(name) { return this.types().find((t) => t.name === name) ?? null; }

  functions() {
    const out = [];
    walk(this.tree.rootNode, (n) => {
      if (this.L.functionNodes.includes(n.type)) out.push(new SourceFunction(this, n));
    });
    return out;
  }

  func(selector) {
    return this.functions().find((f) => f.selector === selector)
        ?? this.functions().find((f) => f.name === selector)
        ?? null;
  }

  /** Apply all queued edits. Formatting outside the edited spans is untouched. */
  toString() { return this.edits.apply(this.source); }
}

const parseSwift = (source) => new SourceFile(source, 'swift');
const parseKotlin = (source) => new SourceFile(source, 'kotlin');
const parseFile = (source, filename) => {
  const ext = path.extname(filename);
  for (const [id, L] of Object.entries(LANGUAGES)) {
    if (L.extensions.includes(ext)) return new SourceFile(source, id);
  }
  throw new Error(`no adapter for ${ext}`);
};

module.exports = {
  parseSwift, parseKotlin, parseFile,
  SourceFile, SourceType, SourceFunction, Edits, walk,
  setParser, nativeParser, wasmParser, useBackend,
  LANGUAGES,
};
