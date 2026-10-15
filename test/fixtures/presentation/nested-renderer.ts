import type { MessageRenderer } from '@earendil-works/pi-coding-agent';

// No execution factory is needed to register a display-only module.
export const renderNotice: MessageRenderer = (message, options, theme) => ({
  invalidate() {},
  // Ignore width deliberately: the host must clamp styled, wide-character output.
  render() {
    return [theme.fg('accent', `${message.details.id}:${options.expanded}:${options.outputPad}` + ' 世界'.repeat(40)),
      ...(options.expanded ? ['fixture details'] : [])];
  },
});
