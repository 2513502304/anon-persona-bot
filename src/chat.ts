import { Chat, Message, parseMarkdown, type Adapter, type AdapterPostableMessage } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { replyQQ } from './qq.ts';
import type { Incoming } from './types.ts';

/** QQ adapter uses request-scoped reply context; never a process-global last-message Map. */
export function qqAdapter(input: Incoming, send: typeof replyQQ = replyQQ): Adapter<string, Incoming> {
  const threadId = `qq:${input.group}:${input.user}`;
  const unsupported = async (): Promise<never> => { throw new Error('Unsupported QQ operation'); };
  return {
    name: 'qq', userName: 'Anon',
    initialize: async () => {},
    encodeThreadId: id => id, decodeThreadId: id => id,
    channelIdFromThreadId: () => `qq:${input.group}`,
    fetchMessages: async () => ({ messages: [] }),
    fetchThread: async () => ({ id: threadId, channelId: `qq:${input.group}`, metadata: {}, isDM: false }),
    parseMessage: raw => new Message({ id: raw.id, threadId, text: raw.text, formatted: parseMarkdown(raw.text), raw,
      attachments: [], author: { userId: raw.user, userName: raw.user, fullName: '群友', isBot: false, isMe: false },
      metadata: { dateSent: new Date(raw.timestamp), edited: false }, isMention: true }),
    postMessage: async (_thread, message: AdapterPostableMessage) => {
      const text = typeof message === 'string' ? message : 'raw' in message ? message.raw : 'markdown' in message ? message.markdown : '';
      if (typeof text !== 'string' || !text) throw new Error('Only plain text replies are supported');
      const id = await send(input, text);
      return { id, threadId, raw: input };
    },
    renderFormatted: () => input.text,
    handleWebhook: async () => new Response('Use signed ingress', { status: 405 }),
    addReaction: unsupported, removeReaction: unsupported, deleteMessage: unsupported, editMessage: unsupported,
    startTyping: async () => {},
  };
}

/** SDK handles message normalization/posting only. Blob Engine owns all durable state and leases. */
export async function deliverThroughChat(input: Incoming, text: string, send: typeof replyQQ = replyQQ): Promise<string> {
  const adapter = qqAdapter(input, send);
  const chat = new Chat({ userName: 'Anon', adapters: { qq: adapter }, state: createMemoryState(), concurrency: 'concurrent', logger: 'silent' });
  let delivered = false;
  let failure: unknown;
  chat.onNewMention(async thread => {
    try { await thread.post({ raw: text }); delivered = true; }
    catch (error) { failure = error; }
  });
  await chat.initialize();
  await chat.processMessage(adapter, adapter.encodeThreadId(`qq:${input.group}:${input.user}`), adapter.parseMessage(input));
  await chat.shutdown();
  if (failure) throw failure;
  if (!delivered) throw new Error('Chat SDK did not dispatch reply');
  return input.id;
}
