import { preparePackagedRuntime } from './runtime.mjs';
import { RuntimeLog } from '../../workflow/tools/lib/runtime_logging.mjs';

try {
  const readOnly = process.argv.some(x => ['--doctor', '--backup', '--verify-backup'].includes(x));
  preparePackagedRuntime({ readOnly });
  if (!readOnly) await new RuntimeLog({ warning: code => process.stderr.write(`[logging] ${code}\n`) }).write('HEADLESS_STARTED', { subsystem: 'headless' });
  const { main } = await import('../../workflow/tools/runner/main.mjs');
  process.exitCode = await main(process.argv.slice(2));
} catch {
  if (!process.argv.some(x => ['--doctor', '--backup', '--verify-backup'].includes(x))) await new RuntimeLog().write('HEADLESS_START_FAILED', { subsystem: 'headless' });
  process.stderr.write('PAPERECHO_HEADLESS_START_FAILED\n');
  process.exitCode = 2;
}
