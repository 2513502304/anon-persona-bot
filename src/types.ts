/** Platform-independent input: future adapters keep the same conversation engine. */
export interface Incoming {
  id: string;
  platform: 'qq';
  group: string;
  user: string;
  text: string;
  timestamp: number;
  scope?: 'group' | 'private';
  role?: 'member' | 'admin' | 'owner';
  union?: string;
  mentions?: { id: string; name?: string; union?: string }[];
}
export interface Selection { key: string; effort: string }
export interface Turn { role: 'user' | 'assistant'; content: string }
export interface Settings { model: Selection; persona: string; history: Record<string, Turn[]> }
export interface Job {
  input: Incoming;
  stage: 'pending' | 'generating' | 'prepared' | 'sending' | 'done';
  reply?: string;
  next?: Settings;
  result?: string;
  media?: { fileInfo: string; expiresAt: number };
}
/** State, inbox and lease share one CAS object, so accepting a message is atomic. */
export interface Session {
  settings: Settings;
  jobs: Job[];
  completed: string[];
  lease?: { token: string; until: number };
  lastResult?: string;
  updatedAt: number;
}
export interface Binding { group: string; owner: string; pairedAt: number }
export interface ModelResult { text: string; actualModel: string; inputTokens: number; outputTokens: number }
