// Elysia's Cloudflare adapter compiles its routes with `Function(...)` (no `new`). The pool
// patches only `new Function`, so a call is forwarded to the patched constructor.
const patchedFunction = globalThis.Function;
globalThis.Function = new Proxy(patchedFunction, {
  apply: (_target, _this, args) => Reflect.construct(patchedFunction, args),
}) as FunctionConstructor;
