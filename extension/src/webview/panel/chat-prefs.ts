import type { ChatPrefs, ExtensionInfo } from '../../shared/protocol';

export type BooleanPrefKey =
  | 'autoExpandReasoning'
  | 'autoExpandToolCalls'
  | 'autoExpandSubagentCalls'
  | 'suppressCompletionNotifications';

export type ChatPrefKey = keyof ChatPrefs;
export type ChatPrefContextType = 'reasoning' | 'toolCalls' | 'subagentCalls';
export type TranscriptContextMenuType = ChatPrefContextType | 'message';

export interface ExtensionToggleItem {
  id: string;
  label: string;
}

export interface ChatPrefMenuItem {
  key: BooleanPrefKey;
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

export function toggleChatPref(prefs: ChatPrefs, key: BooleanPrefKey): Partial<ChatPrefs> {
  return { [key]: !prefs[key] } as Partial<ChatPrefs>;
}

export function getChatPrefContextKey(type: ChatPrefContextType): BooleanPrefKey {
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

export function setExtensionEnabled(prefs: ChatPrefs, extensionId: string, enabled: boolean): Partial<ChatPrefs> {
  return {
    extensionToggles: {
      ...prefs.extensionToggles,
      [extensionId]: enabled,
    },
  };
}
export function setProviderEnabled(prefs: ChatPrefs, provider: string, enabled: boolean): Partial<ChatPrefs> {
  return {
    providerToggles: {
      ...prefs.providerToggles,
      [provider]: enabled,
    },
  };
}
