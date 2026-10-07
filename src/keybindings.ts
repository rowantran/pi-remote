import { KeybindingsManager, TUI_KEYBINDINGS, type KeybindingDefinitions } from '@earendil-works/pi-tui';

/**
 * Register the documented Pi actions implemented by this client. Public Pi components
 * use the shared manager for hints; pi-tui alone registers only tui.* actions.
 * Keep these keys aligned with RemoteTui's input handlers, not unsupported Pi commands.
 */
export function createRemoteKeybindings(): KeybindingsManager {
  const application: KeybindingDefinitions = {
    'app.interrupt': { defaultKeys: 'escape' },
    'app.clear': { defaultKeys: 'ctrl+c' },
    'app.exit': { defaultKeys: 'ctrl+d' },
    'app.editor.external': { defaultKeys: 'ctrl+g' },
    'app.clipboard.pasteImage': { defaultKeys: 'ctrl+v' },
    'app.model.select': { defaultKeys: 'ctrl+l' },
    'app.model.cycleForward': { defaultKeys: 'ctrl+p' },
    'app.thinking.cycle': { defaultKeys: 'shift+tab' },
    'app.thinking.toggle': { defaultKeys: 'ctrl+t' },
    'app.tools.expand': { defaultKeys: 'ctrl+o' },
    'app.message.followUp': { defaultKeys: 'alt+enter' },
    'app.message.copy': { defaultKeys: 'ctrl+x' },
    'app.tree.foldOrUp': { defaultKeys: ['ctrl+left', 'alt+left'] },
    'app.tree.unfoldOrDown': { defaultKeys: ['ctrl+right', 'alt+right'] },
    // Ctrl+D always detaches; use Alt+D for the tree's default filter instead.
    'app.tree.filter.default': { defaultKeys: 'alt+d' },
    'app.tree.filter.noTools': { defaultKeys: 'ctrl+t' },
    'app.tree.filter.userOnly': { defaultKeys: 'ctrl+u' },
    'app.tree.filter.labeledOnly': { defaultKeys: 'ctrl+l' },
    'app.tree.filter.all': { defaultKeys: 'ctrl+a' },
    'app.tree.filter.cycleForward': { defaultKeys: 'ctrl+o' },
    'app.tree.filter.cycleBackward': { defaultKeys: 'shift+ctrl+o' },
  };
  return new KeybindingsManager({ ...TUI_KEYBINDINGS, ...application });
}
