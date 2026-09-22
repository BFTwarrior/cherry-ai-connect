/**
 * 中文：统一的金紫玻璃下拉菜单，避免原生 select 在 Windows 上出现蓝色系统菜单。
 * English: Shared gold-purple glass select so Windows native menus cannot reintroduce the blue UI.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type MenuSelectOption = { value: string; label: string };

export function MenuSelect({ value, options, onChange, ariaLabel, className = "", disabled = false }: {
  value: string;
  options: MenuSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return <div className={`menu-select ${className} ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="menu-select-trigger" onClick={() => setOpen((current) => !current)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
      <span>{selected?.label || value}</span><Icon name="chevron" size={13} />
    </button>
    {open && <div className="menu-select-menu" role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`menu-select-option ${option.value === value ? "selected" : ""}`} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{option.value === value && <Icon name="check" size={13} />}
      </button>)}
    </div>}
  </div>;
}
