import { createContext } from 'react';
import { AutomationClipboardItem, ClipboardBlockType } from '../../types/automation';

export const CLIPBOARD_STORAGE_KEY = 'can_do_automation_clipboard_v1';

export interface AutomationClipboardContextType {
  clipboard: AutomationClipboardItem | null;
  copyToClipboard: (type: ClipboardBlockType, data: any, label: string) => void;
  clearClipboard: () => void;
  pastePayload: (targetType?: ClipboardBlockType) => any;
}

export const AutomationClipboardContext = createContext<AutomationClipboardContextType>({
  clipboard: null,
  copyToClipboard: () => {},
  clearClipboard: () => {},
  pastePayload: () => null
});

