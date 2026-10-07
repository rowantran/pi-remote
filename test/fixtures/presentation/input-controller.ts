import {Editor} from '@earendil-works/pi-tui';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function trustedInputController(pi:ExtensionAPI) {
  pi.on('session_start',(_event,ctx)=>{
    ctx.ui.setEditorComponent((tui,theme)=>{
      const editor=new Editor(tui,theme);
      (globalThis as any)[Symbol.for('pi-remote.test.input-controller')]=editor;
      return editor;
    });
  });
}
