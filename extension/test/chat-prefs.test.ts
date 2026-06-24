import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_PREF_MENU_SECTIONS,
  getChatPrefContextKey,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  getToolCallContextType,
  toggleChatPref,
  toggleChatPrefForContext,
} from '../src/webview/panel/chat-prefs';
import type { ChatPrefs } from '../src/shared/protocol';

const prefs: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: true,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  subagentAlwaysParentModel: false,
  subagentMaxDepth: 3,
  subagentMaxTreeSessions: 50,
  completionSoundVolume: 50,
  uiBaseFontSize: 13,
  uiComposerFontSize: 13,
  expandedSectionFontSize: 12,
  expandedSectionMaxHeight: 240,
  uiFontSans: '',
  uiFontMono: '',
  uiAccentColor: '',
  uiMutedColor: '',
  uiLinkColor: '',
  uiMessageWidth: 88,
  uiBackground: '',
  uiForeground: '',
  uiBorder: '',
  uiCornerRadius: 8,
  uiDensity: 'comfortable',
  extensionToggles: {},
  providerToggles: {},
  activityTailLines: 2,
};

test('chat pref menu sections expose transcript and notifications toggles', () => {
  assert.equal(CHAT_PREF_MENU_SECTIONS.length, 2);
  assert.equal(CHAT_PREF_MENU_SECTIONS[0]?.id, 'transcript');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[0]?.items.map((item) => item.key),
    ['autoExpandReasoning', 'autoExpandToolCalls', 'autoExpandSubagentCalls'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[1]?.id, 'notifications');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[1]?.items.map((item) => item.key),
    ['suppressCompletionNotifications'],
  );
});

test('context helpers map transcript block types to the right pref metadata', () => {
  assert.equal(getChatPrefContextKey('reasoning'), 'autoExpandReasoning');
  assert.equal(getChatPrefContextKey('toolCalls'), 'autoExpandToolCalls');
  assert.equal(getChatPrefContextKey('subagentCalls'), 'autoExpandSubagentCalls');
  assert.equal(getChatPrefContextLabel('reasoning'), 'Auto-expand reasoning');
  assert.equal(getChatPrefContextLabel('toolCalls'), 'Auto-expand tool calls');
  assert.equal(getChatPrefContextLabel('subagentCalls'), 'Auto-expand sub-agent calls');
  assert.equal(getChatPrefContextValue(prefs, 'reasoning'), false);
  assert.equal(getChatPrefContextValue(prefs, 'toolCalls'), true);
  assert.equal(getChatPrefContextValue(prefs, 'subagentCalls'), false);
  assert.equal(getToolCallContextType('read'), 'toolCalls');
  assert.equal(getToolCallContextType('subagent'), 'subagentCalls');
});

test('toggle helpers return partial pref patches without mutating source prefs', () => {
  assert.deepEqual(toggleChatPref(prefs, 'autoExpandReasoning'), { autoExpandReasoning: true });
  assert.deepEqual(toggleChatPref(prefs, 'suppressCompletionNotifications'), {
    suppressCompletionNotifications: true,
  });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'toolCalls'), { autoExpandToolCalls: false });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'subagentCalls'), { autoExpandSubagentCalls: true });
  assert.deepEqual(prefs, {
    autoExpandReasoning: false,
    autoExpandToolCalls: true,
    autoExpandSubagentCalls: false,
    suppressCompletionNotifications: false,
    showPruningMessages: true,
    subagentAlwaysParentModel: false,
    subagentMaxDepth: 3,
    subagentMaxTreeSessions: 50,
    completionSoundVolume: 50,
    uiBaseFontSize: 13,
    uiComposerFontSize: 13,
    expandedSectionFontSize: 12,
    expandedSectionMaxHeight: 240,
    uiFontSans: '',
    uiFontMono: '',
    uiAccentColor: '',
    uiMutedColor: '',
    uiLinkColor: '',
    uiMessageWidth: 88,
    uiBackground: '',
    uiForeground: '',
    uiBorder: '',
    uiCornerRadius: 8,
    uiDensity: 'comfortable',
    extensionToggles: {},
    providerToggles: {},
    activityTailLines: 2,
  });
});
