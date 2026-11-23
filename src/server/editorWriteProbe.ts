import { readBoundedText } from '../lib/boundedBody.ts';
import type { S3Client } from '../s3/client.ts';
import { isStrongETag } from '../s3/clientHeaders.ts';

export interface EditorWriteCheck {
  verified: boolean;
  issue?: string;
}

/** Only sends requests to one generated key. Never accepts a user object key. */
export async function probeEditorWrites(s3: S3Client, sessionSignal: AbortSignal): Promise<EditorWriteCheck> {
  const id = crypto.randomUUID();
  const key = `.galiot-editor-check/${id}.txt`;
  const initial = `Galiot editor check ${id} (initial)`;
  const updated = `Galiot editor check ${id} (updated)`;
  const signal = AbortSignal.any([sessionSignal, AbortSignal.timeout(12_000)]);
  const versions = new Set<string | null>();
  let uncertainWrite = false;
  let check: EditorWriteCheck;

  async function put(body: string, condition: Record<string, string>): Promise<number> {
    signal.throwIfAborted();
    try {
      const res = await s3.send(s3.objectUrl(key), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...condition },
        body,
        signal,
      });
      if (res.ok) versions.add(res.headers.get('x-amz-version-id') || null);
      if (res.status >= 500) uncertainWrite = true;
      void res.body?.cancel().catch(() => {});
      return res.status;
    } catch (error) {
      uncertainWrite = true;
      throw error;
    }
  }

  async function read(expected: string): Promise<string | null> {
    const res = await s3.send(s3.objectUrl(key), { signal });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readBoundedText(res, 256);
    const tag = res.headers.get('etag');
    return text === expected && isStrongETag(tag) ? tag : null;
  }

  async function verify(): Promise<EditorWriteCheck> {
    const created = await put(initial, { 'if-none-match': '*' });
    if (created < 200 || created >= 300) {
      return { verified: false, issue: `The gateway did not create the test object (HTTP ${created}).` };
    }
    const tag = await read(initial);
    if (!tag) return { verified: false, issue: 'The test object could not be read back with a strong ETag.' };
    const stale = tag === '"00000000000000000000000000000000"'
      ? '"11111111111111111111111111111111"' : '"00000000000000000000000000000000"';
    if (await put(updated, { 'if-match': stale }) !== 412 || await read(initial) !== tag) {
      return { verified: false, issue: 'The gateway did not reliably reject a write with a mismatched ETag.' };
    }
    const written = await put(updated, { 'if-match': tag });
    const newTag = written >= 200 && written < 300 ? await read(updated) : null;
    return newTag && newTag !== tag ? { verified: true } : {
      verified: false, issue: 'The gateway did not confirm a write with the current ETag.',
    };
  }

  try {
    check = await verify();
  } catch {
    check = { verified: false, issue: 'The test could not finish. Check the connection or reopen the bucket to try again later.' };
  }

  // Cleanup has its own short budget so closing the session cancels further
  // verification, but still lets us remove acknowledged writes. Never delete
  // a key we did not create or perform a bare DELETE when versions are known.
  let cleanupFailed = uncertainWrite;
  if (versions.size) {
    const cleanupSignal = AbortSignal.timeout(5_000);
    const versioned = [...versions].some(version => version !== null);
    for (const versionId of versions) {
      if (versionId === null && versioned) {
        cleanupFailed = true;
        continue;
      }
      try {
        const url = s3.objectUrl(key, versionId === null ? undefined : { versionId });
        const res = await s3.send(url, { method: 'DELETE', signal: cleanupSignal });
        if (!res.ok) cleanupFailed = true;
        void res.body?.cancel().catch(() => {});
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    return { verified: false, issue: `Cleanup could not be confirmed. Check for leftover test data at ${key}.` };
  }
  return check;
}
