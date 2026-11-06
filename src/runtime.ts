import { BlobStore } from './store.ts';
import { Engine } from './engine.ts';
import { deliverThroughChat } from './chat.ts';
export function runtime() {
  return new Engine(new BlobStore(), { pairingCode: process.env.QQ_PAIRING_CODE ?? '',
    enabled: process.env.BOT_ENABLED === 'true', deliver: deliverThroughChat,
    dailyLimit: Math.min(100, Math.max(1, Number(process.env.DAILY_MODEL_CALL_LIMIT) || 100)) });
}
