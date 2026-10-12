import { Loader, truncateToWidth } from '@earendil-works/pi-tui';

/** Public Loader, with the border adapter required by Pi's public CustomEditor. */
export class WorkingIndicator extends Loader {
  readonly kind = 'working';

  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? '';
    return truncateToWidth(line.startsWith(' ') ? line.slice(1).trimEnd() : line.trimEnd(), width, '');
  }

  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, '');
  }

  dispose(): void { this.stop(); }
}
