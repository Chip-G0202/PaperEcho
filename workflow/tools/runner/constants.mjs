export const RUNNER_SCHEMA_VERSION = 1;
export const SUPPORTED_RUNNER_CONFIG_SCHEMAS = new Set([1, 2]);

export const EXIT_CODES = Object.freeze({
  success: 0,
  configuration: 2,
  input: 3,
  dependency: 4,
  pipeline: 5,
  validation: 6,
  canceled: 7,
});

export const MODES = new Set(["desktop", "web", "local"]);
export const PROFILES = new Set(["standard", "complete", "radar"]);
