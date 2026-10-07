import { KeybindingsManager, TUI_KEYBINDINGS, type KeybindingDefinitions } from '@earendil-works/pi-tui';

/**
 * Register the documented Pi actions implemented by this client. Public Pi components
 * use the shared manager for hints; pi-tui alone registers only tui.* actions.
 * Keep these keys aligned with RemoteTui's input handlers, not unsupported Pi commands.
 */
export function createRemoteKeybindings(): KeybindingsManager {
  const application: KeybindingDefinitions = {
    'app.interrupt': { defaultKeys: 'escape' },
    'app.exit': { defaultKeys: 'ctrl+d' },
    'app.editor.external': { defaultKeys: 'ctrl+g' },
    'app.clipboard.pasteImage': { defaultKeys: 'ctrl+v' },
    'app.model.select': { defaultKeys: 'ctrl+l' },
    'app.model.cycleForward': { defaultKeys: 'ctrl+p' },
    'app.thinking.cycle': { defaultKeys: 'shift+tab' },
    'app.thinking.toggle': { defaultKeys: 'ctrl+t' },
    'app.tools.expand': { defaultKeys: 'ctrl+o' },
    'app.message.followUp': { defaultKeys: 'alt+enter' },
  };
  return new KeybindingsManager({ ...TUI_KEYBINDINGS, ...application });
}
