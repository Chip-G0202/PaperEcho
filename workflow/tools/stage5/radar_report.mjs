import { escapeHtml, renderEmailLayout } from "./email_layout.mjs";

export function literatureCards(items = []) {
  return items.map((item) => {
    const metadata = [item.journal, item.year, item.source].filter(Boolean).join(" · ");
    return `<tr><td style="padding:12px 28px;"><div style="border-top:1px solid #dfe4ea;padding-top:18px;"><div style="font-size:12px;font-weight:700;color:#365a7c;margin-bottom:8px;">${escapeHtml(item.grade)} 级文献</div><h2 style="font-size:18px;line-height:1.5;margin:0 0 7px;">${escapeHtml(item.title)}</h2>${item.translatedTitle ? `<div style="font-size:14px;line-height:1.7;color:#52606d;margin-bottom:8px;">${escapeHtml(item.translatedTitle)}</div>` : ""}${metadata ? `<div style="font-size:12px;color:#697386;line-height:1.6;">${escapeHtml(metadata)}</div>` : ""}${item.reason ? `<div style="font-size:14px;line-height:1.75;margin-top:12px;"><strong>推荐理由</strong><br>${escapeHtml(item.reason)}</div>` : ""}${item.identifier ? `<div style="font-size:12px;color:#697386;margin-top:10px;">${escapeHtml(item.identifier)}</div>` : ""}${item.url ? `<div style="margin-top:10px;"><a href="${escapeHtml(item.url)}" style="color:#365a7c;font-size:13px;">查看原文</a></div>` : ""}</div></td></tr>`;
  }).join("");
}
export function literatureText(items = []) {
  return items.flatMap(item => ["", `[${item.grade}] ${item.title}`, ...[item.translatedTitle, [item.journal, item.year, item.source].filter(Boolean).join(" · "), item.reason ? `推荐理由：${item.reason}` : "", item.identifier, item.url].filter(Boolean)]);
}
export function formatRadarReport(content) {
  const summary = content.summary.map(({ label, value }) => `${label}：${value} 篇`).join(" · ");
  const cards = literatureCards(content.items);
  const body = `<tr><td style="padding:18px 28px 10px;font-size:14px;line-height:1.8;"><strong>今日摘要</strong><br>${escapeHtml(summary)}</td></tr>${cards || '<tr><td style="padding:18px 28px;">本轮暂无推荐文献。</td></tr>'}`;
  const html = renderEmailLayout({ brand: "PaperEcho · Daily Radar", title: content.title, subtitle: content.date, body, footer: `${content.runId ? `Run ID: ${escapeHtml(content.runId)}<br>` : ""}由 PaperEcho 自动生成`, responsive: true });
  const lines = ["PaperEcho · Daily Radar", content.title, content.date, "", "今日摘要", summary];
  lines.push(...literatureText(content.items));
  if (!content.items.length) lines.push("", "本轮暂无推荐文献。");
  lines.push("", ...(content.runId ? [`Run ID：${content.runId}`] : []), "由 PaperEcho 自动生成");
  return { subject: content.subject, html, text: lines.join("\n"), attachments: [] };
}
