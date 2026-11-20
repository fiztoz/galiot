import { describe, expect, test } from 'bun:test';
import { TransferEngine } from '../workers/transfer.worker';
import type { TransferEvent } from './protocol';
import { downloadFile, localFolder, publishLocal } from './download';
import type { DownloadJob } from './protocol';

class MemoryFile {
  bytes = new Uint8Array(0);
  open = false;
  constructor(readonly name: string) {}
  async getFile() { return new File([this.bytes], this.name); }
  async createWritable(options?: { keepExistingData?: boolean }) {
    if (this.open) throw new Error('File is locked');
    this.open = true;
    let bytes = options?.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    let offset = 0;
    const sink = {
      write: (chunk: Uint8Array) => {
        const next = new Uint8Array(Math.max(bytes.length, offset + chunk.length));
        next.set(bytes);
        next.set(chunk, offset);
        offset += chunk.length;
        bytes = next;
      },
      close: () => { this.bytes = bytes; this.open = false; },
      abort: () => { this.open = false; },
    };
    return Object.assign(new WritableStream<Uint8Array>(sink), sink, { seek: async (at: number) => { offset = at; } });
  }
}

class MemoryDirectory {
  files = new Map<string, MemoryFile>();
  dirs = new Map<string, MemoryDirectory>();
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let handle = this.files.get(name);
    if (!handle) {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      handle = new MemoryFile(name);
      this.files.set(name, handle);
    }
    return handle;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      dir = new MemoryDirectory();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  get handle() { return this as unknown as FileSystemDirectoryHandle; }
  get storage() { return { getDirectory: async () => this.handle } as StorageManager; }
}

const job: DownloadJob = {
  taskId: 'id', profileId: 'p', key: 'docs/report.txt', expectedSize: 5,
  credentials: { iv: '', ciphertext: '' }, destination: { kind: 'staged' },
  target: { bucket: 'b', endpoint: 'https://s3.example.com', region: 'r', pathStyle: true },
};
const bytes = (text: string) => new TextEncoder().encode(text);
const head = (etag: string) => new Response(null, { headers: { etag, 'content-length': '5' } });
const noop = () => {};
const signal = () => new AbortController().signal;

describe('download staging and publication', () => {
  for (const original of ['x', 'wrong', 'longer']) {
    test(`existing ${original.length}-byte file stays intact until replacement is authorized`, async () => {
      const staging = new MemoryDirectory();
      const dest = new MemoryDirectory();
      const local = await dest.getFileHandle('report.txt', { create: true });
      local.bytes = bytes(original);
      const destination = { kind: 'directory' as const, handle: dest.handle, filename: 'report.txt' };
      const staged = await downloadFile({ ...job, destination }, async (method, headers) => {
        if (method === 'HEAD') return head('"revision"');
        expect(headers?.Range).toBeUndefined();
        return new Response('right', { headers: { etag: '"revision"' } });
      }, signal(), noop, () => false, staging.storage);
      await expect(publishLocal(staged, destination, signal())).rejects.toThrow('already exists');
      expect(await (await local.getFile()).text()).toBe(original);
      await publishLocal(staged, { ...destination, replace: true }, signal());
      expect(await (await local.getFile()).text()).toBe('right');
    });
  }

  for (const changed of [false, true]) {
    test(`interrupted staging ${changed ? 'restarts for another revision' : 'resumes at its verified offset'}`, async () => {
      const staging = new MemoryDirectory();
      const stop = new AbortController();
      await expect(downloadFile(job, async method => method === 'HEAD' ? head('"first"') :
        new Response('ab', { headers: { etag: '"first"' } }), stop.signal,
        count => { if (count === 2) stop.abort(); }, () => true, staging.storage)).rejects.toThrow();
      const etag = changed ? '"next"' : '"first"';
      const file = await downloadFile(job, async (method, headers) => {
        if (method === 'HEAD') return head(etag);
        expect(headers?.Range).toBe(changed ? undefined : 'bytes=2-');
        return changed ? new Response('12345', { headers: { etag } }) :
          new Response('cde', { status: 206, headers: { etag, 'content-range': 'bytes 2-4/5' } });
      }, signal(), noop, () => false, staging.storage);
      expect(await file.text()).toBe(changed ? '12345' : 'abcde');
    });
  }

  test('transfer HEAD and GET request raw storage bytes and retain the original download name', async () => {
    const encoded = Bun.gzipSync(bytes('encoded bytes'));
    const requests: string[] = [];
    const events: TransferEvent[] = [];
    const storage = new MemoryDirectory();
    const engine = new TransferEngine(e => events.push(e), async (input, init) => {
      const url = new URL(String(input), 'https://example.com');
      expect(url.searchParams.get('raw')).toBe('1');
      expect(url.searchParams.get('key')).toBe(job.key);
      requests.push(init?.method ?? 'GET');
      return new Response(init?.method === 'HEAD' ? null : encoded, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(encoded.length), etag: '"raw"' },
      });
    }, storage.storage);
    const channel = new MessageChannel();
    channel.port2.onmessage = ({ data }) => channel.port2.postMessage({ type: 'session', id: data.id, sessionId: 's' });
    engine.attachPort(channel.port1);
    try {
      await engine.run({ ...job, expectedSize: encoded.length });
      const done = events.find(e => e.type === 'done');
      expect(requests).toEqual(['HEAD', 'GET']);
      expect(done?.filename).toBe('report.txt');
      expect(new Uint8Array(await done!.stagedFile!.arrayBuffer())).toEqual(encoded);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  test('refuses a decoded response from an older server', async () => {
    const staging = new MemoryDirectory();
    await expect(downloadFile(job, async method => method === 'HEAD' ? head('"z"') :
      new Response('wrong', { headers: { etag: '"z"', 'content-encoding': 'gzip' } }),
      signal(), noop, () => false, staging.storage)).rejects.toThrow('raw object bytes');
  });

  test('rejects a changed GET revision before publishing any bytes', async () => {
    const staging = new MemoryDirectory();
    await expect(downloadFile(job, async method => method === 'HEAD' ? head('"old"') :
      new Response('12345', { headers: { etag: '"new"' } }), signal(), noop, () => false, staging.storage))
      .rejects.toThrow('remote file changed');
  });

  test('an empty marked folder and nested output resolve inside the displayed folder', async () => {
    const root = new MemoryDirectory();
    const child = await localFolder(root.handle, 'visible', true);
    await localFolder(child, 'empty', true);
    await publishLocal(new File(['bytes'], 'internal-name'),
      { kind: 'directory', handle: child, filename: 'report.txt' }, signal());
    expect(root.files.size).toBe(0);
    expect(root.dirs.get('visible')?.dirs.has('empty')).toBe(true);
    expect(root.dirs.get('visible')?.files.has('report.txt')).toBe(true);
  });
});
