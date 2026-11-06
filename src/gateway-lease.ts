import { mutate, type Store } from './store.ts';

export const GATEWAY_KEY = 'config/gateway.json';
export const GATEWAY_TTL = 120_000;
export interface GatewayState {
  owner: string;
  until: number;
  updatedAt: number;
  connected: boolean;
  readyAt?: number;
}

/** CAS elects one gateway during rolling deployments. An expired holder must reconnect. */
export async function gatewayLease(store: Store, owner: string, mode: 'acquire' | 'renew' | 'release',
  status: { connected: boolean; readyAt?: number }, now = Date.now()): Promise<number> {
  return mutate<GatewayState, number>(store, GATEWAY_KEY,
    () => ({ owner: '', until: 0, updatedAt: now, connected: false }), state => {
      const own = state.owner === owner && state.until > now;
      if (mode === 'release') {
        if (state.owner !== owner) return { value: state, result: 0, unchanged: true };
        return { value: { ...state, until: 0, connected: false, updatedAt: now }, result: 0 };
      }
      if ((mode === 'renew' && !own) || (mode === 'acquire' && state.until > now && !own)) {
        return { value: state, result: 0, unchanged: true };
      }
      const until = now + GATEWAY_TTL;
      return { value: { owner, until, updatedAt: now, ...status }, result: until };
    });
}
