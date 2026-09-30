import { isIP } from 'node:net';

export function isValidSmtpHost(value) {
  return typeof value === 'string' && value.length <= 253 && (Boolean(isIP(value)) || value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
}

export function emailTransportConfig(env = process.env) {
  const required = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) return { configured: false, missing, error: `SMTP is not configured. Missing: ${missing.join(", ")}` };
  if (!isValidSmtpHost(env.SMTP_HOST)) return { configured: false, missing: [], error: 'SMTP_HOST must be a valid host name or IP address' };
  const portValue = String(env.SMTP_PORT ?? "").trim();
  const port = portValue ? Number(portValue) : 465;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { configured: false, missing: [], error: "SMTP_PORT must be an integer between 1 and 65535" };
  const secureValue = String(env.SMTP_SECURE ?? "").trim().toLowerCase();
  const secureValues = new Map([["1", true], ["true", true], ["yes", true], ["on", true], ["0", false], ["false", false], ["no", false], ["off", false]]);
  if (secureValue && !secureValues.has(secureValue)) return { configured: false, missing: [], error: "SMTP_SECURE must be one of: true, false, 1, 0, yes, no, on, off" };
  const from = String(env.SMTP_FROM || env.SMTP_USER).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) || from.length > 254) return { configured: false, missing: [], error: "SMTP_FROM (or fallback SMTP_USER) must be a valid email address" };
  return { configured: true, missing: [], error: "", port, secure: secureValue ? secureValues.get(secureValue) : port === 465, from };
}

export async function sendStage5Email(message, { env = process.env, nodemailerLoader = () => import("nodemailer") } = {}) {
  const config = emailTransportConfig(env);
  if (!config.configured) throw Object.assign(new Error(config.error), { category: config.missing.length ? "transport_not_configured" : "smtp_config_invalid" });
  const nodemailer = await nodemailerLoader();
  const transporter = nodemailer.createTransport({ host: env.SMTP_HOST, port: config.port, secure: config.secure, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  const result = await transporter.sendMail({ from: config.from, to: message.to, messageId: message.messageId || undefined, subject: message.subject, html: message.html, text: message.text, attachments: (message.attachments || []).map((item) => ({ filename: item.filename, path: item.path })) });
  const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  const responseCode = Number(String(result?.response || "").match(/\b([245]\d\d)\b/)?.[1] || 0) || null;
  return {
    messageId: String(result?.messageId || message.messageId || ""),
    accepted: accepted.length > 0 || (accepted.length === 0 && rejected.length === 0 && Number(responseCode || 0) >= 200 && Number(responseCode || 0) < 300),
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    responseCode,
  };
}
