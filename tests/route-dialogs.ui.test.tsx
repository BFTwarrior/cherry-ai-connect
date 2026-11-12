import {useEffect,useState} from 'react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {DialogFrame,ProviderForm} from '../renderer/src/RouteDialogs';
afterEach(()=>{cleanup();vi.useRealTimers();});
function Harness(){
 const [tick,setTick]=useState(0),[error,setError]=useState(''),[open,setOpen]=useState(true),[busy,setBusy]=useState(false);
 useEffect(()=>{const timer=setInterval(()=>setTick(t=>t+1),2000);return()=>clearInterval(timer);},[]);
 return <><span>{tick}</span><button onClick={()=>setError('后台状态已更新')}>Toast</button><button onClick={()=>setOpen(true)}>打开</button>{open&&<DialogFrame busy={busy} close={()=>setOpen(false)}><ProviderForm language="zh" busy={busy} close={()=>setOpen(false)} submit={e=>{e.preventDefault();setBusy(true);queueMicrotask(()=>{setBusy(false);setError('线路代号已存在');});}}/><span role="status">{error}</span></DialogFrame>}</>;
}
describe('route draft survives the actual parent update triggers',()=>{
 it('preserves all four inputs, DOM identity, focus and cursor through polling, Toast and save errors',async()=>{
  vi.useFakeTimers();render(<Harness/>);
  const id=screen.getByLabelText('线路代号') as HTMLInputElement;
  const name=screen.getByLabelText('线路名称') as HTMLInputElement;
  const url=screen.getByLabelText('API URL') as HTMLInputElement;
  const key=screen.getByLabelText('中转站 Key') as HTMLInputElement;
  for(const [element,value] of [[id,'draft-route'],[name,'未保存的中文线路'],[url,'https://example.invalid/v1'],[key,'SYNTHETIC_SECRET']] as const) fireEvent.change(element,{target:{value}});
  name.focus();name.setSelectionRange(2,4);
  await act(async()=>{vi.advanceTimersByTime(120000);});
  expect(screen.getByLabelText('线路名称')).toBe(name);expect(document.activeElement).toBe(name);expect(name.selectionStart).toBe(2);expect(name.selectionEnd).toBe(4);
  fireEvent.click(screen.getByText('Toast'));expect(name.value).toBe('未保存的中文线路');
  await act(async()=>{fireEvent.submit(id.closest('form')!);await Promise.resolve();});
  expect(screen.getByRole('status').textContent).toContain('线路代号已存在');
  expect(id.value).toBe('draft-route');expect(url.value).toBe('https://example.invalid/v1');expect(key.value).toBe('SYNTHETIC_SECRET');
  expect(screen.getByLabelText('线路名称')).toBe(name);expect(localStorage.length).toBe(0);
 });
 it('retains composition text across a parent poll and clears only on explicit cancel',async()=>{
  vi.useFakeTimers();render(<Harness/>);const name=screen.getByLabelText('线路名称') as HTMLInputElement;
  name.focus();fireEvent.compositionStart(name);fireEvent.input(name,{target:{value:'zhong'},isComposing:true});
  await act(async()=>{vi.advanceTimersByTime(4000);});expect(screen.getByLabelText('线路名称')).toBe(name);expect(name.value).toBe('zhong');
  fireEvent.compositionEnd(name,{data:'中文线路'});fireEvent.change(name,{target:{value:'中文线路'}});
  fireEvent.click(screen.getByText('Toast'));expect(name.value).toBe('中文线路');
  fireEvent.click(screen.getByText('取消'));fireEvent.click(screen.getByText('打开'));expect((screen.getByLabelText('线路名称') as HTMLInputElement).value).toBe('');
 });
});
