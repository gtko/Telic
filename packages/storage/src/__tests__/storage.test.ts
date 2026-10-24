import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentObjectKey,
  deleteObject,
  deleteObjects,
  getObject,
  getObjectText,
  putObject,
  type R2BucketBinding,
  safeAttachmentFilename,
  useR2Bucket,
} from '../index';

// An in-memory stand-in for the R2 binding: the three methods this module calls, with
// the R2 result shapes (null for a missing key, httpMetadata, size, body stream).
class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.objects.set(key, {
      bytes: new Uint8Array(value),
      contentType: options?.httpMetadata?.contentType,
    });
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      size: entry.bytes.byteLength,
      httpMetadata: { contentType: entry.contentType },
      body: new Response(entry.bytes).body!,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const S3_VARIABLES = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

describe('storage on an R2 binding', () => {
  const saved = Object.fromEntries(S3_VARIABLES.map((name) => [name, process.env[name]]));
  afterEach(() => {
    useR2Bucket(null);
    for (const name of S3_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('writes the bytes and content type to the bucket, and reads them back', async () => {
    const bucket = new MemoryBucket();
    useR2Bucket(bucket as unknown as R2BucketBinding);

    await putObject(
      'projects/1/attachments/a.txt',
      new TextEncoder().encode('bonjour'),
      'text/plain',
    );

    expect(bucket.objects.get('projects/1/attachments/a.txt')?.contentType).toBe('text/plain');
    const object = await getObject('projects/1/attachments/a.txt');
    expect(object.contentType).toBe('text/plain');
    expect(object.contentLength).toBe(7);
    expect(await new Response(object.body).text()).toBe('bonjour');
  });

  it('reads a text object through getObjectText', async () => {
    const bucket = new MemoryBucket();
    useR2Bucket(bucket as unknown as R2BucketBinding);
    await putObject('skills/SKILL.md', new TextEncoder().encode('# Titre'), 'text/markdown');
    expect(await getObjectText('skills/SKILL.md')).toBe('# Titre');
  });

  it('falls back to a generic content type when the object has none', async () => {
    const bucket = new MemoryBucket();
    useR2Bucket(bucket as unknown as R2BucketBinding);
    await bucket.put('raw', new Uint8Array([1, 2, 3]));
    expect((await getObject('raw')).contentType).toBe('application/octet-stream');
  });

  it('fails on a missing object instead of returning an empty body', async () => {
    useR2Bucket(new MemoryBucket() as unknown as R2BucketBinding);
    await expect(getObject('absent')).rejects.toThrow("Object 'absent' does not exist");
  });

  it('deletes one object, and several best-effort', async () => {
    const bucket = new MemoryBucket();
    useR2Bucket(bucket as unknown as R2BucketBinding);
    for (const key of ['a', 'b', 'c']) await putObject(key, new Uint8Array([0]), 'x/y');

    await deleteObject('a');
    expect([...bucket.objects.keys()].sort()).toEqual(['b', 'c']);

    await deleteObjects(['b', 'c']);
    expect(bucket.objects.size).toBe(0);
  });

  it('goes back to the S3 client when the binding is removed', async () => {
    useR2Bucket(new MemoryBucket() as unknown as R2BucketBinding);
    useR2Bucket(null);
    for (const name of S3_VARIABLES) delete process.env[name];
    await expect(getObject('anything')).rejects.toThrow('S3 storage is not configured');
  });
});

describe('attachment naming', () => {
  it('keeps the last path segment and replaces control characters', () => {
    expect(safeAttachmentFilename('C:\\docs\\rapport.pdf')).toBe('rapport.pdf');
    expect(safeAttachmentFilename('a\u0001b.txt')).toBe('a_b.txt');
  });

  it('falls back when nothing usable is left', () => {
    expect(safeAttachmentFilename('')).toBe('file');
    expect(safeAttachmentFilename('..')).toBe('file');
    expect(safeAttachmentFilename('/', 'upload')).toBe('upload');
  });

  it('builds a unique key under the project, namespace and owner', () => {
    const key = attachmentObjectKey(7, 'attachments', 12, 'rapport final.pdf');
    expect(key).toMatch(/^projects\/7\/attachments\/12\/[0-9a-f-]{36}-rapport_final\.pdf$/);
    expect(attachmentObjectKey(7, 'chat', null, 'a.png')).not.toBe(
      attachmentObjectKey(7, 'chat', null, 'a.png'),
    );
  });
});
