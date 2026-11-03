import { parseRunnerArgs } from './args.mjs';
import { resolveRuntimePaths, buildRuntimeConfig, resolveApplicationRuntimeContext } from '../lib/runtime_config.mjs';
import { createControlServices } from '../lib/control_application_services.mjs';
import { redactSecrets, secretValues } from '../lib/credential_registry.mjs';

// --doctor is exclusive; --check and normal Runner execution keep their existing semantics.
export async function doctorMain(argv, { env = process.env, cwd, stdout = process.stdout } = {}) {
  const fail = summary => ({ schemaVersion: 1, status: 'FAIL', summary, canRun: false,
    checks: [{ checkId: 'doctor.startup', status: 'FAIL', severity: 'blocking', blocking: true, summary, actionableHint: '检查调用参数、数据根和配置；Doctor 不修改用户状态。' }] });
  let report;
  try {
    if (argv.some(value => value.startsWith('--') && value !== '--doctor' && !/^--config(?:=|$)/.test(value)) || argv.filter(x => x === '--doctor').length !== 1) throw new Error();
    const paths = resolveRuntimePaths({ ...(cwd ? { applicationRoot: cwd } : {}), env });
    const root = paths.applicationRoot;
    const args = argv.filter(x => x !== '--doctor');
    const parsed = parseRunnerArgs(['--check', ...args], { cwd: paths.userDataRoot, allowUnresolvedMode: true });
    let context;
    try { context = await resolveApplicationRuntimeContext({ cwd: root, env, argv: args, readOnly: true }); }
    catch { context = { ...buildRuntimeConfig({ cwd: root, env, argv: [] }), ...(parsed.configPath ? { configPath: parsed.configPath } : {}) }; }
    const services = createControlServices({ root, env, context });
    report = await services.doctor.status();
  } catch { report = fail('Doctor 无法安全启动：检查参数、目录边界或配置'); }
  stdout.write(`${redactSecrets(JSON.stringify(report), secretValues(env))}\n`);
  // Warning-only results are usable; unknown evidence is a distinct non-success outcome.
  return report.status === 'FAIL' ? 2 : report.status === 'UNKNOWN' ? 3 : 0;
}
