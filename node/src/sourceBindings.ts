import { parseSync } from './parse.ts';

/** Static source identities. No program values or expressions are evaluated here. */
export interface SourceBindings {
  scopes: { start: number; end: number; parent: number; names: string[]; function?: boolean; pending?: { name: string; until: number }[] }[];
  references: { start: number; end: number; name: string; scope: number; path: string[] }[];
}

export function sourceBindings(source: string, filename = 'x.ts'): SourceBindings {
  const parsed = parseSync(filename, source, { sourceType: 'unambiguous', lang: /\.[cm]?jsx?$/.test(filename) ? 'js' : 'ts' });
  if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
  const scopes: SourceBindings['scopes'] = [{ start: 0, end: source.length, parent: -1, names: [] }];
  const references: SourceBindings['references'] = [];
  const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  const functionScopes = new Set([0]);
  const bind = (n: any, scope: number): void => {
    if (!n) return;
    if (n.type === 'Identifier') { scopes[scope]!.names.push(n.name); }
    else if (n.type === 'AssignmentPattern') bind(n.left, scope);
    else if (n.type === 'RestElement') bind(n.argument, scope);
    else if (n.type === 'ObjectPattern') for (const p of n.properties) bind(p.type === 'RestElement' ? p.argument : p.value, scope);
    else if (n.type === 'ArrayPattern') for (const e of n.elements) bind(e, scope);
  };
  const visit = (n: any, scope: number, parent?: any, key?: string, path: string[] = []): void => {
    if (!n || typeof n.type !== 'string') return;
    if (['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSInstantiationExpression'].includes(n.type)) { visit(n.expression, scope, parent, key, path); return; }
    if (n.type.startsWith('TS')) return;
    if (functions.has(n.type)) {
      if (n.type === 'FunctionDeclaration') bind(n.id, scope);
      const child = scopes.length;
      scopes.push({ start: n.start, end: n.end, parent: scope, names: [], function: true });
      functionScopes.add(child);
      if (n.type === 'FunctionExpression') bind(n.id, child);
      for (const p of n.params) bind(p, child);
      scope = child;
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement'].includes(n.type)) {
      const child = scopes.length;
      scopes.push({ start: n.start, end: n.end, parent: scope, names: [] });
      scope = child;
      if (n.type === 'CatchClause') bind(n.param, scope);
    }
    if (n.type === 'VariableDeclaration') {
      let target = scope;
      if (n.kind === 'var') while (!functionScopes.has(target)) target = scopes[target]!.parent;
      for (const d of n.declarations) {
        const previous = scopes[target]!.names.length;
        bind(d.id, target);
        if (n.kind !== 'var' && !['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(parent?.type)) {
          const pending = scopes[target]!.pending ??= [];
          for (const name of scopes[target]!.names.slice(previous)) pending.push({ name, until: n.end });
        }
      }
    }
    if (n.type === 'ClassDeclaration') bind(n.id, scope);
    if (n.type.startsWith('Import')) bind(n.local, scope);
    if (n.type === 'Identifier') {
      const property = parent && ((['MemberExpression', 'OptionalMemberExpression'].includes(parent.type) && key === 'property' && !parent.computed) ||
        (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && key === 'key' && !parent.computed));
      if (!property && !['label', 'imported', 'exported'].includes(key ?? '') && key !== 'typeAnnotation') {
        const spelling = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(source.slice(n.start))?.[0];
        if (spelling) references.push({ start: n.start, end: n.start + spelling.length, name: n.name, scope, path });
      }
      return;
    }
    for (const [k, value] of Object.entries(n)) {
      if (['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters'].includes(k)) continue;
      const memberPath = k === 'object' && ['MemberExpression', 'OptionalMemberExpression'].includes(n.type) && !n.computed && n.property?.type === 'Identifier' ? [n.property.name, ...path] : [];
      if (Array.isArray(value)) for (const v of value) visit(v, scope, n, k);
      else if (value && typeof value === 'object') visit(value, scope, n, k, memberPath);
    }
  };
  visit(parsed.program, 0);
  // Declarations and uses share the lexical identity, including shadowed block bindings.
  for (const r of references) {
    let scope = r.scope;
    while (scope >= 0 && !scopes[scope]!.names.includes(r.name)) scope = scopes[scope]!.parent;
    r.scope = scope;
  }
  return { scopes, references };
}
