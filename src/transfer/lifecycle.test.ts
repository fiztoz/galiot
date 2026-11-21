import { expect, test } from 'bun:test';
import { MAX_ACTIVE_TASKS, TransferEngine } from '../workers/transfer.worker';
import { removeStaging, uploadFingerprint } from './checkpoint';
import { scheduleListingRefresh } from './listingRefresh';
import type { TransferEvent, UploadJob } from './protocol';

test('cancel during multipart initiation keeps the upload ID and reports the abort outcome', async () => {
  const job: UploadJob = {
    taskId: 'cancel-task', profileId: 'profile', key: 'file.bin',
    target: { endpoint: 'https://s3.example.com', bucket: 'example-bucket', region: 'r', pathStyle: true },
    credentials: { iv: 'i', ciphertext: 'c' }, file: new File([new ArrayBuffer(33 * 1024 ** 2)], 'file.bin'),
    partSize: 16 * 1024 ** 2, concurrency: 1,
  };
  for (const allowed of [false, true]) {
    const events: TransferEvent[] = [];
    const calls: string[] = [];
    const engine = new TransferEngine(e => events.push(e), async (_, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.op);
      if (body.op === 'createMultipart') {
        engine.cancel(job.taskId);
        expect(init?.signal?.aborted).not.toBe(true);
        return Response.json({ ok: true, result: { uploadId: 'upload' } });
      }
      expect(body.uploadId).toBe('upload');
      return Response.json(allowed ? { ok: true, result: { aborted: true } }
        : { ok: false, status: 403, code: 'AccessDenied', error: 'AccessDenied (403)' });
    });
    const port = new MessageChannel();
    port.port2.onmessage = ({ data }) => port.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
    engine.attachPort(port.port1);
    try {
      await engine.run(job);
      expect(calls).toEqual(['createMultipart', 'abortMultipart']);
      expect(events.some(e => e.type === 'upload-created' && e.uploadId === 'upload')).toBe(true);
      expect(events.at(-1)).toMatchObject(allowed ? { type: 'canceled' } : {
        type: 'error', message: expect.stringContaining('S3 did not confirm multipart cleanup: AccessDenied (403)'),
      });
    } finally {
      port.port1.close();
      port.port2.close();
    }
  }
});

test('the same worker can pause a multipart transfer twice, then finish it', async () => {
  const job: UploadJob = {
    taskId: 'task', profileId: 'profile', key: 'folder/file.bin',
    target: { endpoint: 'https://s3.example.com', bucket: 'example-bucket', region: 'r', pathStyle: true },
    credentials: { iv: 'fixture', ciphertext: 'sealed' }, file: new File([new Uint8Array(33 * 1024 ** 2)], 'file.bin'),
    partSize: 16 * 1024 ** 2, concurrency: 1,
  };
  const messages: TransferEvent[] = [];
  let interrupt = true;
  let opens = 0;
  const engine = new TransferEngine(event => messages.push(event), async (url, init) => {
    if (String(url).includes('/part?')) {
      if (interrupt) {
        engine.pause(job.taskId);
        throw new DOMException('Paused', 'AbortError');
      }
      return new Response(null, { headers: { etag: '"part"' } });
    }
    const op = JSON.parse(String(init?.body)).op;
    if (op === 'createMultipart') return Response.json({ ok: true, result: { uploadId: 'upload' } });
    if (op === 'listParts') return Response.json({ ok: true, result: { parts: [] } });
    if (op === 'completeMultipart') return Response.json({ ok: true, result: {} });
    throw new Error('Unexpected operation');
  });
  const channel = new MessageChannel();
  channel.port2.onmessage = ({ data }) => {
    opens++;
    channel.port2.postMessage({ type: 'session', id: data.id, sessionId: 'session' });
  };
  engine.attachPort(channel.port1);
  try {
    await engine.run(job);
    expect(messages.at(-1)?.type).toBe('paused');
    const created = messages.find(event => event.type === 'upload-created');
    if (created?.type !== 'upload-created') throw new Error('Missing upload checkpoint');
    const resumed = { ...job, uploadId: created.uploadId, uploadFingerprint: created.fingerprint };
    await engine.run(resumed);
    expect(messages.at(-1)?.type).toBe('paused');
    interrupt = false;
    await engine.run(resumed);
    expect(messages.at(-1)?.type).toBe('done');
    expect(opens).toBe(1);
    const different = new File([new Uint8Array([1]), job.file.slice(1)], job.file.name);
    await engine.run({ ...resumed, file: different });
    expect(messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('differs') });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test('the default transport calls browser fetch with the global receiver', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!;
  const events: TransferEvent[] = [];
  const channel = new MessageChannel();
  try {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(null));
    } });
    const engine = new TransferEngine(event => events.push(event));
    channel.port2.onmessage = ({ data }) => channel.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
    engine.attachPort(channel.port1);
    await engine.run({ taskId: 'fetch-receiver', profileId: 'p', key: 'item', file: new File(['hello'], 'item'),
      partSize: 1, concurrency: 1, credentials: { iv: '', ciphertext: '' },
      target: { endpoint: 'https://s3.example.com', bucket: 'example-bucket', pathStyle: true, region: 'r' } });
    expect(events.at(-1)?.type).toBe('done');
  } finally {
    Object.defineProperty(globalThis, 'fetch', original);
    channel.port1.close();
    channel.port2.close();
  }
});

