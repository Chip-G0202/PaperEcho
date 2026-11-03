export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// body/footer are markup assembled by renderers; all external text is escaped there.
export function renderEmailLayout({ title, subtitle, body, footer, brand = "PaperEcho", responsive = false }) {
  return `<!doctype html><html>${responsive ? '<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' : ''}<body style="margin:0;background:#f5f7fa;color:#172033;font-family:Arial,'Microsoft YaHei',sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #dfe4ea;${responsive ? 'table-layout:fixed;overflow-wrap:anywhere;word-break:break-word;' : ''}"><tr><td style="padding:26px 28px 12px;"><div style="font-size:12px;color:#52606d;">${escapeHtml(brand)}</div><h1 style="font-size:23px;margin:7px 0;">${escapeHtml(title)}</h1><div style="font-size:14px;">${escapeHtml(subtitle)}</div></td></tr>${body}<tr><td style="padding:18px 28px;font-size:12px;color:#697386;">${footer}</td></tr></table></td></tr></table></body></html>`;
}
