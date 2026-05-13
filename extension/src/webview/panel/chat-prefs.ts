import type { ChatPrefs } from '../../shared/protocol';

export type ChatPrefKey = keyof ChatPrefs;
export type ChatPrefContextType = 'reasoning' | 'toolCalls' | 'subagentCalls';
export type TranscriptContextMenuType = ChatPrefContextType | 'message';

export interface ChatPrefMenuItem<K extends ChatPrefKey = ChatPrefKey> {
  key: K;
  label: string;
}

export interface ChatPrefMenuSection {
  id: string;
  label?: string;
  items: ChatPrefMenuItem[];
}

const CHAT_PREF_CONTEXT_ITEMS: Record<ChatPrefContextType, ChatPrefMenuItem> = {
  reasoning: {
    key: 'autoExpandReasoning',
    label: 'Auto-expand reasoning',
  },
  toolCalls: {
    key: 'autoExpandToolCalls',
    label: 'Auto-expand tool calls',
  },
  subagentCalls: {
    key: 'autoExpandSubagentCalls',
    label: 'Auto-expand sub-agent calls',
  },
};

export const CHAT_PREF_MENU_SECTIONS: readonly ChatPrefMenuSection[] = [
  {
    id: 'transcript',
    label: 'Transcript',
    items: [
      CHAT_PREF_CONTEXT_ITEMS.reasoning,
      CHAT_PREF_CONTEXT_ITEMS.toolCalls,
      CHAT_PREF_CONTEXT_ITEMS.subagentCalls,
    ],
  },
  {
    id: 'notifications',
    label: 'Alerts',
    items: [
      {
        key: 'suppressCompletionNotifications',
        label: 'Suppress completion alerts',
      },
    ],
  },
] as const;

export function toggleChatPref<K extends ChatPrefKey>(prefs: ChatPrefs, key: K): Pick<ChatPrefs, K> {
  return { [key]: !prefs[key] } as Pick<ChatPrefs, K>;
}

export function getChatPrefContextKey(type: ChatPrefContextType): ChatPrefKey {
  return CHAT_PREF_CONTEXT_ITEMS[type].key;
}

export function getChatPrefContextLabel(type: ChatPrefContextType): string {
  return CHAT_PREF_CONTEXT_ITEMS[type].label;
}

export function getChatPrefContextValue(prefs: ChatPrefs, type: ChatPrefContextType): boolean {
  return prefs[getChatPrefContextKey(type)];
}

export function toggleChatPrefForContext(
  prefs: ChatPrefs,
  type: ChatPrefContextType,
): Partial<ChatPrefs> {
  return toggleChatPref(prefs, getChatPrefContextKey(type));
}

export function getToolCallContextType(toolName: string): Exclude<ChatPrefContextType, 'reasoning'> {
  return toolName === 'subagent' ? 'subagentCalls' : 'toolCalls';
}
