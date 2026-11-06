import { DEFAULT_MODEL, MODELS, modelDescription, selectModel } from './models.ts';
import { PERSONAS, findPersona } from './personas.ts';
import type { Settings } from './types.ts';

export function initialSettings(): Settings { return { model: { ...DEFAULT_MODEL }, persona: 'anon', history: {} }; }
/** Commands are parsed outside the model. Invalid options never mutate configuration. */
export function command(text: string, current: Settings, lastResult?: string, privateChat = false): { reply: string; next: Settings } | null {
  if (!text.startsWith('/')) return null;
  const next = structuredClone(current);
  const [name, ...args] = text.trim().split(/\s+/);
  const done = (reply: string) => ({ reply, next });
  const scope = `作用范围：你在当前${privateChat ? '私聊' : '群'}中的会话；不改变其他群友的选择。`;
  const help = `ANON 使用帮助

【开始聊天】
群里先 @ANON，再说话或输入命令；私聊直接发送。
/help：查看完整帮助。
/ping：检查机器人是否在线，不调用模型。

【模型与推理强度】
/model：查看当前模型与 effort。
/model --ls：列出可选模型及各自支持的推理强度。
/model 模型名称 [强度]：切换精确模型；省略强度使用该模型默认值。
例：/model openai:gpt-6.1-sol high
例：/model deepseek:deepseek-flash high
提供方、模型与强度会明确显示；失败不自动换模型。

【人格】
/persona：查看当前人格。
/persona --ls：列出千早爱音、芙宁娜、喜多郁代。
/persona 人格名称：切换人格，不改变模型。
例：/persona 芙宁娜
不同人格分别保留最近 12 轮聊天。

【设置与记忆】
/status：查看人格、模型、推理强度、记忆和上次结果。
/reset --confirm：清除当前人格的近期记忆，保留模型设置。

【个人额度】
/usage：查看个人编号、身份、今日已用与剩余额度。
普通成员每天 10 次，管理员 100 次，群主无限次。
北京时间 00:00 重置；群聊和已绑定私聊共享额度。
帮助、设置等命令不扣次数；模型请求失败或超时也计一次。
/usage-limit 100 @成员：群主设置该成员每天 100 次。
/usage-limit --reset @成员：群主恢复其身份默认额度。

【私聊绑定】
/link：私聊获取绑定码；按提示在群里验证，再回私聊确认。
身份关联后共享额度，群聊与私聊的记忆仍然分开。

【图片生成】
/image 描述：生成一张图片，占 1 次额度。
例：/image 一只戴蓝色围巾的小猫，水彩画
/image --help：查看精确生图模型、质量、尺寸与 complexity。
默认 gpt-image-2.6-flare；失败不自动换模型。

各命令均支持 --help。
${scope}
目前支持文字聊天与 /image 生图；尚未接入识图、图像编辑和语音。`;
  if (name === '/help') return done(args.length && args[0] !== '--help' ? '用法：/help' : help);
  if (name === '/ping') return done(args[0] === '--help' ? '用法：/ping\n检查 QQ 收发链路；不调用模型、不消耗个人额度。' : args.length ? '用法：/ping' : '在线。QQ 收发链路正常。');
  if (name === '/model') {
    if (!args.length) return done(modelDescription(next.model) + '\n' + scope);
    if (args.length === 1 && args[0] === '--help') return done('【模型与推理强度】\n/model：查看当前设置。\n/model --ls：列出所有模型、支持的 effort 与默认值。\n/model 提供方:模型ID [effort]：精确切换模型。\n\n示例：\n/model openai:gpt-6.1-sol high\n/model openai:gpt-6.1-terra high\n/model deepseek:deepseek-flash high\n\n/model openai 或 /model deepseek：使用该提供方默认模型。\n不支持的组合会拒绝；失败不自动换模型。切换不扣额度。\n\n' + scope);
    if (args.length === 1 && args[0] === '--ls') return done(Object.entries(MODELS).map(([key, m]) => `${key}\n${m.name}；effort: ${m.efforts.join(', ')}；默认 ${m.defaultEffort}`).join('\n\n'));
    const selection = args.length <= 2 ? selectModel(args[0]!, args[1]) : null;
    if (!selection) return done('模型或推理强度不支持，设置未改变。使用 /model --ls 查看可选项。');
    next.model = selection;
    return done('已切换\n' + modelDescription(selection) + '\n' + scope + '\n不会自动回退到其他模型。');
  }
  if (name === '/persona') {
    if (!args.length) return done(`当前人格：${PERSONAS[next.persona]!.name}\n${scope}`);
    if (args.length === 1 && args[0] === '--help') return done('【人格】\n/persona：查看当前人格。\n/persona --ls：查看可选人格。\n/persona 人格名称：切换人格，不改变模型。\n\n示例：/persona 芙宁娜\n可选：千早爱音、芙宁娜、喜多郁代。\n不同人格分别保存最近 12 轮记忆；切换不清空旧人格记忆，不扣额度。\n\n' + scope);
    if (args.length === 1 && args[0] === '--ls') return done(Object.values(PERSONAS).map(p => p.name).join('\n'));
    const persona = args.length === 1 ? findPersona(args[0]!) : undefined;
    if (!persona) return done('没有这个人格，设置未改变。使用 /persona --ls 查看列表。');
    next.persona = persona;
    return done(`已切换人格：${PERSONAS[persona]!.name}\n${modelDescription(next.model)}\n${scope}`);
  }
  if (name === '/status') {
    if (args.length) return done('用法：/status。查看人格、精确模型、推理强度和近期处理状态。');
    return done(`人格：${PERSONAS[next.persona]!.name}\n${modelDescription(next.model)}\n${scope}\n当前人格记忆：${Math.floor((next.history[next.persona]?.length ?? 0)/2)}/12 轮\n最近处理：${lastResult ?? '无'}\n支持 /image 生图；不执行网页、文件或终端任务。\n/usage 查看共享个人额度。`);
  }
  if (name === '/reset') {
    if (args.length !== 1 || args[0] !== '--confirm') return done('用法：/reset --confirm\n仅清除你在当前会话、当前人格的最近聊天记忆；保留模型与人格设置，不重置每日额度。');
    next.history[next.persona] = [];
    return done('当前人格的近期聊天记忆已清除。');
  }
  return done('未知命令。使用 /help 查看帮助。');
}
