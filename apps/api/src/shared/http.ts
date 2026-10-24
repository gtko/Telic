// A 204 No Content response. Elysia serializes returned values, so deletes return
// this explicit empty response instead of a body.
export const noContent = () => new Response(null, { status: 204 });

// One Server-Sent Events frame: the JSON-encoded value, with the event id a client
// passes back to resume from where it stopped when the caller numbers its events.
export function sseFrame(data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}data: ${JSON.stringify(data)}\n\n`;
}

// Streams frames as Server-Sent Events. Returned as a raw Response, so a route serving
// one declares `200: t.Any()` — it is not a JSON shape the validator can describe.
//
// The stream is pull-based: the next frame is requested only when the client has room for
// it, and a client that goes away cancels the stream, which closes the source iterator so
// whatever it polls stops. A Worker has no process to leak into, but an invocation that
// keeps polling D1 for a closed connection is billed all the same.
export function sseResponse(frames: AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const iterator = frames[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      // no-transform keeps an intermediary from compressing (and so buffering) the stream.
      'Cache-Control': 'no-cache, no-transform',
      // A proxy that buffers the response would hold it back until it ends, which is
      // the one thing an event stream exists to avoid.
      'X-Accel-Buffering': 'no',
    },
  });
}
