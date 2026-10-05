import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 8787);
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '1mb' }));

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasTextFields = (value, fields) => value && fields.every((field) => hasText(value[field]));
const parseJsonObject = (text) => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error('No complete JSON object found in provider response.');
};
const normalizeCode = (value) => String(value || '').replace(/```[\w-]*|```/g, '').replace(/\s+/g, ' ').trim();
const matchSourceLine = (snippet, sourceLines) => {
  const normalizedSnippet = normalizeCode(snippet);
  if (!normalizedSnippet) return -1;
  return sourceLines.findIndex((line) => {
    const normalizedLine = normalizeCode(line);
    if (!normalizedLine) return false;
    const withoutTrailingPunctuation = normalizedLine.replace(/[{};]+$/g, '').trim();
    const withoutSyntaxPunctuation = normalizedLine.replace(/[{};]/g, '').replace(/\s+/g, ' ').trim();
    return [normalizedLine, withoutTrailingPunctuation, withoutSyntaxPunctuation]
      .some((candidate) => candidate.length > 0 && normalizedSnippet.includes(candidate));
  });
};
const alignCodeExplanationLines = (value, code) => {
  const sourceLines = code.split(/\r?\n/);
  for (const part of value?.codeExplanation || []) {
    const sourceIndex = matchSourceLine(part.code, sourceLines);
    if (sourceIndex >= 0) part.line = sourceIndex + 1;
  }
};
const missingExplanationSections = (value, code) => {
  const sourceLines = code.split(/\r?\n/);
  const checks = {
    title: hasText(value?.title),
    verdict: hasText(value?.verdict),
    problemUnderstanding: hasTextFields(value?.problemUnderstanding, ['summary', 'input', 'output', 'constraints']),
    intuition: hasTextFields(value?.intuition, ['idea', 'analogy', 'why']),
    algorithm: Array.isArray(value?.algorithm?.steps) && value.algorithm.steps.length > 0 && Array.isArray(value?.algorithm?.dataStructures),
    visualStory: Array.isArray(value?.visualStory) && value.visualStory.length === 4 && value.visualStory.every((scene) =>
      hasTextFields(scene, ['title', 'narration', 'state']) && Number.isInteger(scene.codeLine) && Array.isArray(scene.values)),
    executionTrace: Array.isArray(value?.executionTrace) && value.executionTrace.length >= 1 && value.executionTrace.length <= 5 && value.executionTrace.every((step) =>
      hasTextFields(step, ['step', 'detail']) && Array.isArray(step.variables)),
    codeExplanation: Array.isArray(value?.codeExplanation) && value.codeExplanation.length > 0 && value.codeExplanation.every((part) =>
      Number.isInteger(part.line) && hasText(part.code) && hasText(part.explanation) && matchSourceLine(part.code, sourceLines) === part.line - 1),
    edgeCases: Array.isArray(value?.edgeCases),
    complexity: hasTextFields(value?.complexity, ['time', 'timeWhy', 'space', 'spaceWhy']),
    mistakes: Array.isArray(value?.mistakes),
    interview: hasText(value?.interview?.pitch) && Array.isArray(value?.interview?.questions),
    summary: hasTextFields(value?.summary, ['idea', 'remember'])
  };
  return Object.entries(checks).filter(([, complete]) => !complete).map(([section]) => section);
};

