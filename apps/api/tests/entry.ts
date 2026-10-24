// The Worker entry of the `workers` test project: the real one, loaded after the patch that lets
// Elysia compile its routes inside the test runtime.
import './function-call';

export { default } from '../src/worker';
export * from '../src/worker';
