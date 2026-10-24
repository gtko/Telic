// The Mastra runtime (./index) is large: it is loaded on the first run, not while the Worker
// module loads, which has a CPU budget. Callers import runAgent and streamAgent from here.

export const STEP_LIMIT_MESSAGE = 'Reached the step limit';

type Runtime = typeof import('./index');

export async function runAgent(...args: Parameters<Runtime['runAgent']>) {
  return (await import('./index')).runAgent(...args);
}

export async function* streamAgent(...args: Parameters<Runtime['streamAgent']>) {
  yield* (await import('./index')).streamAgent(...args);
}
