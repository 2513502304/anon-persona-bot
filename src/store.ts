import { get, put, list, del, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { getVercelOidcToken } from '@vercel/oidc';

/** Daemons rotate their OIDC file; reread it for each operation, never cache a startup token. */
async function daemonAuth() {
  return process.env.VERCEL_OIDC_TOKEN_FILE ? { oidcToken: await getVercelOidcToken() } : {};
}

export interface Snapshot<T> { value: T; etag: string }
export interface Store {
  read<T>(key: string): Promise<Snapshot<T> | null>;
  write<T>(key: string, value: T, etag: string | null): Promise<boolean>;
  keys(prefix: string): Promise<string[]>;
}

/** Private origin reads plus ETag CAS; never use cached reads for state mutations. */
export class BlobStore implements Store {
  async read<T>(key: string): Promise<Snapshot<T> | null> {
    try {
      // Compressed responses carry weak ETags, which cannot guard Blob's conditional writes.
      // Request the original representation; never strip W/ and pretend it is a strong validator.
      const result = await get(key, { access: 'private', useCache: false,
        headers: { 'Accept-Encoding': 'identity' }, ...await daemonAuth() });
      if (!result) return null;
      if (result.statusCode !== 200) throw new Error('Unexpected conditional response');
      return { value: await new Response(result.stream).json() as T, etag: result.blob.etag };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }
  async write<T>(key: string, value: T, etag: string | null): Promise<boolean> {
    if (etag !== null && (!etag || etag.startsWith('W/'))) throw new Error('State write requires a strong ETag');
    try {
      await put(key, JSON.stringify(value), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        ...await daemonAuth(),
        allowOverwrite: etag !== null, ...(etag ? { ifMatch: etag } : {}),
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      // Initial creation races return the SDK's existing-file error, not always 412.
      if (!etag && error instanceof Error && /already exists/i.test(error.message)) return false;
      throw error;
    }
  }
  async keys(prefix: string): Promise<string[]> {
    const result: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, limit: 100, cursor, ...await daemonAuth() });
      result.push(...page.blobs.map(b => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return result;
  }
  /** Only disposable diagnostic objects may be removed through this operational helper. */
  async deleteDiagnostic(key: string): Promise<void> {
    if (!/^diagnostics\/(?:cas|large)-[a-f\d-]+\.json$/.test(key)) throw new Error('Not a diagnostic key');
    await del(key, { ...await daemonAuth() });
  }
}

/** Mutators must be synchronous and free of side effects: a conflict can replay them. */
export async function mutate<T, R>(store: Store, key: string, initial: () => T,
  change: (value: T) => { value: T; result: R; unchanged?: boolean }): Promise<R> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await store.read<T>(key);
    const next = change(structuredClone(current?.value ?? initial()));
    if (next.unchanged) return next.result;
    if (await store.write(key, next.value, current?.etag ?? null)) return next.result;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, 5 * (attempt + 1))));
  }
  throw new Error('State contention; retry later');
}

/** Test backend preserves CAS semantics, including separate read/write interleavings. */
export class MemoryStore implements Store {
  private values = new Map<string, Snapshot<unknown>>();
  async read<T>(key: string): Promise<Snapshot<T> | null> {
    return structuredClone(this.values.get(key) as Snapshot<T> | undefined) ?? null;
  }
  async write<T>(key: string, value: T, etag: string | null): Promise<boolean> {
    if ((this.values.get(key)?.etag ?? null) !== etag) return false;
    this.values.set(key, { value: structuredClone(value), etag: randomUUID() });
    return true;
  }
  async keys(prefix: string) { return [...this.values.keys()].filter(k => k.startsWith(prefix)); }
}
