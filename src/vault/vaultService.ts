import {
  VAULT_CHANNEL,
  VAULT_EVENT_CHANNEL,
  isVaultEvent,
  isVaultResponse,
  type VaultMethod,
  type VaultParams,
  type VaultResults,
} from './protocol';
type EventListener = () => void;

/**
 * Main-thread facade over the vault worker. All key derivation, encryption
 * and S3 signing happen on the other side of this RPC boundary.
 */
class VaultService {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private lockedListeners = new Set<EventListener>();

  /** Lazily spawns the vault worker and wires response routing. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL('../workers/vault.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;

      if (isVaultResponse(data)) {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        if (data.ok) {
          entry.resolve(data.result);
        } else {
          entry.reject(new Error(data.error));
        }
        return;
      }

      if (isVaultEvent(data) && data.event === 'locked') {
        for (const listener of this.lockedListeners) {
          listener();
        }
      } else if (data && (data as { channel?: unknown }).channel === VAULT_EVENT_CHANNEL) {
        // Future events are routed here.
        void 0;
      } else {
        // Ignore unrelated messages (e.g. during worker startup).
        void 0;
      }
    });

    worker.addEventListener('error', (event) => {
      const err = new Error(event.message || 'Vault worker failed');
      for (const [, entry] of this.pending) {
        entry.reject(err);
      }
      this.pending.clear();
    });

    this.worker = worker;
    return worker;
  }

  /** Invokes a method on the vault worker. */
  public call<M extends VaultMethod>(
    method: M,
    params: VaultParams[M] = undefined as VaultParams[M],
  ): Promise<VaultResults[M]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;

    return new Promise<VaultResults[M]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      worker.postMessage({ channel: VAULT_CHANNEL, id, method, params });
    });
  }

  /** Subscribes to automatic lock events (idle timeout). Returns unsubscribe. */
  public onLocked(listener: EventListener): () => void {
    this.lockedListeners.add(listener);
    return () => this.lockedListeners.delete(listener);
  }

  /**
   * Hands one end of a MessageChannel to the vault worker so it can sign
   * requests for the transfer worker. The transfer worker's end is never
   * seen by this thread's code, and no credential values pass through here.
   */
  public attachTransferPort(port: MessagePort): Promise<void> {
    const worker = this.ensureWorker();
    const id = this.nextId++;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
      });
      worker.postMessage(
        {
          channel: VAULT_CHANNEL,
          id,
          method: 'vault.attachTransferPort',
          params: { port },
        },
        [port],
      );
    });
  }
}

export const vaultService = new VaultService();
