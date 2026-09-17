'use strict';

/**
 * Per-language adapters. The traversal and edit engine in `core.js` is
 * language-agnostic; everything that differs between Swift and Kotlin lives
 * here, because the two grammars name and shape their nodes differently.
 *
 *   Swift   class_declaration -> field `name`, field `body`, inheritance_specifier
 *   Kotlin  class_declaration -> field `name`, child class_body, delegation_specifiers
 */

const swift = {
  id: 'swift',
  extensions: ['.swift'],

  importNodes: ['import_declaration'],
  typeNodes: ['class_declaration', 'protocol_declaration'],
  functionNodes: ['function_declaration'],
  // Nodes we must not descend into when collecting a function's own returns.
  opaqueInFunction: ['function_declaration', 'lambda_literal'],
  returnNode: 'control_transfer_statement',
  isReturn: (n) => n.type === 'control_transfer_statement' && n.firstChild?.text === 'return',

  importModule: (n) =>
    n.childForFieldName('module')?.text ?? n.namedChildren[n.namedChildren.length - 1]?.text,
  renderImport: (mod, { access } = {}) => `${access ? `${access} ` : ''}import ${mod}`,

  typeName: (n) => n.childForFieldName('name')?.text,
  typeBody: (n) => n.childForFieldName('body'),
  supertypes: (n) => n.namedChildren.filter((c) => c.type === 'inheritance_specifier'),
  supertypeName: (n) => n.childForFieldName('inherits_from')?.text,

  functionName: (n) => n.childForFieldName('name')?.text,
  functionBody: (n) => n.childForFieldName('body'),
  parameters: (n) => n.namedChildren.filter((c) => c.type === 'parameter'),
  /** Swift selectors carry argument labels: `application(_:didFinishLaunchingWithOptions:)`. */
  selector(n) {
    const name = this.functionName(n);
    if (!name) return null;
    const labels = this.parameters(n).map(
      (p) => p.childForFieldName('external_name')?.text ?? p.childForFieldName('name')?.text ?? '_'
    );
    return `${name}(${labels.map((l) => `${l}:`).join('')})`;
  },
  parameterName: (p) => p.childForFieldName('name')?.text,
  parameterLabel: (p) => p.childForFieldName('external_name')?.text,
};

const kotlin = {
  id: 'kotlin',
  extensions: ['.kt', '.kts'],

  importNodes: ['import'],
  typeNodes: ['class_declaration', 'object_declaration'],
  functionNodes: ['function_declaration'],
  opaqueInFunction: ['function_declaration', 'lambda_literal', 'anonymous_function'],
  returnNode: 'jump_expression',
  isReturn: (n) => n.type === 'jump_expression' && n.firstChild?.text === 'return',

  importModule: (n) => n.namedChildren.find((c) => c.type === 'qualified_identifier')?.text,
  // Kotlin has no access modifier on imports; `access` is accepted and ignored.
  renderImport: (mod) => `import ${mod}`,

  typeName: (n) => n.childForFieldName('name')?.text,
  typeBody: (n) =>
    n.namedChildren.find((c) => c.type === 'class_body' || c.type === 'enum_class_body'),
  supertypes: (n) => {
    const specs = n.namedChildren.find((c) => c.type === 'delegation_specifiers');
    return specs ? specs.namedChildren.filter((c) => c.type === 'delegation_specifier') : [];
  },
  /** `ReactActivity()` -> `ReactActivity`. Strips the constructor call. */
  supertypeName: (n) => n.text.replace(/\s*\(.*\)\s*$/s, '').trim(),

  functionName: (n) => n.childForFieldName('name')?.text,
  functionBody: (n) => n.namedChildren.find((c) => c.type === 'function_body'),
  parameters: (n) => {
    const params = n.namedChildren.find((c) => c.type === 'function_value_parameters');
    return params ? params.namedChildren.filter((c) => c.type === 'parameter') : [];
  },
  /**
   * Kotlin has no argument labels, so a selector is the name plus parameter
   * types: `onCreate(Bundle?)`. Overloads differ by type, not by label.
   */
  selector(n) {
    const name = this.functionName(n);
    if (!name) return null;
    const types = this.parameters(n).map((p) => {
      const t = p.namedChildren[p.namedChildren.length - 1];
      return t && t !== p.childForFieldName('name') ? t.text.replace(/\s+/g, '') : '_';
    });
    return `${name}(${types.join(',')})`;
  },
  parameterName: (p) => p.childForFieldName('name')?.text ?? p.namedChildren[0]?.text,
  parameterLabel: () => undefined,
};

module.exports = { swift, kotlin };