test('expired sessions reopen once and replacement credentials revoke the cached identity', async () => {
  const opened: string[] = [];
  const used: string[] = [];
  const revoked: string[] = [];
  const events: TransferEvent[] = [];
  const engine = new TransferEngine(event => events.push(event), async url => {
    used.push(String(url).split('/')[4]!);
    return used.length === 1
      ? Response.json({ error: 'S3 session expired or unknown.' }, { status: 404 })
      : new Response(null);
  }, undefined, async id => { revoked.push(id); });
  const port = new MessageChannel();
  port.port2.onmessage = ({ data }) => {
    opened.push(data.credentials.iv);
    port.port2.postMessage({ type: 'session', id: data.id, sessionId: String(opened.length) });
  };
  engine.attachPort(port.port1);
  const job: UploadJob = { profileId: 'p', taskId: 'a', key: 'item', file: new File(['file'], 'item'),
    partSize: 1, concurrency: 1, credentials: { iv: 'first', ciphertext: 'sealed' },
    target: { endpoint: 'https://s3.example.com', bucket: 'example-bucket', pathStyle: true, region: 'r' } };
  try {
    await engine.run(job);
    await engine.run({ ...job, taskId: 'b', credentials: { iv: 'second', ciphertext: 'new' } });
    expect(opened).toEqual(['first', 'first', 'second']);
    expect(used).toEqual(['1', '2', '3']);
    expect(revoked).toEqual(['2']);
    expect(events.filter(e => e.type === 'done')).toHaveLength(2);
  } finally {
    port.port1.close();
    port.port2.close();
  }
});

test('vault deletion removes only the application staging tree and surfaces cleanup failures', async () => {
  const calls: unknown[] = [];
  const storage = { getDirectory: async () => ({
    removeEntry: async (...args: unknown[]) => { calls.push(args); },
  }) } as unknown as StorageManager;
  await removeStaging(undefined, storage);
  expect(calls).toEqual([['galiot-transfers', { recursive: true }]]);
  const blocked = { getDirectory: async () => { throw new DOMException('Busy', 'NoModificationAllowedError'); } };
  await expect(removeStaging(undefined, blocked as unknown as StorageManager)).rejects.toThrow('Busy');
});

test('fingerprints include file content and the final short chunk', async () => {
  const signal = new AbortController().signal;
  const prefix = new Uint8Array(8 * 1024 ** 2);
  const a = new Blob([prefix, 'a']);
  const b = new Blob([prefix, 'b']);
  expect(a.size).toBe(b.size);
  expect(await uploadFingerprint(a, signal)).not.toBe(await uploadFingerprint(b, signal));
});

