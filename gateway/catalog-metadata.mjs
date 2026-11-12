// Shared, secret-free catalog metadata. Models keep their exact upstream IDs.
export const BUILTIN_CATEGORIES = Object.freeze([
  { id: 'gpt', name: 'GPT' }, { id: 'claude', name: 'Claude' },
  { id: 'deepseek', name: 'DeepSeek' }, { id: 'kimi', name: 'Kimi' },
  { id: 'gemini', name: 'Gemini' }, { id: 'qwen', name: 'Qwen' },
  { id: 'glm', name: 'GLM' }, { id: 'other', name: '其他' },
]);
export const PROTOCOLS = Object.freeze(['passthrough', 'chat', 'responses', 'messages', 'gemini']);
export const PROTOCOL_OPTIONS = Object.freeze([
  { value: 'passthrough', label: '原样转发 / Pass through' },
  { value: 'chat', label: 'OpenAI Chat Completions' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'messages', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Gemini GenerateContent' },
]);
const builtins = new Set(BUILTIN_CATEGORIES.map(c => c.id));
export function metadataId(kind, providerId = '', model = '') {
  return JSON.stringify([kind, providerId, model]);
}
export function inferModelCategories(model) {
  // Only examine complete path segments and known family boundaries, not arbitrary substrings.
  const parts = String(model).toLowerCase().split('/');
  const rules = [
    ['gpt', /^(?:gpt|chatgpt|codex|o1|o3|o4)(?:$|[-_.])/],
    ['claude', /^claude(?:$|[-_.])/], ['deepseek', /^deepseek(?:$|[-_.])/],
    ['kimi', /^(?:kimi|moonshot)(?:$|[-_.])/], ['gemini', /^gemini(?:$|[-_.])/],
    ['qwen', /^qwen(?:\d|$|[-_.])/], ['glm', /^(?:glm|chatglm)(?:\d|$|[-_.])/],
  ];
  for (const part of parts.reverse()) for (const [id, pattern] of rules) if (pattern.test(part)) return [id];
  return ['other'];
}
export function mergeCatalogMetadata(local = [], remote = []) {
  const records = new Map();
  for (const entry of [...local, ...remote]) {
    if (!entry || !['category', 'model-category', 'route-protocol', 'model-protocol'].includes(entry.kind)) throw new Error('catalog_invalid_record');
    if (entry.id !== metadataId(entry.kind, entry.providerId, entry.model)) throw new Error('catalog_invalid_id');
    if (!Number.isSafeInteger(entry.revision?.counter) || entry.revision.counter < 0 || typeof entry.revision.deviceId !== 'string') throw new Error('catalog_invalid_revision');
    if (typeof entry.providerId !== 'string' || typeof entry.model !== 'string') throw new Error('catalog_invalid_target');
    if (typeof entry.deleted !== 'boolean' || entry.providerId.length > 200 || entry.model.length > 1000) throw new Error('catalog_invalid_record');
    if (entry.kind === 'category' && (!entry.model.startsWith('custom-') || typeof entry.value !== 'string' || !entry.value.trim() || entry.value.length > 80)) throw new Error('catalog_invalid_category');
    if (entry.kind === 'model-category' && entry.value !== null && (!Array.isArray(entry.value) || entry.value.length > 64 || entry.value.some(v => typeof v !== 'string' || v.length > 100))) throw new Error('catalog_invalid_categories');
    if (entry.kind.endsWith('protocol') && entry.value !== null && typeof entry.value !== 'string') throw new Error('catalog_invalid_protocol');
    const normalized = {id:entry.id,kind:entry.kind,providerId:entry.providerId,model:entry.model,value:entry.value,deleted:entry.deleted,revision:{counter:entry.revision.counter,deviceId:entry.revision.deviceId}};
    const old = records.get(entry.id);
    const order = old ? entry.revision.counter - old.revision.counter || entry.revision.deviceId.localeCompare(old.revision.deviceId, 'en') : 1;
    if (!old || order > 0 || (order === 0 && JSON.stringify(normalized) > JSON.stringify(old))) records.set(entry.id, structuredClone(normalized));
  }
  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
export function catalogCategories(records = []) {
  return [...BUILTIN_CATEGORIES, ...records.filter(r => r.kind === 'category' && !r.deleted).map(r => ({ id: r.model, name: r.value }))];
}
export function modelCategories(records, providerId, model) {
  const entry = records.find(r => r.id === metadataId('model-category', providerId, model));
  const values = entry && !entry.deleted && entry.value !== null ? entry.value : inferModelCategories(model);
  const available = new Set(catalogCategories(records).map(c => c.id));
  return [...new Set(values)].filter(id => available.has(id));
}
export function routeCategories(records, provider) {
  return [...new Set((provider.catalogModels || provider.models || []).flatMap(model => modelCategories(records, provider.id, model)))];
}
export function upstreamProtocol(records, providerId, model = '') {
  const route = records.find(r => r.id === metadataId('route-protocol', providerId));
  return route && !route.deleted && route.value !== null ? route.value : 'passthrough';
}
export function catalogMutation(records, data, revision) {
  const { kind, providerId = '', model = '', value = null } = data;
  if (!['category','model-category','route-protocol','model-protocol'].includes(kind)) throw new Error('catalog_invalid_record');
  if (kind === 'model-protocol') throw new Error('model_protocol_retired');
  if (kind === 'category' && builtins.has(model)) throw new Error('catalog_builtin_category');
  if (kind.endsWith('protocol') && value !== null && !PROTOCOLS.includes(value)) throw new Error('catalog_invalid_protocol');
  if (kind === 'model-category' && value !== null && (!Array.isArray(value) || value.some(id => !catalogCategories(records).some(c => c.id === id)))) throw new Error('catalog_unknown_category');
  const record = { id: metadataId(kind, providerId, model), kind, providerId, model, value, deleted: data.deleted === true, revision };
  return mergeCatalogMetadata(records, [record]);
}

export function retireModelProtocols(records, revision) {
  const active = records.filter(entry => entry.kind === 'model-protocol' && !entry.deleted);
  if (!active.length) return records;
  const counter = Math.max(revision.counter, ...records.map(entry => entry.revision.counter)) + 1;
  if (!Number.isSafeInteger(counter)) throw new Error('catalog_revision_exhausted');
  return mergeCatalogMetadata(records, active.map(entry => ({...entry, deleted: true, revision: {counter, deviceId: revision.deviceId}})));
}
