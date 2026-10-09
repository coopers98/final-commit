// SPEC 8.3 rule 4 (D15): the script the node runner runs Trace's function
// with, passed by `-e`; the payload comes on standard input. This file has no
// imports, so a plain `node --test` can load it to run the real harness
// (scripts/harness.test.mjs). Every limit comes in the payload, from config.
//
// What it does: strips TypeScript types (`stripTypeScriptTypes`, mode
// `strip`; anything not erasable fails the run), makes a fresh vm context
// with code generation from strings and WebAssembly off, deletes every
// global of that context but the allowlisted ones (and Math.random), freezes
// those and the built-in prototypes, defines the function, then calls it once
// per input, each call under its own timeout. Nothing from this process is
// put in the context: inputs go in as JSON text and come out as JSON text,
// checked inside the context to be plain data (finite numbers, strings,
// booleans, null, arrays and plain objects, no accessors, not too deep or
// long). It prints one line, `{"results":[...]}`, each `{"ok":true,"value":...}`
// or `{"ok":false}`. A bad payload, a type it cannot strip, or a definition
// that fails exits non-zero.

/** The payload on standard input. */
export type HarnessPayload = {
  code: string
  name: string
  /** One JSON array of arguments per call. */
  inputs: unknown[][]
  callTimeoutMs: number
  totalMs: number
  maxDepth: number
  maxValueChars: number
}

/** The globals the function may use (SPEC 8.3 rule 4); everything else in the context is deleted. */
export const ALLOWED_GLOBALS: readonly string[] = [
  'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Infinity', 'NaN', 'undefined',
]

/** Runs inside the context before the function is defined; `__fc_max` and `__fc_depth` are spliced in. */
const SETUP = [
  '(function () {',
  '  "use strict";',
  '  var g = globalThis;',
  '  var allowed = ' + JSON.stringify(ALLOWED_GLOBALS) + ';',
  '  var parse = JSON.parse, stringify = JSON.stringify, isArray = Array.isArray;',
  '  var protoOf = Object.getPrototypeOf, ownKeys = Reflect.ownKeys, descOf = Object.getOwnPropertyDescriptor;',
  '  var apply = Reflect.apply, isFiniteNumber = Number.isFinite, freeze = Object.freeze, defineProperty = Object.defineProperty;',
  '  var ObjectProto = Object.prototype, ArrayProto = Array.prototype;',
  '  var max = __FC_MAX__, maxDepth = __FC_DEPTH__;',
  '  // Taken before the globals go: frozen at the end, so the function cannot change them.',
  '  var frozen = [Object, Array, String, Number, Boolean, Map, Set, Math, JSON, Function.prototype, ObjectProto, ArrayProto,',
  '    String.prototype, Number.prototype, Boolean.prototype, Map.prototype, Set.prototype, RegExp.prototype, Error.prototype];',
  '  delete Math.random;',
  '  var keep = {};',
  '  for (var i = 0; i < allowed.length; i += 1) keep[allowed[i]] = true;',
  '  var names = ownKeys(g);',
  '  for (var j = 0; j < names.length; j += 1) {',
  '    var k = names[j];',
  '    if (typeof k !== "string" || !keep[k]) { try { delete g[k]; } catch (e) {} }',
  '  }',
  '  function plain(v, d) {',
  '    if (d > maxDepth) return false;',
  '    if (v === null) return true;',
  '    var t = typeof v;',
  '    if (t === "string" || t === "boolean") return true;',
  '    if (t === "number") return isFiniteNumber(v);',
  '    if (t !== "object") return false;',
  '    var arr = isArray(v);',
  '    if (protoOf(v) !== (arr ? ArrayProto : ObjectProto)) return false;',
  '    var keys = ownKeys(v);',
  '    for (var n = 0; n < keys.length; n += 1) {',
  '      var key = keys[n];',
  '      if (typeof key !== "string") return false;',
  '      if (arr && key === "length") continue;',
  '      var desc = descOf(v, key);',
  '      if (!desc || !("value" in desc) || !desc.enumerable) return false;',
  '      if (!plain(desc.value, d + 1)) return false;',
  '    }',
  '    if (arr && keys.length !== v.length + 1) return false;',
  '    return true;',
  '  }',
  '  function run(fn, argsJson) {',
  '    if (typeof fn !== "function") return undefined;',
  '    var v = apply(fn, undefined, parse(argsJson));',
  '    if (!plain(v, 0)) return undefined;',
  '    var s = stringify(v);',
  '    return typeof s === "string" && s.length <= max ? s : undefined;',
  '  }',
  '  defineProperty(g, "__fc_run", { value: freeze(run), writable: false, configurable: false, enumerable: false });',
  '  for (var f = 0; f < frozen.length; f += 1) freeze(frozen[f]);',
  '})();',
].join('\n')

/** The harness, for `node -e`. */
export const HARNESS = [
  '"use strict";',
  'const vm = require("node:vm");',
  'const { stripTypeScriptTypes } = require("node:module");',
  'const SETUP = ' + JSON.stringify(SETUP) + ';',
  'let raw = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", c => { raw += c; });',
  'process.stdin.on("end", () => {',
  '  let p;',
  '  try { p = JSON.parse(raw); } catch { process.exit(2); }',
  '  if (!p || typeof p.code !== "string" || typeof p.name !== "string" || !/^[A-Za-z_$][\\w$]*$/.test(p.name) || !Array.isArray(p.inputs)) process.exit(2);',
  '  const nums = [p.callTimeoutMs, p.totalMs, p.maxDepth, p.maxValueChars];',
  '  if (!nums.every(n => Number.isInteger(n) && n > 0)) process.exit(2);',
  '  let js;',
  '  try { js = stripTypeScriptTypes(p.code, { mode: "strip" }); } catch { process.exit(3); }',
  '  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });',
  '  const opts = { timeout: p.callTimeoutMs, breakOnSigint: false };',
  '  try {',
  '    vm.runInContext(SETUP.replace("__FC_MAX__", String(p.maxValueChars)).replace("__FC_DEPTH__", String(p.maxDepth)), ctx, opts);',
  '    vm.runInContext(js + "\\n;", ctx, opts);',
  '  } catch { process.exit(4); }',
  '  const started = Date.now();',
  '  const results = [];',
  '  let isStopped = false;',
  '  for (const args of p.inputs) {',
  '    if (isStopped || !Array.isArray(args) || Date.now() - started > p.totalMs) { results.push({ ok: false }); continue; }',
  '    const at = Date.now();',
  '    try {',
  '      const s = vm.runInContext("__fc_run(" + p.name + ", " + JSON.stringify(JSON.stringify(args)) + ")", ctx, opts);',
  '      if (typeof s !== "string") { results.push({ ok: false }); continue; }',
  '      results.push({ ok: true, value: JSON.parse(s) });',
  '    } catch {',
  '      // Nothing thrown is read (an object the function threw could run code on a read). A call',
  '      // that ran to its timeout may leave the context in any state: no more calls.',
  '      if (Date.now() - at >= p.callTimeoutMs) isStopped = true;',
  '      results.push({ ok: false });',
  '    }',
  '  }',
  '  process.stdout.write(JSON.stringify({ results }) + "\\n");',
  '});',
].join('\n')
