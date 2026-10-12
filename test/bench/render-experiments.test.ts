import assert from 'node:assert/strict';
import test from 'node:test';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { installRenderExperiment } from './render-experiments.js';

const document = { render: () => ['document'] };

test('normal benchmark mode does not replace any rendering methods', () => {
  const original = ToolExecutionComponent.prototype.render;
  const originalDocument = document.render;
  const restore = installRenderExperiment('none', { document });
  assert.equal(ToolExecutionComponent.prototype.render, original);
  assert.equal(document.render, originalDocument);
  restore();
});

test('diagnostic footer/document freezing is width-keyed and restored after the run', () => {
  let renders = 0;
  const component = { render: (width: number) => { renders++; return [`width:${width}`]; } };
  const original = component.render;
  const restore = installRenderExperiment('cache-document-and-footer', { document: component, footer: { render: () => ['footer'] } });
  try {
    assert.deepEqual(component.render(80), ['width:80']);
    assert.deepEqual(component.render(80), ['width:80']);
    assert.equal(renders, 1);
    assert.deepEqual(component.render(40), ['width:40']);
    assert.equal(renders, 2);
  } finally { restore(); }
  assert.equal(component.render, original);
  component.render(40);
  assert.equal(renders, 3);
});

test('settled-tool ablation does not freeze partial results and observes native updates', () => {
  initTheme('dark', false);
  let renders = 0;
  const ui = { requestRender() {} } as TUI;
  const tool = new ToolExecutionComponent('fixture', 'call', { value: 'initial' }, { showImages: false }, {
    renderShell: 'self',
    renderCall: (args) => ({
      render() { renders++; return [`value:${(args as { value: string }).value}`]; }, invalidate() {},
    }),
  }, ui, '/tmp');
  const original = ToolExecutionComponent.prototype.render;
  const restore = installRenderExperiment('cache-settled-tools', { document });
  try {
    tool.render(80); tool.render(80);
    assert.equal(renders, 2, 'unsettled call still renders every time');
    tool.updateResult({ content: [{ type: 'text', text: 'done' }], isError: false }, false);
    const output = tool.render(80);
    assert.equal(tool.render(80), output);
    assert.equal(renders, 3);
    tool.render(40);
    assert.equal(renders, 4, 'resize invalidates width cache');
    tool.updateArgs({ value: 'changed' });
    assert.match(stripTerminalSequences(tool.render(40).join('\n')), /value:changed/);
    assert.equal(renders, 5, 'native updateDisplay invalidates the diagnostic cache');
    tool.setExpanded(true); tool.render(40);
    assert.equal(renders, 6);
    tool.invalidate(); tool.render(40);
    assert.equal(renders, 7);
    tool.updateResult({ content: [{ type: 'text', text: 'partial' }], isError: false }, true);
    tool.render(40); tool.render(40);
    assert.equal(renders, 9, 'partial results bypass caching');
  } finally { restore(); }
  assert.equal(ToolExecutionComponent.prototype.render, original);
});
