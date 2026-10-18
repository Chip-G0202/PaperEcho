import { RestoreTransaction } from '../../workflow/tools/recovery/restore_transaction.mjs';
const [action, encoded, step, rollbackFault] = process.argv.slice(2);
const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
const service = new RestoreTransaction({ env: options.env, hook: async phase => {
  if (phase === step) {
    process.send({ phase });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (phase === rollbackFault) throw new Error('DUMMY_ROLLBACK_INJECTION');
} });
try {
  if (action === 'replace') await service.replace({ ...options, password: Buffer.from('dummy-transaction-password'), confirm: async () => true });
  else await service.recover({ target: options.target, confirm: async () => true });
  process.send({ result: 'completed' }); process.disconnect();
} catch (e) { process.send({ error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'TEST_CHILD_FAILED' }); process.disconnect(); process.exitCode = 1; }
