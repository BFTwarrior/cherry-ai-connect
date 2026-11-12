import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {CatalogEditor} from '../renderer/src/CatalogEditor';
afterEach(cleanup);
it('category management has no per-model protocol entry and saves custom categories',async()=>{
 const save=vi.fn(async()=>{});
 render(<CatalogEditor records={[]} language="zh" save={save} close={()=>{}}/>);
 expect(screen.queryByText('此模型上游协议')).toBeNull();
 fireEvent.change(screen.getByLabelText('新增分类'),{target:{value:'工作'}});
 await act(async()=>{fireEvent.submit(screen.getByLabelText('新增分类').closest('form')!);});
 expect(save).toHaveBeenCalledWith([expect.objectContaining({kind:'category',value:'工作'})]);
});
