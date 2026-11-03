import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Another extension that sets its own editor at session start, as many editor extensions do. */
class FixtureEditor extends CustomEditor {}

export default function customEditorExtension(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new FixtureEditor(tui, theme, keybindings));
  });
}
