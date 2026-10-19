import { parseRunnerArgs } from '../runner/args.mjs';
import { resolveRunnerConfiguration } from '../runner/config_loader.mjs';
import { runPreflight } from '../runner/preflight.mjs';
import { inspectRestoreTransaction } from '../recovery/restore_transaction_status.mjs';

// Readiness is derived from saved owners; no completion flag, credential copy or workflow execution.
export class SetupService {
  constructor({ config, context, env }) { Object.assign(this, { config, context, env }); }
  async status() {
    if (inspectRestoreTransaction(this.context.userDataRoot).blocking) return { needsSetup: false, restoreRequired: true, canRun: false, status: 'blocked', requiredMissing: [], optionalMissing: [], readiness: [] };
    const settings = await this.config.list();
    const mode = settings.find(x => x.id === 'runtime.mode');
    const roots = { layout: this.context.layout, userDataRoot: this.context.userDataRoot, cacheRoot: this.context.cacheRoot, activeMode: this.context.mode };
    const base = { roots, persisted: mode?.ownerPresent === true };
    if (!base.persisted) return { ...base, needsSetup: true, canRun: false, requiredMissing: [{ name: '运行路径与基础配置', configure: '选择运行路径并保存基础配置' }], optionalMissing: [], readiness: [] };
    try {
      const cli = parseRunnerArgs(['--check', '--config', this.config.ownerPath('paperecho.config.json')], { allowUnresolvedMode: true, cwd: this.context.userDataRoot });
      const resolved = await resolveRunnerConfiguration(cli, { env: this.env, cwd: this.context.applicationRoot });
      const report = await runPreflight(resolved.options, { env: resolved.env });
      const recoveryRequired = report.startupRecovery?.blocking === true;
      const summaries = entries => entries.map(({ name, purpose, configure }) => ({ name, purpose, configure }));
      return { ...base, needsSetup: !report.canRun && !recoveryRequired, recoveryRequired, canRun: report.canRun, mode: report.mode, status: report.status,
        requiredMissing: summaries(report.requiredMissing), optionalMissing: summaries([...report.featureMissing, ...report.optionalMissing]), readiness: report.readiness };
    } catch (error) {
      // Fixed messages only: configuration/parser exceptions may contain private inputs.
      return { ...base, needsSetup: true, canRun: false, requiredMissing: [{ name: '基础配置仍需检查', configure: '检查运行路径、输入和配置格式' }], optionalMissing: [], readiness: [], error: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'SETUP_CHECK_FAILED' };
    }
  }
}
