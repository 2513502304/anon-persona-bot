import { ProviderFailure } from './models.ts';

export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;
export interface ImageRequest { model: string; prompt: string; quality: string; size: string; complexity: string }
export const IMAGE_HELP = `【图片生成】
/image 描述：生成一张图片，占 1 次个人额度；不会改变聊天模型。
默认：openai:gpt-image-2.6-flare，medium 质量，1024x1024，medium complexity。

例：/image 一只戴蓝色围巾的小猫，水彩画
例：/image --model gpt-image-2.6-sunburst --quality high --size 1536x1024 海边的落日

/image --ls：查看模型与选项。
--model：gpt-image-2.6-flare / gpt-image-2.6-sunburst
--quality：low / medium / high
--size：1024x1024 / 1536x1024 / 1024x1536
--complexity：low / medium / high（生图规划计算量，不是文字模型 effort）
所有选项放在描述前；描述以 -- 开头时，先用单独的 -- 分隔。
返回 JPEG 图片并标注实际请求模型。失败不换模型、不自动重复扣费；超时也计 1 次。
此入口为文字生成图片，暂不支持上传图片编辑。`;

/** Parse every option before reserving quota; reject unknown models instead of falling back. */
export function imageCommand(text: string): { reply?: string; request?: ImageRequest } | null {
  if (!/^\/image(?:\s|$)/.test(text)) return null;
  let rest = text.slice(6).trim();
  if (!rest || rest === '--help' || rest === '--ls') return { reply: IMAGE_HELP };
  const request: ImageRequest = { model: IMAGE_MODELS[0], prompt: '', quality: 'medium', size: '1024x1024', complexity: 'medium' };
  const used = new Set<string>();
  while (rest.startsWith('--')) {
    if (/^--(?:\s|$)/.test(rest)) { rest = rest.slice(2).trim(); break; }
    const match = rest.match(/^--(model|quality|size|complexity)\s+(\S+)(?:\s+|$)/);
    if (!match || used.has(match[1]!)) return { reply: '生图参数不支持或重复，未调用模型。\n' + IMAGE_HELP };
    used.add(match[1]!);
    request[match[1] as 'model' | 'quality' | 'size' | 'complexity'] = match[2]!;
    rest = rest.slice(match[0].length).trim();
  }
  request.model = request.model.replace(/^openai:/, ''); request.prompt = rest;
  if (!request.prompt || !IMAGE_MODELS.includes(request.model as typeof IMAGE_MODELS[number]) ||
      !['low','medium','high'].includes(request.quality) || !['low','medium','high'].includes(request.complexity) ||
      !['1024x1024','1536x1024','1024x1536'].includes(request.size)) return { reply: '模型、参数或描述无效，未调用模型。\n' + IMAGE_HELP };
  return { request };
}

/** One paid POST, bounded by QQ's passive-reply window. Never retry an ambiguous generation. */
export async function generateImage(request: ImageRequest, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (!process.env.OPENAI_API_KEY) throw new ProviderFailure('openai-image', 0, 'missing_key');
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, n: 1, output_format: 'jpeg', output_compression: 85, moderation: 'auto' }),
      signal: AbortSignal.timeout(160_000),
    });
  } catch { throw new ProviderFailure('openai-image', 0, 'network_or_timeout'); }
  const data = await response.json() as { data?: { b64_json?: string }[]; error?: { code?: string } };
  if (!response.ok) throw new ProviderFailure('openai-image', response.status,
    String(data.error?.code ?? 'provider_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60));
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded || encoded.length > 4_800_000) throw new ProviderFailure('openai-image', 200, 'empty_or_oversize_image');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new ProviderFailure('openai-image', 200, 'unexpected_image_format');
  return bytes;
}
