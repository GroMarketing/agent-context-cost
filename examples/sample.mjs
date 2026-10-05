// Renders the README sample from the synthetic fixture with the real
// formatter: node examples/sample.mjs [--markdown] [--tool all]
import { makeFixture, FIXTURE_NOW } from './fixture.mjs';
import { scan, format } from '../src/index.mjs';

const args = process.argv.slice(2);
const fx = makeFixture();
try {
  const report = await scan({
    home: fx.home, project: fx.project, env: {}, now: FIXTURE_NOW,
    tools: args.includes('--tool') ? args[args.indexOf('--tool') + 1].split(',').map((s) => (s === 'all' ? ['claude', 'cursor', 'codex', 'gemini'] : [s])).flat() : ['claude'],
  });
  process.stdout.write(format(report, { markdown: args.includes('--markdown'), top: 5 }));
} finally {
  fx.cleanup();
}
