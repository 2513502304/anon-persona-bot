import { DEFAULT_MODEL, MODELS, modelDescription, selectModel } from './models.ts';
import { PERSONAS, findPersona } from './personas.ts';
import type { Settings } from './types.ts';

export function initialSettings(): Settings { return { model: { ...DEFAULT_MODEL }, persona: 'anon', history: {} }; }
const scope = '作用范围：你在当前群中的会话；不改变其他群友的选择。';
/** Commands are parsed outside the model. Invalid options never mutate configuration. */
export function command(text: string, current: Settings, lastResult?: string): { reply: string; next: Settings } | null {
  if (!text.startsWith('/')) return null;
  const next = structuredClone(current);
  const [name, ...args] = text.trim().split(/\s+/);
  const done = (reply: string) => ({ reply, next });
  const help = '/help 帮助\n/model --ls 模型与推理强度\n/model openai:gpt-6.1-sol high\n/model deepseek:deepseek-flash high\n/persona --ls 人格列表\n/persona 千早爱音\n/status 当前设置\n/reset --confirm 清除当前人格的近期聊天记忆\n各命令均支持 --help。\n' + scope;
  if (name === '/help') return done(args.length && args[0] !== '--help' ? '用法：/help' : help);
  if (name === '/ping') return done(args.length && args[0] !== '--help' ? '用法：/ping' : '在线。QQ 收发链路正常。');
  if (name === '/model') {
    if (!args.length) return done(modelDescription(next.model) + '\n' + scope);
    if (args.length === 1 && args[0] === '--help') return done('用法：/model [提供方:模型ID] [推理强度]\n/model --ls 列表\n/model 显示当前设置\n/model openai 或 /model deepseek 使用该提供方默认模型。\n不支持的组合会拒绝，不会自动换模型。\n' + scope);
    if (args.length === 1 && args[0] === '--ls') return done(Object.entries(MODELS).map(([key, m]) => `${key}\n${m.name}；effort: ${m.efforts.join(', ')}；默认 ${m.defaultEffort}`).join('\n\n'));
    const selection = args.length <= 2 ? selectModel(args[0]!, args[1]) : null;
    if (!selection) return done('模型或推理强度不支持，设置未改变。使用 /model --ls 查看可选项。');
    next.model = selection;
    return done('已切换\n' + modelDescription(selection) + '\n' + scope + '\n不会自动回退到其他模型。');
  }
  if (name === '/persona') {
    if (!args.length) return done(`当前人格：${PERSONAS[next.persona]!.name}\n${scope}`);
    if (args.length === 1 && args[0] === '--help') return done('用法：/persona 人格名称\n/persona --ls 列表\n人格与模型独立切换；不同人格分别保存最近 12 轮记忆。\n' + scope);
    if (args.length === 1 && args[0] === '--ls') return done(Object.values(PERSONAS).map(p => p.name).join('\n'));
    const persona = args.length === 1 ? findPersona(args[0]!) : undefined;
    if (!persona) return done('没有这个人格，设置未改变。使用 /persona --ls 查看列表。');
    next.persona = persona;
    return done(`已切换人格：${PERSONAS[persona]!.name}\n${modelDescription(next.model)}\n${scope}`);
  }
  if (name === '/status') {
    if (args.length) return done('用法：/status。查看人格、精确模型、推理强度和近期处理状态。');
    return done(`人格：${PERSONAS[next.persona]!.name}\n${modelDescription(next.model)}\n${scope}\n当前人格记忆：${Math.floor((next.history[next.persona]?.length ?? 0)/2)}/12 轮\n最近处理：${lastResult ?? '无'}\n仅角色扮演，无工具执行能力。`);
  }
  if (name === '/reset') {
    if (args.length !== 1 || args[0] !== '--confirm') return done('用法：/reset --confirm\n仅清除你在当前群、当前人格的最近聊天记忆；保留模型与人格设置。');
    next.history[next.persona] = [];
    return done('当前人格的近期聊天记忆已清除。');
  }
  return done('未知命令。使用 /help 查看帮助。');
}