app.post('/api/explain', async (req, res) => {
  const { question, code, language, instructions, mode } = req.body || {};
  if (!question?.trim() || !code?.trim()) return res.status(400).json({ error: 'Add both a problem and its code before generating an explanation.' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'AI is not configured yet. Add OPENROUTER_API_KEY to your environment, then restart the server.' });
  const controller = new AbortController();
  // Bound the complete retry chain so a free provider that never finishes cannot
  // keep the workspace waiting for minutes.
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const primaryModel = process.env.OPENROUTER_MODEL || 'inclusionai/ling-3.0-flash-sante:free';
    const fallbackModels = (process.env.OPENROUTER_FALLBACK_MODELS || [
      'openrouter/free',
      'nvidia/nemotron-3.5-lightning:free',
      'cohere/north-mini-code:free',
      'poolside/laguna-s-2.1:free',
      'google/gemma-4-31b:free',
      'apodex/apodex-1.1-mini:free',
      'inclusionai/ling-3.0-flash-sante:free'
    ].join(',')).split(',').map(x => x.trim()).filter(Boolean);
    // Try a small, diverse set of free routes; long chains made transient provider
    // issues look like a frozen app.
    const models = [...new Set([primaryModel, ...fallbackModels])].slice(0, 3);
    const maxTokens = Math.max(3000, 2300 + code.split('\n').length * 65 + Math.ceil(question.length / 10) + Math.ceil(code.length / 24));
    const messages = [
        { role: 'system', content: `You are CodeStory, a clear, precise programming teacher. Explain the problem and code in that order. Be beginner-friendly, technically accurate and compact; no filler. Never claim to execute code. Explain code/question mismatches and bugs. Return ONLY valid JSON matching this shape: {"title":"short name","verdict":"Correct | Issue found | Mismatch","problemUnderstanding":{"summary":"plain language","input":"...","output":"...","constraints":"..."},"intuition":{"idea":"...","analogy":"...","why":"..."},"algorithm":{"steps":["..."],"dataStructures":["..."]},"visualStory":[{"title":"...","narration":"...","state":"...","codeLine":1,"values":[{"label":"...","value":"...","kind":"active|found|muted"}]}],"executionTrace":[{"step":"...","detail":"...","variables":[{"name":"...","value":"..."}],"codeLine":1}],"codeExplanation":[{"line":1,"code":"...","explanation":"..."}],"edgeCases":[{"name":"...","input":"...","outcome":"...","why":"..."}],"complexity":{"time":"...","timeWhy":"...","space":"...","spaceWhy":"..."},"mistakes":[{"title":"...","problem":"...","fix":"..."}],"interview":{"pitch":"...","questions":["..."]},"summary":{"idea":"...","remember":"..."}}. Exactly 4 story scenes; 4-5 trace steps. The trace must be ONE uninterrupted dry run on a small concrete input: follow actual branches and variable updates, stop at return/throw/termination, and include the output. Never invent steps after the function has returned. If input is invented, label it illustrative. Explain all meaningful code sections, grouping routine lines. At most 3 relevant edge cases, 2 common mistakes, and 2 interview questions. Keep string fields to one or two short sentences. Use 1-based physical source line numbers including blank lines; every codeExplanation.line must equal the first actual source line quoted in its code field. Quote exact source lines, and group only contiguous lines.` },
        { role: 'user', content: `Mode: ${mode || 'Simple'}. Language: ${language || 'Unknown'}. Problem: ${question}\n\nCode:\n${code}\n\nAdditional instructions: ${instructions || 'None'}` }
    ];
    let response, payload, model, explanation, partialExplanation;
    for (const candidate of models) {
      const missingSections = partialExplanation ? missingExplanationSections(partialExplanation, code) : [];
      const modelMessages = partialExplanation ? [
        { role: 'system', content: `Complete a partially generated CodeStory explanation. Return only valid JSON with exactly these top-level keys: ${missingSections.join(', ')}. Fill each key completely and accurately. Use the supplied draft and source code as context. Do not repeat existing sections or use markdown.` },
        { role: 'user', content: `${messages[1].content}\n\nExisting draft JSON:\n${JSON.stringify(partialExplanation)}` }
      ] : messages;
      const requestBody = { model: candidate, provider: { sort: 'throughput' }, temperature: 0.1, max_tokens: partialExplanation ? 1400 : maxTokens, messages: modelMessages };
      if (candidate === 'openrouter/free' || candidate.startsWith('qwen/') || candidate.startsWith('google/gemma-4')) {
        requestBody.response_format = { type: 'json_object' };
      }
      if (candidate.startsWith('qwen/')) {
        requestBody.reasoning = { effort: 'low' };
      } else if (candidate.startsWith('cohere/north-mini-code')) {
        requestBody.reasoning = { enabled: false };
      } else if (candidate.startsWith('inclusionai/')) {
        requestBody.reasoning = { enabled: false };
      }
      const attemptController = new AbortController();
      const attemptTimer = setTimeout(() => attemptController.abort(), 18000);
      try {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.any([controller.signal, attemptController.signal]),
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'CodeStory AI' },
          body: JSON.stringify(requestBody)
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (candidate === models.at(-1)) break;
        continue;
      } finally {
        clearTimeout(attemptTimer);
      }
      payload = await response.json().catch(() => ({}));
      console.log(`[CodeStory] ${candidate}: HTTP ${response.status}, finish=${payload.choices?.[0]?.finish_reason || 'none'}, chars=${payload.choices?.[0]?.message?.content?.length || 0}${payload.error?.message ? `, providerError=${payload.error.message.slice(0, 180)}` : ''}`);
      if (!response.ok) {
        if (response.status === 429 && /free-models-per-day/i.test(payload.error?.message || '')) break;
        if (candidate !== models.at(-1)) continue;
        break;
      }
      const message = payload.choices?.[0]?.message;
      const content = message?.content;
      const raw = (typeof content === 'string' ? content : Array.isArray(content)
        ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('\n')
        : '').trim();
      if (raw) {
        try {
          const parsed = parseJsonObject(raw);
          const combined = partialExplanation ? { ...partialExplanation, ...parsed } : parsed;
          // Visual scenes already contain ordered state changes and their source
          // lines; use them as the trace if a provider omits the duplicate field.
          if ((!Array.isArray(combined.executionTrace) || combined.executionTrace.length === 0) && Array.isArray(combined.visualStory)) {
            combined.executionTrace = combined.visualStory.map((scene) => ({
              step: scene.title,
              detail: scene.narration,
              variables: (scene.values || []).map((item) => ({ name: item.label, value: item.value })),
              codeLine: scene.codeLine
            }));
          }
          alignCodeExplanationLines(combined, code);
          const missing = missingExplanationSections(combined, code);
          if (!missing.length) {
            explanation = combined;
            model = candidate;
            break;
          }
          console.log(`[CodeStory] ${candidate}: incomplete sections=${missing.join(',')}`);
          if (Object.keys(parsed).length > 0) {
            partialExplanation = combined;
            // A focused repair from the same model is more consistent than
            // waiting through unrelated fallback providers.
            if (candidate === primaryModel && models.length > 1) models.splice(1, models.length - 1, primaryModel);
          }
        } catch (parseError) {
          console.log(`[CodeStory] ${candidate}: unusable JSON response (${parseError.message})`);
        }
      }
      if (candidate !== models.at(-1)) continue;
    }
    if (response && !response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: payload.error?.message || `The AI provider returned ${response.status}.` });
    if (!explanation) return res.status(502).json({ error: 'The AI providers could not complete this explanation. Your problem and code are still here; please try again.' });
    const exitStep = explanation.executionTrace.findIndex(step => /\b(return(?:s|ed)?|throw(?:s|n)?|terminat(?:e|es|ed|ion)|function ends)\b/i.test(`${step.step || ''} ${step.detail || ''}`));
    if (exitStep >= 0 && exitStep < explanation.executionTrace.length - 1) {
      explanation.executionTrace = explanation.executionTrace.slice(0, exitStep + 1);
      explanation.visualStory = explanation.visualStory.slice(0, exitStep + 1);
    }
    res.json({ explanation, model });
  } catch (error) {
    res.status(error.name === 'AbortError' ? 504 : 502).json({ error: error.name === 'AbortError' ? 'The AI providers took too long to finish. Your problem and code are still here; try again in a moment.' : 'Could not reach the AI provider. Check your connection and try again.' });
  } finally { clearTimeout(timer); }
});
app.get('/api/health', (_req, res) => res.json({ ready: Boolean(process.env.OPENROUTER_API_KEY) }));
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(here, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(here, 'dist', 'index.html')));
}
app.listen(port, () => console.log(`CodeStory API ready on http://localhost:${port}`));
