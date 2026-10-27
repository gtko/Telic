import { JSDOM } from 'jsdom';

process.env.API_URL ??= 'http://api.test';

// react-dom/client detects browser features once, when first loaded. Bun shares the module
// cache across test files, so a file that imports it before installing its own JSDOM would
// leave input events unsupported for every later file. Load it here under a DOM.
const dom = new JSDOM('<!doctype html>');
const globals = ['window', 'document', 'navigator'] as const;
const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
for (const name of globals) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
await import('react-dom/client');
globals.forEach((name, i) => {
  const descriptor = saved[i];
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
});
dom.window.close();
