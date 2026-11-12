import { useState, type FormEvent, type ReactNode } from 'react';
import type { ConfirmDialogState, Language, Provider } from './app-types';
import { PROTOCOL_OPTIONS } from '../../gateway/catalog-metadata.mjs';
import { MenuSelect } from './ui/MenuSelect';
import { Icon } from './ui/Icon';

export function DialogFrame({ children, close, busy = false }: {children: ReactNode; close: () => void; busy?: boolean}) {
  return <div className="modal-backdrop" onMouseDown={e => { if (!busy && e.target === e.currentTarget) close(); }}><div className="modal" role="dialog" aria-modal="true">{children}</div></div>;
}
export function ModalActions({ cancel, submit, disabled = false, busy = false, close }: {cancel: string; submit: string; disabled?: boolean; busy?: boolean; close: () => void}) {
  return <div className="form-actions"><button type="button" className="button button-ghost" onClick={close} disabled={busy}>{cancel}</button><button type="submit" className="button button-secondary button-text-emphasis" disabled={disabled || busy}><span className="button-action-label">{busy ? '保存中… / Saving…' : submit}</span></button></div>;
}
export function ProviderForm({ provider, language, busy, submit, close }: {provider?: Provider; language: Language; busy: boolean; submit: (e: FormEvent<HTMLFormElement>) => void; close: () => void}) {
  const tr = (zh: string, en: string) => language === 'zh' ? zh : en;
  // This state belongs to a stable component, never reset by polling or Toast updates.
  const [draft, setDraft] = useState(() => ({id: provider?.id || '', name: provider?.name || '', baseUrl: provider?.baseUrl || '', apiKey: '', upstreamProtocol: provider?.upstreamProtocol || 'passthrough'}));
  const fields = [
    {name: 'id', label: tr('线路代号', 'Route ID'), placeholder: 'router-luna', type: 'text'},
    {name: 'name', label: tr('线路名称', 'Route name'), placeholder: tr('例如 我的 Luna 线路', 'e.g. My Luna route'), type: 'text'},
    {name: 'baseUrl', label: 'API URL', placeholder: 'https://example.com', type: 'url'},
    {name: 'apiKey', label: provider ? tr('中转站 Key（留空保持不变）', 'Upstream key (blank keeps it)') : tr('中转站 Key', 'Upstream key'), placeholder: 'sk-...', type: 'password'},
  ] as const;
  return <form onSubmit={submit} aria-busy={busy}>
    {fields.map(field => <label className="field-label" key={field.name}>{field.label}<input className="field-control" name={field.name} type={field.type} placeholder={field.placeholder} value={draft[field.name]} onChange={e => setDraft(current => ({...current, [field.name]: e.target.value}))} readOnly={busy || (field.name === 'id' && !!provider)} required={field.name !== 'apiKey'} autoComplete={field.name === 'apiKey' ? 'new-password' : 'off'} /></label>)}
    <div className="field-label">{tr('上游协议', 'Upstream protocol')}<MenuSelect className="form-menu-select" value={draft.upstreamProtocol} options={[...PROTOCOL_OPTIONS]} onChange={value => setDraft(current => ({...current, upstreamProtocol: value}))} ariaLabel={tr('上游协议', 'Upstream protocol')} disabled={busy}/><input type="hidden" name="upstreamProtocol" value={draft.upstreamProtocol}/></div>
    <div className="form-tip"><Icon name="shield" size={14}/>{tr('模型从目录读取，标签根据模型生成；协议不会按模型名称猜测。', 'Models and tags come from the catalog. Protocols are explicitly configured.')}</div>
    <ModalActions cancel={tr('取消', 'Cancel')} submit={provider ? tr('保存并同步', 'Save & sync') : tr('添加并同步', 'Add & sync')} close={close} busy={busy}/>
  </form>;
}
export function ConfirmDialog({ dialog, resolve, language }: {dialog: ConfirmDialogState; resolve: (answer: boolean) => void; language: Language}) {
  if (!dialog) return null;
  const tone = dialog.tone || 'primary';
  return <div className="confirm-backdrop" onMouseDown={e => {if (e.target === e.currentTarget) resolve(false);}}><section className={`confirm-dialog confirm-dialog-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message"><div className="confirm-dialog-header"><span className="confirm-icon"><Icon name={dialog.icon || (tone === 'danger' ? 'trash' : 'shield')} size={18}/></span><div><div className="confirm-kicker">{language === 'zh' ? '需要确认' : 'CONFIRM ACTION'}</div><h2 id="confirm-dialog-title">{dialog.title}</h2><p id="confirm-dialog-message">{dialog.message}</p></div></div><div className="confirm-actions"><button className="button button-ghost" onClick={() => resolve(false)}>{dialog.cancelLabel}</button><button className={`button confirm-submit confirm-submit-${tone}`} autoFocus onClick={() => resolve(true)}>{dialog.confirmLabel}</button></div></section></div>;
}
