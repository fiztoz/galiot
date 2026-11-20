// Deterministic transport for vault worker lifecycle tests. All responses stay in this worker.
import '../workers/vault.worker';

let resumeOpen: (() => void) | undefined;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'DELETE') {
    postMessage({ fixture: 'closed' });
    return Response.json({ ok: true });
  }
  if (_input === '/api/s3/sessions') {
    postMessage({ fixture: 'opening' });
    await new Promise<void>(resolve => { resumeOpen = resolve; });
    return Response.json({ ok: true, result: { sessionId: 'fixture-session' } });
  }
  throw new Error('Unexpected request after lock');
}) as typeof fetch;

addEventListener('message', (event: MessageEvent) => {
  if (event.data?.fixture === 'resume') resumeOpen?.();
});
