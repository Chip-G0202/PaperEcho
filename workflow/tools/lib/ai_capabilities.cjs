/* Shared renderer/request policy. Unknown models never receive guessed optional fields.
 * Anthropic: /docs/en/build-with-claude/thinking and /docs/en/api/migration-2026-10-21.
 * OpenAI: /api/docs/guides/reasoning?api-mode=chat. */
(function (root) {
  const capabilities = (provider, model, apiVersion = '2023-06-01') => {
    const id = String(model || '').toLowerCase();
    if (provider === 'anthropic') {
      const manual = /^(claude-3-7-sonnet-20250219|claude-(sonnet|opus)-4-20250514|claude-opus-4-1-20250805|claude-(sonnet|haiku|opus)-4-5(?:-\d{8})?)$/.test(id);
      const adaptive = /^claude-(opus-4-[678]|sonnet-4-6)(?:-\d{8})?$/.test(id);
      const always = /^claude-(opus-5-5|fable-5(?:-1)?|mythos-5(?:-1)?)(?:-\d{8})?$/.test(id);
      const basic = /^claude-3-(?:5|haiku|sonnet|opus)(?:-|$)/.test(id);
      return { thinking: manual || adaptive || always, canDisable: !always, confirmed: manual || adaptive || always || basic,
        sampling: apiVersion === '2023-06-01' && (manual || basic || /^claude-(opus|sonnet)-4-6(?:-\d{8})?$/.test(id)), protocol: 'anthropic', reasoning: manual ? 'budget' : adaptive || always ? 'adaptive' : null };
    }
    // A compatible URL alone does not establish support for OpenAI's reasoning extensions.
    const official = provider === 'openai';
    const fixed = official && /^(o1|o3|o4-mini|o3-mini|gpt-5(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
    const optional = official && /^gpt-5\.(?:1|2|4|5)(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
    const standard = official && /^gpt-(4o|4\.1)(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
    return { thinking: fixed || optional, canDisable: !fixed, confirmed: fixed || optional || standard,
      sampling: standard, protocol: 'openai', reasoning: fixed || optional ? 'effort' : null };
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { capabilities };
  else root.PaperEchoAI = Object.freeze({ capabilities });
})(typeof window === 'undefined' ? {} : window);
