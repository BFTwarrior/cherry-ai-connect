/**
 * 中文：统一的金紫玻璃下拉菜单，避免原生 select 在 Windows 上出现蓝色系统菜单。
 * English: Shared gold-purple glass select so Windows native menus cannot reintroduce the blue UI.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [placement,setPlacement]=useState({up:false,height:360});
  const selected = options.find((option) => option.value === value);
  useLayoutEffect(()=>{
    if(!open || !rootRef.current) return;
    const root=rootRef.current;
    const measure=()=>{
      const rect=root.getBoundingClientRect(),modal=root.closest('.modal')?.getBoundingClientRect();
      const below=(modal?.bottom ?? window.innerHeight)-rect.bottom-16;
      const above=rect.top-(modal?.top ?? 0)-16;
      const up=below<Math.min(options.length*38+14,360) && above>below;
      setPlacement({up,height:Math.max(60,Math.min(360,up?above:below))});
    };
    measure();window.addEventListener('resize',measure);
    return()=>window.removeEventListener('resize',measure);
  },[open,options.length]);

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
    {open && <div className={`menu-select-menu ${placement.up?'is-dropup':''}`} style={{maxHeight:placement.height,overflowY:'auto'}} role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`menu-select-option ${option.value === value ? "selected" : ""}`} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{option.value === value && <Icon name="check" size={13} />}
      </button>)}
    </div>}
  </div>;
}
