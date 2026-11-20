import { expect, test } from 'bun:test';
import { VAULT_CHANNEL, type VaultMethod, type VaultParams, type VaultResponse } from './protocol';
import type { SessionResponse } from '../transfer/protocol';

function nextMessage<T>(port: Worker | MessagePort, matches: (value: T) => boolean): Promise<T> {
  return new Promise(resolve => {
    function receive(event: MessageEvent<T>) {
      if (!matches(event.data)) return;
      port.removeEventListener('message', receive as EventListener);
      resolve(event.data);
    }
    port.addEventListener('message', receive as EventListener);
  });
}

test('a peer replacement locks the worker and revokes a late session without publishing it', async () => {
  const worker = new Worker(new URL('./vaultSession.fixture.ts', import.meta.url));
  const peer = new BroadcastChannel('galiot-vault-changes');
  const { port1, port2 } = new MessageChannel();
  let id = 0;
  function rpc<M extends VaultMethod>(method: M, params: VaultParams[M], transfer: Transferable[] = []) {
    const requestId = ++id;
    const result = nextMessage<VaultResponse<M>>(worker, msg => msg.id === requestId);
    worker.postMessage({ channel: VAULT_CHANNEL, method, params, id: requestId }, transfer);
    return result;
  }
  try {
    const generation = crypto.randomUUID();
    expect((await rpc('vault.create', { generation, passphrase: 'fixture passphrase' })).ok).toBe(true);
    await rpc('vault.attachTransferPort', { port: port2 }, [port2]);
    const credentials = await rpc('creds.encrypt', { credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    if (!credentials.ok) throw new Error(credentials.error);
    const opening = nextMessage<{ fixture?: string }>(worker, msg => msg.fixture === 'opening');
    port1.start();
    const transfer = nextMessage<SessionResponse>(port1, msg => msg.type === 'session' || msg.type === 'session-error');
    port1.postMessage({
      type: 'session', id: 4, profileId: 'test', region: 'region', bucket: 'archive',
      pathStyle: true, endpoint: 'https://s3.example.com', credentials: credentials.result.payload,
    });
    await opening;
    const closedCache = nextMessage<SessionResponse>(port1, msg => msg.type === 'sessions-closed');
    peer.postMessage({ generation, deleted: false });
    await closedCache;
    const status = await rpc('vault.status', undefined);
    expect(status.ok && status.result.unlocked).toBe(false);
    const revoked = nextMessage<{ fixture?: string }>(worker, msg => msg.fixture === 'closed');
    worker.postMessage({ fixture: 'resume' });
    await revoked;
    expect((await transfer).type).toBe('session-error');
  } finally {
    worker.terminate();
    port1.close();
    peer.close();
  }
});
