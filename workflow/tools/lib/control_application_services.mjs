import path from 'node:path';
import { FeedbackService } from './control_feedback_service.mjs';
import { ConfigService } from './control_config_service.mjs';
import { RuleSuggestionService } from './control_rule_suggestion_service.mjs';
import { SecretService } from './control_credentials_service.mjs';
import { copyEnvironment } from './credential_registry.mjs';
import { ResearchEvaluationService } from './research_evaluation_service.mjs';
import { ReviewQueryService } from './control_review_query_service.mjs';
import { buildRuntimeConfig } from './runtime_config.mjs';
import { ControlScheduleStatusService } from './control_schedule_status_service.mjs';
import { NotificationChannelService } from './control_notification_service.mjs';
import { SetupService } from './control_setup_service.mjs';
import { DoctorService } from './control_doctor_service.mjs';

export function createControlServices({ root, reviewRoot, env = process.env, llmClient = null, notificationTransport, qqTransport, channelTransports, context = buildRuntimeConfig({ cwd: root, env, argv: [] }) } = {}) {
  reviewRoot ||= context.reviewRoot;
  if (context.layout && context.layout !== 'dev') root = context.userDataRoot;
  env = copyEnvironment(context.env || env, { PAPERECHO_APPLICATION_CONFIG: context.configPath || path.join(root, 'config', 'paperecho.config.json') });
  const secrets = new SecretService({ root, env });
  const research = new ResearchEvaluationService({ root, reviewRoot, env, llmClient, redact: text => secrets.redact(text) });
  const rules = new RuleSuggestionService({ reviewRoot, root, env, configPath: context.configPath });
  const config = new ConfigService({ root, env, configPath: context.configPath, runtimeMode: context.mode });
  const feedback = new FeedbackService({
    reviewRoot,
    ruleDecision: (input) => rules.decideWithReceipt(input),
    researchEvaluation: input => research.submit(input),
  });
  const review = new ReviewQueryService({ root, reviewRoot, feedback, rules, context });
  const schedule = new ControlScheduleStatusService({ context: { ...context, reviewRoot }, config });
  const notifications = new NotificationChannelService({ config, secrets, review, context, env, transport: notificationTransport, qqTransport, channelTransports });
  const setup = new SetupService({ config, context, env });
  const doctor = new DoctorService({ config, secrets, research, review, context, env });
  return { feedback, config, rules, secrets, review, schedule, notifications, research, setup, doctor };
}
