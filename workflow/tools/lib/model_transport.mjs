import policy from './ai_capabilities.cjs';
export const { capabilities } = policy;
export function serviceAddress(provider, endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('AI_ADDRESS_INVALID');
  const base = url.href.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
  return { identity: `${provider}|${base}`, endpoint: provider === 'anthropic' ? `${base.endsWith('/v1') ? base : base + '/v1'}/messages` : `${base}/chat/completions` };
}
export function buildModelRequest(runtime, prompt, { maxTokens = 4096, stream = true } = {}) {
  const provider = runtime.provider || 'compatible';
  if (!['compatible', 'openai', 'anthropic'].includes(provider) || !String(runtime.model || '').trim()) throw new Error('AI_CONFIG_INCOMPLETE');
  const address = serviceAddress(provider, runtime.endpoint);
  const caps = capabilities(provider, runtime.model, runtime.api_version);
  const thinking = runtime.thinking === true || runtime.thinking?.type === 'enabled';
  if (thinking && !caps.thinking) throw new Error('AI_THINKING_UNSUPPORTED');
  if (!thinking && !caps.canDisable) throw new Error('AI_THINKING_CANNOT_DISABLE');
  const body = { model: runtime.model, messages: [{ role: 'user', content: prompt }], stream };
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'anthropic') {
    headers['x-api-key'] = runtime.apiKey;
    headers['anthropic-version'] = runtime.api_version || '2023-06-01';
    if (!['2023-06-01', '2026-10-21'].includes(headers['anthropic-version'])) throw new Error('AI_CONFIG_INCOMPLETE');
    body.max_tokens = Math.max(thinking ? 2048 : 1, Math.min(20000, maxTokens));
    if (thinking) body.thinking = caps.reasoning === 'adaptive' ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: 1024 };
    else if (caps.thinking) body.thinking = { type: 'disabled' };
  } else {
    headers.Authorization = `Bearer ${runtime.apiKey}`;
    body[caps.reasoning ? 'max_completion_tokens' : 'max_tokens'] = Math.min(20000, Math.max(1, maxTokens));
    if (caps.reasoning) body.reasoning_effort = thinking ? 'low' : 'none';
  }
  if (provider === 'openai' && caps.confirmed && ['json_schema', 'json_object'].includes(runtime.response_format)) body.response_format = { type: 'json_object' };
  if (!thinking && caps.sampling) {
    // Send one sampling control: changing temperature and top_p together is unnecessary.
    if (Number.isFinite(runtime.temperature)) body.temperature = runtime.temperature;
    else if (Number.isFinite(runtime.top_p)) body.top_p = runtime.top_p;
  }
  return { ...address, headers, body };
}
async function readModelResponse(response, provider, stream, limit) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('AI_RESPONSE_INVALID');
  const decoder = new TextDecoder(); let buffer = '', output = '', bytes = 0, complete = false, stopped = false;
  const consume = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { complete = true; return; }
    let event; try { event = JSON.parse(data); } catch { throw new Error('AI_RESPONSE_INVALID'); }
    if (event.type === 'error' || event.error) throw new Error('AI_PROVIDER_ERROR');
    if (provider === 'anthropic') { if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') output += event.delta.text || ''; if (event.type === 'message_delta' && event.delta?.stop_reason) { if (!['end_turn', 'stop_sequence'].includes(event.delta.stop_reason)) throw new Error('AI_RESPONSE_INCOMPLETE'); stopped = true; } if (event.type === 'message_stop') complete = true; }
    else { output += event.choices?.[0]?.delta?.content || ''; if (event.choices?.[0]?.finish_reason) { if (event.choices[0].finish_reason !== 'stop') throw new Error('AI_RESPONSE_INCOMPLETE'); stopped = true; } }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength; if (bytes > limit) throw new Error('AI_RESPONSE_TOO_LARGE');
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      if (stream) { let end; while ((end = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); } }
    }
    buffer += decoder.decode();
    if (stream) { if (buffer.trim()) consume(buffer); if (!complete || !stopped) throw new Error('AI_RESPONSE_INCOMPLETE'); return output; }
    let value; try { value = JSON.parse(buffer); } catch { throw new Error('AI_RESPONSE_INVALID'); }
    if (provider === 'anthropic' ? !['end_turn', 'stop_sequence'].includes(value.stop_reason) : value.choices?.[0]?.finish_reason !== 'stop') throw new Error('AI_RESPONSE_INCOMPLETE');
    return provider === 'anthropic' ? (value.content || []).filter(block => block.type === 'text').map(block => block.text).join('') : value.choices?.[0]?.message?.content || '';
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function requestModelText(runtime, prompt, { fetchImpl = globalThis.fetch, maxTokens = 4096, timeoutMs = runtime.timeout_ms || 30000, limit = 16 * 1024 * 1024, stream = true } = {}) {
  if (!runtime.apiKey) throw new Error('AI_KEY_MISSING');
  const request = buildModelRequest(runtime, prompt, { maxTokens, stream });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(120000, Math.max(1000, timeoutMs)));
  try {
    const response = await fetchImpl(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      let code = ''; const reader = response.body?.getReader();
      if (reader) { let text = '', size = 0; const decoder = new TextDecoder(); try { while (true) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) break; text += decoder.decode(value, {stream:true}); } const data = JSON.parse(text); if (['model_not_found', 'model_not_supported'].includes(data.error?.code)) code = data.error.code; } catch {} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
      throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status, apiCode: code });
    }
    return await readModelResponse(response, runtime.provider, stream, limit);
  } finally { clearTimeout(timer); }
}
// User-triggered, one request, no retries; no provider body or key crosses the API boundary.
export async function testModelConnection(input, { secrets, fetchImpl } = {}) {
  if (!input || Object.keys(input).some(key => !['provider', 'endpoint', 'model', 'thinking', 'temperature', 'top_p', 'api_version', 'apiKey'].includes(key))) return { status: 'configuration' };
  let address; try { address = serviceAddress(input.provider, input.endpoint); } catch { return { status: 'address' }; }
  const run = async apiKey => {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) return { status: 'configuration' };
    try {
      const text = await requestModelText({ ...input, apiKey, thinking: input.thinking === true }, 'Reply OK.', { fetchImpl, maxTokens: 64, timeoutMs: 8000, limit: 65536 });
      return { status: text.trim() ? 'callable' : 'reachable', networkReachable: true, modelCallable: Boolean(text.trim()) };
    } catch (error) {
      return { status: error.apiCode ? 'model' : [401, 403].includes(error.status) ? 'authentication' : error.status === 404 ? 'model_or_address' : [429, 402].includes(error.status) ? 'limited' : error.status === 400 ? 'configuration' : /^AI_ADDRESS/.test(error.message) ? 'address' : /^AI_(RESPONSE|PROVIDER)/.test(error.message) ? 'protocol' : /^AI_(CONFIG|THINKING)/.test(error.message) ? 'configuration' : 'network', networkReachable: Boolean(error.status), modelCallable: false };
    }
  };
  return input.apiKey ? run(input.apiKey) : secrets.withModelCredential(address.identity, run);
}