test('a download target open failure reaches the ledger as an error', async () => {
  const events: TransferEvent[] = [];
  const engine = new TransferEngine(e => events.push(e), async () =>
    new Response(null, { headers: { etag: '"r"', 'content-length': '1' } }),
    { getDirectory: async () => { throw new Error('Local storage unavailable'); } } as unknown as StorageManager);
  const port = new MessageChannel();
  port.port2.onmessage = ({ data }) => port.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
  engine.attachPort(port.port1);
  try {
    await engine.run({ taskId: 't', profileId: 'p', key: 'item',
      credentials: { iv: '', ciphertext: '' }, target: { bucket: 'b', endpoint: 'https://s3.example.com', region: 'r', pathStyle: true },
      expectedSize: 1, destination: { kind: 'staged' } });
    expect(events.at(-1)).toMatchObject({ type: 'error', taskId: 't', message: 'Local storage unavailable' });
  } finally {
    port.port1.close();
    port.port2.close();
  }
});

test('a batch completion coalesces only uploads affecting the viewed prefix', async () => {
  let listener: ((event: TransferEvent) => void) | undefined;
  let reloads = 0;
  const stop = scheduleListingRefresh({
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
  }, 'p', 'b', 'dir/', () => reloads++, 5);
  const done = { type: 'done', taskId: 't', totalBytes: 1 } as const;
  const upload = { profileId: 'p', bucket: 'b', key: 'dir/item' };
  listener?.(done);
  listener?.({ ...done, upload: { ...upload, bucket: 'my-bucket' } });
  listener?.({ ...done, upload: { ...upload, key: 'other/item' } });
  await Bun.sleep(12);
  expect(reloads).toBe(0);
  for (let i = 0; i < 20; i++) listener?.({ ...done, upload });
  await Bun.sleep(12);
  expect(reloads).toBe(1);
  listener?.({ ...done, upload });
  stop();
  await Bun.sleep(12);
  expect(reloads).toBe(1);
});

test('only MAX_ACTIVE_TASKS transfers run at once, and a queued one can be canceled', async () => {
  const events: TransferEvent[] = [];
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const engine = new TransferEngine(e => events.push(e), async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>(resolve => gates.push(resolve));
    running -= 1;
    return new Response(null, { status: 500 });
  });
  const port = new MessageChannel();
  port.port2.onmessage = ({ data }) => port.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
  engine.attachPort(port.port1);
  const job = (taskId: string) => ({ taskId, profileId: 'p', key: taskId,
    credentials: { iv: '', ciphertext: '' }, target: { bucket: 'b', endpoint: 'https://s3.example.com', region: 'r', pathStyle: true },
    expectedSize: 1, destination: { kind: 'staged' } as const });
  try {
    const total = MAX_ACTIVE_TASKS + 3;
    const runs = Array.from({ length: total }, (_, i) => engine.run(job(`t${i}`)));
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    await settle();
    expect(running).toBe(MAX_ACTIVE_TASKS);

    // A waiting task leaves the queue at once, without a request.
    engine.cancel(`t${total - 1}`);
    await settle();
    expect(events).toContainEqual({ type: 'canceled', taskId: `t${total - 1}` });

    while (gates.length || running) {
      gates.splice(0).forEach(open => open());
      await settle();
    }
    await Promise.all(runs);
    expect(peak).toBe(MAX_ACTIVE_TASKS);
    expect(events.filter(e => e.type === 'error')).toHaveLength(total - 1);
  } finally {
    port.port1.close();
    port.port2.close();
  }
});

test('a permanent part failure is not retried and stops the remaining parts', async () => {
  const job: UploadJob = {
    taskId: 'denied', profileId: 'profile', key: 'big.bin',
    target: { endpoint: 'https://s3.example.com', bucket: 'example-bucket', region: 'r', pathStyle: true },
    credentials: { iv: 'i', ciphertext: 'c' }, file: new File([new Uint8Array(80 * 1024 ** 2)], 'big.bin'),
    partSize: 16 * 1024 ** 2, concurrency: 1,
  };
  const events: TransferEvent[] = [];
  let parts = 0;
  const engine = new TransferEngine(e => events.push(e), async (url, init) => {
    if (String(url).includes('/part?')) {
      parts += 1;
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403, statusText: 'Forbidden' });
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: body.op === 'createMultipart' ? { uploadId: 'u' } : {} });
  });
  const port = new MessageChannel();
  port.port2.onmessage = ({ data }) => port.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
  engine.attachPort(port.port1);
  try {
    await engine.run(job);
    expect(parts).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Part 1 failed: HTTP 403') });
  } finally {
    port.port1.close();
    port.port2.close();
  }
});
