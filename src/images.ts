import { ProviderFailure } from './models.ts';

export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;
export interface ImageRequest { model: string; prompt: string; quality: string; size: string; complexity: string }
export const IMAGE_LIST = `【图片模型】
openai:gpt-image-2.6-flare（默认）
openai:gpt-image-2.6-sunburst

两者均支持：quality low / medium / high；size 1024x1024 / 1536x1024 / 1024x1536；complexity low / medium / high。
默认 medium 质量、1024x1024、medium complexity。
/image --model 模型ID 描述：选择模型；例：/image --model gpt-image-2.6-sunburst 水彩猫`;
export const IMAGE_HELP = `【图片生成】
/image 描述：生成一张图片，占 1 次个人额度；例：/image 戴蓝色围巾的水彩小猫
/image --ls：列出可用图片模型与参数。
/image --model 模型ID 描述：指定模型；例：/image --model gpt-image-2.6-sunburst 海边落日
/image --quality 质量 描述：low / medium / high；例：/image --quality high 海边落日
/image --size 尺寸 描述：1024x1024 / 1536x1024 / 1024x1536；例：/image --size 1536x1024 海边落日
/image --complexity 强度 描述：low / medium / high；例：/image --complexity high 海边落日

默认 openai:gpt-image-2.6-flare，medium 质量，1024x1024，medium complexity。
complexity 是生图规划计算量，与文字模型 effort 独立。选项可组合，均放在描述前。
描述以 -- 开头时先用 -- 分隔；例：/image -- --help 主题海报
返回 JPEG 图片并标注请求模型；不改变聊天模型。失败不换模型、不自动重试；超时也计 1 次。
此入口为文字生成图片，暂不支持上传图片编辑。`;

/** Parse every option before reserving quota; reject unknown models instead of falling back. */
export function imageCommand(text: string): { reply?: string; request?: ImageRequest } | null {
  if (!/^\/image(?:\s|$)/.test(text)) return null;
  let rest = text.slice(6).trim();
  if (rest === '--ls') return { reply: IMAGE_LIST };
  if (!rest || rest === '--help') return { reply: IMAGE_HELP };
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
