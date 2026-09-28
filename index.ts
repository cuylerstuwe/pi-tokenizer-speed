import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import install from './extension.ts';

// Keep the in-process module graph in .ts so Pi's Jiti loader reloads it.
// Native .mjs imports can remain cached across /reload in a running process.

export default function (pi: ExtensionAPI) {
  install(pi, {
    agentDir: getAgentDir(),
    makePPComponent: (getText: () => string, theme: { fg: (color: 'dim', text: string) => string }) => ({
      render: (width: number) => new Text(theme.fg('dim', getText()), 1, 0).render(width),
      invalidate() {},
    }),
  });
}
