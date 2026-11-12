import { useState } from 'react';
import type { Language } from './app-types';
import { catalogCategories, type CatalogEntry } from '../../gateway/catalog-metadata.mjs';
import { DialogFrame, ModalActions } from './RouteDialogs';
import { Icon } from './ui/Icon';
export type CatalogChange = {kind: string; providerId?: string; model?: string; value?: string | string[] | null; deleted?: boolean};

export function CatalogTags({ ids, records, empty = '目录未同步' }: {ids: string[]; records: CatalogEntry[]; empty?: string}) {
  const categories = catalogCategories(records);
  return <div className="catalog-tags">{ids.length ? ids.map(id => <span className="result-count" key={id}>{categories.find(c => c.id === id)?.name || id}</span>) : <small>{empty}</small>}</div>;
}

export function CatalogEditor({ records, language, save, close }: {records: CatalogEntry[]; language: Language; save: (changes: CatalogChange[]) => Promise<void>; close: () => void}) {
  const tr = (zh: string, en: string) => language === 'zh' ? zh : en;
  const categories = catalogCategories(records);
  const [name, setName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commit = async (changes: CatalogChange[], finish = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await save(changes); if (finish) close(); else setName(''); }
    catch (e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setBusy(false);}
  };
  return <DialogFrame close={close} busy={busy}><div className="modal-icon"><Icon name="layers" size={19}/></div><div className="modal-kicker">MODEL CATALOG</div><h2>{tr('管理分类', 'Manage categories')}</h2>
    <>
      <div className="catalog-category-list">{categories.map(c => <div className="setting-line" key={c.id}>{c.id.startsWith('custom-') ? <><input className="field-control" aria-label={`${tr('分类名称','Category name')} ${c.name}`} value={names[c.id] ?? c.name} maxLength={80} onChange={e => setNames(old => ({...old,[c.id]:e.target.value}))} disabled={busy}/><button className="icon-text-button" disabled={busy || !(names[c.id] ?? c.name).trim()} onClick={() => void commit([{kind:'category',model:c.id,value:(names[c.id] ?? c.name).trim()}])}>{tr('保存','Save')}</button><button className="icon-text-button danger-text" disabled={busy} onClick={() => void commit([{kind:'category',model:c.id,value:c.name,deleted:true}])}>{tr('删除','Delete')}</button></> : <><strong>{c.name}</strong><small>{tr('内置分类','Built-in')}</small></>}</div>)}</div>
      <form onSubmit={e => {e.preventDefault(); if(name.trim()) void commit([{kind:'category',model:`custom-${crypto.randomUUID()}`,value:name.trim()}]);}}><label className="field-label">{tr('新增分类','New category')}<input className="field-control" value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy}/></label>{error && <div className="route-error" role="alert">{error}</div>}<ModalActions cancel={tr('关闭','Close')} submit={tr('新增分类','Add category')} close={close} busy={busy}/></form>
    </>
  </DialogFrame>;
}
