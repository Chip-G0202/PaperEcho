import { preparePackagedRuntime } from './runtime.mjs';

try {
  preparePackagedRuntime({ readOnly: process.argv.includes('--doctor') });
  const { main } = await import('../../workflow/tools/runner/main.mjs');
  process.exitCode = await main(process.argv.slice(2));
} catch {
  process.stderr.write('PAPERECHO_HEADLESS_START_FAILED\n');
  process.exitCode = 2;
}
