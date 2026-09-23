import { AwsClient } from '../lib/aws4fetch';

let client: AwsClient | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;

  try {
    switch (type) {
      case 'init':
        client = new AwsClient({
          accessKeyId: payload.accessKeyId,
          secretAccessKey: payload.secretAccessKey,
          sessionToken: payload.sessionToken,
          region: payload.region,
          service: payload.service || 's3',
        });
        
        // Wipe payload from memory
        payload.accessKeyId = '';
        payload.secretAccessKey = '';
        if (payload.sessionToken) payload.sessionToken = '';
        
        self.postMessage({ type: 'ready', id });
        break;

      case 'sign':
        if (!client) throw new Error('Worker not initialized');
        const { input, init } = payload;
        
        const req = await client.sign(input, init);
        
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });

        self.postMessage({
          type: 'signed',
          id,
          payload: {
            url: req.url,
            method: req.method,
            headers,
          },
        });
        break;

      case 'destroy':
        if (client) {
          // Zero out credentials
          client.accessKeyId = '';
          client.secretAccessKey = '';
          client.sessionToken = undefined;
          client = null;
        }
        self.postMessage({ type: 'destroyed', id });
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
