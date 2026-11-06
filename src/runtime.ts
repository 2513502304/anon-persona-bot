import { BlobStore } from './store.ts';
import { Engine } from './engine.ts';
import { deliverThroughChat } from './chat.ts';
/** Share the durable store across transports while keeping each Engine request-local. */
export function runtime() {
  return new Engine(new BlobStore(), { pairingCode: process.env.QQ_PAIRING_CODE ?? '',
    enabled: process.env.BOT_ENABLED === 'true', deliver: deliverThroughChat });
}
