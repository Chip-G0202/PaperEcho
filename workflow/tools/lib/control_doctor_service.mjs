import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parseRunnerArgs } from '../runner/args.mjs';
import { resolveRunnerConfiguration } from '../runner/config_loader.mjs';
import { runPreflight } from '../runner/preflight.mjs';
import { resolveRuntimePaths, prepareRuntimePaths, resolveApplicationRuntimeContext } from './runtime_config.mjs';
import { readBoundedJson } from './atomic_json.mjs';
import { ControlScheduleStatusService } from './control_schedule_status_service.mjs';

const labels = { PASS: '正常', WARN: '建议处理', FAIL: '立即阻塞', UNKNOWN: '无法确认' };
const overall = checks => ['FAIL', 'UNKNOWN', 'WARN', 'PASS'].find(status => checks.some(check => check.status === status)) || 'UNKNOWN';
async function bounded(task, milliseconds) {
  let timer;
  try { return await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DOCTOR_TIMEOUT')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// Only summaries cross this boundary. Never return owner objects or exception text.
export class DoctorService {
  constructor({ config, secrets, research, review, context, env, fsApi = fs, preflight = runPreflight }) {
    Object.assign(this, { config, secrets, research, review, context, env, fsApi, preflight });
  }
  async status() {
    const checks = [];
    const add = (checkId, status, summary, actionableHint = '', blocking = false) => checks.push({ checkId, status,
      severity: blocking ? 'blocking' : status === 'PASS' ? 'info' : 'advisory', summary, actionableHint, blocking });
    const inspect = async (id, task, blocking = false, milliseconds = 2500) => {
      try { await bounded(task, milliseconds); }
      catch { add(id, 'UNKNOWN', '无法安全完成此项检查', '检查本地文件访问条件后手动刷新；不会自动修复或重试业务操作。', blocking); }
    };
    let paths;
    await inspect('runtime.roots', async () => {
      try {
        paths = resolveRuntimePaths({ applicationRoot: this.context.applicationRoot, env: this.env });
        prepareRuntimePaths(paths, { readOnly: true });
        add('runtime.roots', 'PASS', `运行布局：${paths.layout}；程序、用户数据和缓存边界有效`, '', true);
      } catch { add('runtime.roots', 'FAIL', '运行目录边界冲突或路径不可信', '检查启动时选择的数据目录；不要移动、复制或覆盖现有数据。', true); }
    }, true);
    for (const [name, value, write] of [['application', paths?.applicationRoot, false], ['data', paths?.userDataRoot, true], ['cache', paths?.cacheRoot, true]]) {
      await inspect(`runtime.${name}`, async () => {
        if (!value) { add(`runtime.${name}`, 'UNKNOWN', '合法目录尚未确定', '先解决目录边界问题。', true); return; }
        try {
          if (!(await this.fsApi.stat(value)).isDirectory()) throw new Error();
          await this.fsApi.access(value, constants.R_OK | (write ? constants.W_OK : 0));
          add(`runtime.${name}`, 'PASS', `${{ application: '程序', data: '用户数据', cache: '缓存' }[name]}目录可访问（只读权限检查，未执行写入探针）`, '', true);
        } catch { add(`runtime.${name}`, 'FAIL', `${{ application: '程序', data: '用户数据', cache: '缓存' }[name]}目录不存在或无法访问`, '检查目录位置和当前用户权限；Doctor 不创建目录或修改权限。', true); }
      }, true);
    }
    add('runtime.node', Number(process.versions.node.split('.')[0]) >= 18 ? 'PASS' : 'FAIL', process.versions.electron ? '当前使用 Electron 内置 Node 运行时' : '当前使用 Node 运行时', '需要 Node >= 18；打包版不要求 PATH 中存在系统 Node。', true);
    add('runtime.platform', process.platform === 'darwin' ? 'UNKNOWN' : process.platform === 'win32' ? 'PASS' : 'UNKNOWN', process.platform === 'win32' ? '当前为 Windows 运行时' : '此平台尚未完成发行验收', '平台发行验收与本次本地健康检查分别记录。');
    await inspect('runtime.resources', async () => {
      if (!paths) { add('runtime.resources', 'UNKNOWN', '资源根尚未确定', '先检查目录边界。', true); return; }
      try {
        for (const file of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) await this.fsApi.access(path.join(paths.resourceRoot, file), constants.R_OK);
        add('runtime.resources', 'PASS', '当前程序根内的必要入口及静态资源可读取', '', true);
      } catch { add('runtime.resources', 'FAIL', '程序资源缺失或不可读取', '检查程序安装内容；用户数据目录不能替代程序资源。', true); }
    }, true);
    let resolved;
    await inspect('configuration', async () => {
      try {
        const file = this.config.ownerPath('paperecho.config.json');
        const saved = await readBoundedJson(this.context.userDataRoot, file);
        if (!saved) { add('configuration', 'FAIL', '尚未保存基础配置', '打开首次配置，选择运行路径并保存基础配置。', true); return; }
        await this.config.readOwner('paperecho.config.json');
        const cli = parseRunnerArgs(['--check', '--config', file], { allowUnresolvedMode: true });
        resolved = await resolveRunnerConfiguration(cli, { env: this.env, cwd: this.context.applicationRoot, readOnly: true });
        add('configuration', 'PASS', '现有配置可读取，schema 与运行路径有效', '', true);
      } catch { add('configuration', 'FAIL', '配置格式、schema 或运行路径无效', '检查设置及启动配置；不会重新初始化或覆盖旧配置。', true); }
    }, true);
    await inspect('preflight', async () => {
      if (!resolved) { add('preflight', 'UNKNOWN', '配置尚不足以执行本地预检', '先完成基础配置。', true); return; }
      const report = await this.preflight(resolved.options, { env: resolved.env });
      add('preflight', report.canRun ? 'PASS' : 'FAIL', report.canRun ? '本地必需运行条件满足；未验证外部服务连接' : '必需运行条件不满足',
        report.canRun ? '' : '在首次配置或设置中检查所选路径的输入、输出、Zotero 依赖及必需凭据。', true);
      add('preflight.optional', report.featureMissing.length + report.optionalMissing.length ? 'WARN' : 'PASS',
        report.featureMissing.length + report.optionalMissing.length ? '部分可选服务未配置，不阻止主要工作流' : '可选服务本地配置齐全', '需要相应功能时在设置中补充；不会连接服务验证密钥。');
      for (const item of report.requiredMissing) {
        // Names are owned by preflight, never supplied by configuration or a provider.
        const names = new Set(['local.input', 'local.outputRoot', 'readable Local input', 'supported Local input', 'safe Local output root', 'writable Local output root', 'readable Local feedback JSONL', 'Zotero Desktop', 'Zotero Desktop CLI bridge', 'ZOTERO_API_KEY', 'ZOTERO_USER_ID', 'production entry', 'Node.js >= 18']);
        if (names.has(item.name)) add(`preflight.missing.${item.name.replace(/[^A-Za-z0-9]/g, '_')}`, 'FAIL', `缺少或无效：${item.name}`, '在设置中检查此项。', true);
      }
    }, true);
    await inspect('secrets', async () => {
      try {
        const state = await this.secrets.health();
        if (process.platform === 'win32') add('runtime.pwsh', state.aclRuntime ? 'PASS' : 'UNKNOWN', state.aclRuntime ? 'PowerShell 7 凭据安全检查运行时可用' : state.aclRuntime === null ? '尚无本地凭据文件，未执行 PowerShell 7 ACL 检查' : '无法执行 PowerShell 7 凭据安全检查', '存在本地凭据文件时才检查 ACL；不会安装依赖或降低 ACL 要求。');
        add('secrets', 'PASS', state.filePresent ? '本地凭据路径、格式和权限检查通过' : '本地凭据文件不存在；不会自动创建', '', true);
        for (const credential of state.credentials) add(`secret.${credential.id}`, credential.storageClass === 'unknown' ? 'UNKNOWN' : credential.configured ? 'PASS' : 'WARN',
          `${credential.id}：${credential.configured ? '已配置' : '未配置'}；${{ 'external-managed': '外部托管，只读', 'local-managed': '本地托管', unconfigured: '尚未配置', unknown: '来源无法确认' }[credential.storageClass] || '来源无法确认'}`,
          credential.storageClass === 'external-managed' ? '在原注入入口维护；此处不能覆盖。' : '需要时通过设置中的凭据入口维护。');
      } catch (error) { add('secrets', error.code === 'CREDENTIAL_ACL_RUNTIME_UNAVAILABLE' ? 'UNKNOWN' : 'FAIL', error.code === 'CREDENTIAL_ACL_RUNTIME_UNAVAILABLE' ? '缺少可执行的 PowerShell 7，无法确认凭据 ACL' : '凭据文件无法安全读取，或权限/ACL 检查未通过', '检查可信凭据文件及权限；Windows ACL 检查需要 PowerShell 7。不会修改 ACL。', true); }
    }, true, 20000);
    let context = this.context;
    await inspect('workflow', async () => {
      if (!resolved) { add('workflow', 'UNKNOWN', '配置未确定，无法定位正式工作流状态', '先解决配置问题。'); return; }
      context = await resolveApplicationRuntimeContext({ cwd: this.context.applicationRoot, env: this.env, argv: ['--config', this.config.ownerPath('paperecho.config.json')], readOnly: true });
      const { ReviewQueryService } = await import('./control_review_query_service.mjs');
      const state = await (context.runRoot === this.context.runRoot ? this.review : new ReviewQueryService({ root: context.userDataRoot, context })).health();
      add('workflow.claim', state.claim === 'unknown' ? 'UNKNOWN' : state.claim === 'stale' ? 'FAIL' : 'PASS',
        { unknown: '工作流 claim 状态无法确认', stale: '已确认 claim 所属进程不存活且租约过期', running: '工作流进程仍在运行，保持现有 claim', absent: '未发现工作流 claim' }[state.claim], '不会释放 claim；异常时先检查原运行记录。', state.claim !== 'absent');
      add('workflow.manifest', state.lastRun === 'unknown' || state.lastRun === 'running' && state.claim !== 'running' ? 'UNKNOWN' : ['failed', 'incomplete', 'interrupted', 'timed_out'].includes(state.lastRun) ? 'WARN' : 'PASS',
        state.lastRun === 'none' ? '尚无登记运行' : state.lastRun === 'running' ? '最近登记任务正在运行' : state.lastRun === 'completed' ? '最近登记任务已完成' : '最近登记任务需要检查', '仅按登记时间选取有界范围内的运行，不使用文件修改时间。');
      add('workflow.ledger', state.ledger === 'readable' || state.lastRun === 'none' ? 'PASS' : 'UNKNOWN', state.ledger === 'readable' ? 'operation ledger 可读取并通过 schema 检查' : '尚无可读取的 operation ledger', '旧版运行可能没有 ledger；不创建恢复记录。');
      add('workflow.recovery', state.conflicts ? 'UNKNOWN' : state.recoveryPending ? 'WARN' : state.ledger === 'absent' && state.lastRun !== 'none' ? 'UNKNOWN' : 'PASS',
        state.businessComplete ? '业务阶段已成功；通知恢复单独处理' : state.recoveryPending ? '工作流可检查恢复，尚未恢复' : '未发现需要恢复的已确认状态', '在原运行记录中人工核对；Doctor 不重放操作。');
      add('workflow.receipts', state.receipts.some(x => ['unknown', 'missing'].includes(x)) ? 'UNKNOWN' : state.receipts.some(x => ['failed', 'pending'].includes(x)) ? 'WARN' : 'PASS',
        state.receipts.some(x => x !== 'accepted') ? '通知回执待检查；不代表已成功业务失败' : '通知回执正常或尚无通知操作', '通知与业务结果分别处理；不自动重发。');
      add('workflow.runner', state.runner === 'unknown' ? 'UNKNOWN' : ['timed_out', 'interrupted', 'failed'].includes(state.runner) ? 'WARN' : 'PASS', '已检查当前运行的 Runner 登记信息；未扫描日志', '需要时检查原运行报告。');
    }, true);
    await inspect('workflow.scheduleClaim', async () => {
      if (!resolved) { add('workflow.scheduleClaim', 'UNKNOWN', '尚不能定位 Stage0 claim', '先检查基础配置。'); return; }
      const fsApi = { readFile: async file => { const value = await readBoundedJson(context.userDataRoot, file); if (value === null) throw Object.assign(new Error(), { code: 'ENOENT' }); return JSON.stringify(value); } };
      const state = await new ControlScheduleStatusService({ context, config: this.config, fsApi }).status();
      add('workflow.scheduleClaim', state.status === 'invalid' || state.currentRun?.state === 'unconfirmed' ? 'UNKNOWN' : state.status === 'recovery_required' ? 'WARN' : 'PASS',
        state.currentRun?.state === 'running' ? 'Stage0 已登记任务仍在运行' : state.status === 'unsupported' ? 'Local 路径不使用 Stage0 调度 claim' : state.status === 'invalid' ? 'Stage0 claim 或登记状态无法确认' : '已检查当前计划槽的 Stage0 claim', '不注册调度、不释放 claim、不恢复工作流。');
    });
    await inspect('research', async () => {
      if (!resolved) { add('research', 'UNKNOWN', '配置尚未确定，无法定位正式研究反馈状态', '先检查基础配置。'); return; }
      // The lifecycle owner reads a bounded set of events, returning counts only.
      const { ResearchEvaluationService } = await import('./research_evaluation_service.mjs');
      const state = await (context.reviewRoot === this.context.reviewRoot ? this.research : new ResearchEvaluationService({ root: context.userDataRoot, reviewRoot: context.reviewRoot })).health();
      for (const [key, summary] of Object.entries({ pending: '等待下一次正式 workflow', prepared: '已准备，等待业务成功后发布', unknown: '模型调用结果未知，已安全保留', recoverable: '可恢复，尚未恢复', processed: '已正常处理' })) {
        add(`research.${key}`, state[key] && key === 'unknown' ? 'UNKNOWN' : state[key] && key === 'recoverable' ? 'WARN' : 'PASS', `${summary}：${state[key]} 项`,
          key === 'unknown' ? '人工核对原运行记录与模型调用结果；不要自动重发请求。' : 'Doctor 不消费反馈或生成建议。');
      }
    });
    const status = overall(checks);
    return { schemaVersion: 1, status, summary: labels[status], canRun: checks.some(x => x.blocking && x.status === 'FAIL') ? false : checks.some(x => x.blocking && x.status === 'UNKNOWN') ? null : true, checks };
  }
}
