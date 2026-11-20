import type { TransferEvent } from './protocol';

export function scheduleListingRefresh(
  events: { subscribe(listener: (event: TransferEvent) => void): () => void },
  profileId: string, bucket: string, prefix: string, refresh: () => void, delay = 300,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = events.subscribe(event => {
    if (event.type !== 'done' || !event.upload) return;
    const upload = event.upload;
    const parent = upload.key.slice(0, upload.key.lastIndexOf('/') + 1);
    if (upload.profileId !== profileId || upload.bucket !== bucket ||
        (parent !== prefix && upload.prefix !== prefix)) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
