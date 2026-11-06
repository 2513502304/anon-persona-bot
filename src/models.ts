import type { Selection, Turn, ModelResult } from './types.ts';

export const MODELS = {
  'openai:gpt-6.1-sol': { provider: 'openai', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low','medium','high','xhigh','max'], defaultEffort: 'high' },
  'openai:gpt-6.1-terra': { provider: 'openai', id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['none','low','medium','high','xhigh','max'], defaultEffort: 'high' },
  'deepseek:deepseek-flash': { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', efforts: ['none','low','high','max'], defaultEffort: 'high' },
} as const;
export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: Selection = { key: 'openai:gpt-6.1-sol', effort: 'high' };
export function modelFor(selection: Selection) {
  const model = MODELS[selection.key as ModelKey];
  if (!model || !(model.efforts as readonly string[]).includes(selection.effort)) throw new Error('Unsupported model/effort');
  return model;
}
export function selectModel(key: string, effort?: string): Selection | null {
  const aliases: Record<string, ModelKey> = { openai: 'openai:gpt-6.1-sol', deepseek: 'deepseek:deepseek-flash',
    'deepseek:deepseek-v4.1-flash': 'deepseek:deepseek-flash' };
  const resolved = aliases[key] ?? key;
  const model = MODELS[resolved as ModelKey];
  if (!model || !(model.efforts as readonly string[]).includes(effort ?? model.defaultEffort)) return null;
  return { key: resolved, effort: effort ?? model.defaultEffort };
}
export function modelDescription(selection: Selection) {
  const model = modelFor(selection);
  return `${model.name}\nAPI：${selection.key}\n推理强度：${selection.effort}`;
}
export class ProviderFailure extends Error {
  constructor(public readonly provider: string, public readonly status: number, public readonly code: string) {
    super(`${provider} HTTP ${status} ${code}`);
  }
}

/** Direct provider credentials, no Gateway, fallback, tools or automatic paid retries. */
export async function generate(selection: Selection, prompt: string, turns: Turn[],
  fetcher: typeof fetch = fetch): Promise<ModelResult> {
  const model = modelFor(selection);
  const key = process.env[model.provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'];
  if (!key) throw new ProviderFailure(model.provider, 0, 'missing_key');
  const openai = model.provider === 'openai';
  const body = openai ? {
    model: model.id, instructions: prompt, input: turns, reasoning: { effort: selection.effort },
    max_output_tokens: 4096, store: false,
  } : {
    model: model.id, messages: [{ role: 'system', content: prompt }, ...turns], max_tokens: 4096,
    thinking: { type: selection.effort === 'none' ? 'disabled' : 'enabled' },
    ...(selection.effort !== 'none' ? { reasoning_effort: selection.effort } : {}),
  };
  let response: Response;
  try {
    response = await fetcher(openai ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(85_000),
    });
  } catch { throw new ProviderFailure(model.provider, 0, 'network_or_timeout'); }
  const data = await response.json() as Record<string, any>;
  if (!response.ok) throw new ProviderFailure(model.provider, response.status,
    String(data.error?.code ?? 'provider_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0,60));
  let output: string;
  if (openai) {
    if (data.status && data.status !== 'completed') throw new ProviderFailure(model.provider, 200, 'incomplete_response');
    output = (data.output ?? []).filter((x: any) => x.type === 'message')
      .flatMap((x: any) => x.content ?? []).filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('\n');
  } else {
    if (data.choices?.[0]?.finish_reason !== 'stop') throw new ProviderFailure(model.provider, 200, 'incomplete_response');
    output = data.choices?.[0]?.message?.content ?? '';
  }
  if (!output.trim()) throw new ProviderFailure(model.provider, 200, 'empty_response');
  return { text: output.trim().slice(0,1500), actualModel: data.model ?? model.id,
    inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0 };
}
