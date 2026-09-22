/**
 * 中文：客户端 Key 表单只负责“名称跟随线路”的交互，不负责保存或访问密钥原值。
 * English: This form owns route-following names only; persistence and secret access stay outside it.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import type { ClientKey, Language, Provider, ReasoningLevel } from "./app-types";
import { Icon } from "./ui/Icon";
import { MenuSelect } from "./ui/MenuSelect";

const levels: ReasoningLevel[] = ["unchanged", "low", "medium", "high", "xhigh", "max"];

export function ClientKeyForm({ clientKey, providers, defaultLevel, language, onSubmit, actions }: {
  clientKey?: ClientKey;
  providers: Provider[];
  defaultLevel: ReasoningLevel;
  language: Language;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  actions: ReactNode;
}) {
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const initialProviderId = clientKey?.providerId || providers[0]?.id || "";
  const initialProvider = providers.find((provider) => provider.id === initialProviderId);
  const [providerId, setProviderId] = useState(initialProviderId);
  const [nameCustomized, setNameCustomized] = useState(clientKey?.nameCustomized === true);
  const [name, setName] = useState(clientKey?.name || initialProvider?.name || "");
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(clientKey?.reasoningLevel || defaultLevel || "unchanged");

  const changeProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    if (!nameCustomized) setName(providers.find((provider) => provider.id === nextProviderId)?.name || "");
  };

  const changeName = (nextName: string) => {
    setName(nextName);
    const routeName = providers.find((provider) => provider.id === providerId)?.name || "";
    if (nextName !== routeName) setNameCustomized(true);
  };

  return <form onSubmit={onSubmit}>
    <label className="field-label">{tr("Key 名称", "Key name")}<input className="field-control" name="name" value={name} onChange={(event) => changeName(event.target.value)} placeholder={tr("默认跟随线路名称", "Follows the route name by default")} required /><input type="hidden" name="nameCustomized" value={nameCustomized ? "true" : "false"} /><small className={`field-help name-sync-state ${nameCustomized ? "custom" : "synced"}`}>{nameCustomized ? tr("已使用自定义名称；以后切换或重命名线路时不再自动修改。", "Custom name locked; route changes will no longer rename this key.") : tr("名称正跟随绑定线路；手动修改后将停止自动同步。", "Name follows the bound route until you customize it.")}</small></label>
    <label className="field-label">{tr("绑定中转站线路", "Bind upstream route")}<MenuSelect className="form-menu-select" value={providerId} options={[{ value: "", label: tr("请选择线路", "Select a route") }, ...providers.map((provider) => ({ value: provider.id, label: `${provider.name || provider.id} · ${provider.id}` }))]} onChange={changeProvider} disabled={!providers.length} ariaLabel={tr("绑定中转站线路", "Bind upstream route")} /><input type="hidden" name="providerId" value={providerId} required /></label>
    <label className="field-label">{tr("思考强度", "Reasoning level")}<MenuSelect className="form-menu-select reasoning-form-menu" value={reasoningLevel} options={levels.map((level) => ({ value: level, label: level.toUpperCase() }))} onChange={(value) => setReasoningLevel(value as ReasoningLevel)} ariaLabel={tr("思考强度", "Reasoning level")} /><input type="hidden" name="reasoningLevel" value={reasoningLevel} readOnly /><small className="field-help">{tr("选择 UNCHANGED 时，网关保留客户端请求原本的思考策略。", "Choose UNCHANGED to preserve the reasoning strategy supplied by the client.")}</small></label>
    {!providers.length && <div className="form-warning"><Icon name="route" size={14} />{tr("请先添加一条中转站线路，再生成客户端 Key。", "Add an upstream route before creating a client key.")}</div>}
    {actions}
  </form>;
}
