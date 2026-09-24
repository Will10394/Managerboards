# Browser end-to-end test of the tracker hooks + sync engine against a fake shared "table".
#   npm run build:e2e && python3 test/e2e.py      (needs: pip install playwright && playwright install chromium)
import json, threading, http.server, functools, time
from playwright.sync_api import sync_playwright
import os, sys
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST=os.path.join(ROOT,'dist-e2e')
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8765),functools.partial(http.server.SimpleHTTPRequestHandler,directory=DIST))
threading.Thread(target=srv.serve_forever,daemon=True).start()
table={}; events=[]; seq=[0]
def api(route):
    op=route.request.url.rsplit('/',1)[1]; b=json.loads(route.request.post_data or '{}')
    res=None; err=None; conflict=False
    def pub(it):
        seq[0]+=1; events.append({'seq':seq[0],'id':it['id'],'rev':it.get('rev'),'parts':it.get('parts'),'updatedBy':it.get('updatedBy')})
    if op=='list': res=[{'id':k,'rev':v.get('rev'),'parts':v.get('parts')} for k,v in table.items()]
    elif op=='get': res=table.get(b['id'])
    elif op=='create':
        i=b['input']
        if i['id'] in table: err='ConditionalCheckFailed'; conflict=True
        else: table[i['id']]=dict(i); pub(i); res=i
    elif op=='update':
        i=b['input']; c=b.get('condition'); cur=table.get(i['id'])
        if not cur or (c and c.get('rev') and cur.get('rev')!=c['rev']['eq']): err='ConditionalCheckFailed'; conflict=True
        else: cur.update(i); pub(cur); res=cur
    elif op=='del': table.pop(b['id'],None)
    elif op=='events': res=[e for e in events if e['seq']>b['since']]
    route.fulfill(status=200, headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}, body=json.dumps({'result':res,'error':err,'conflict':conflict}))
CHROME=os.environ.get('CHROME') or None
results=[]
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ')+name, extra)
def open_speed(ctx, errs):
    pg=ctx.new_page()
    pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.on('dialog',lambda d: d.accept())
    pg.goto('http://127.0.0.1:8765/index.html')
    pg.get_by_text('Weekly builder rotation').first.wait_for(timeout=15000)
    pg.get_by_text('Weekly builder rotation').first.click(); pg.wait_for_timeout(500)
    pg.get_by_role('button',name='ROTATION').click(); pg.wait_for_timeout(300)  # Speed opens on Board
    return pg
sel=lambda pg,i: pg.locator('select').nth(i)
def wait_synced(pg):
    for _ in range(60):
        pg.wait_for_timeout(100)
        if not pg.evaluate('window.RTCloud.hasPending()'): return True
    return False
def wait_value(pg, i, v, t=4000):
    for _ in range(t//100):
        if sel(pg,i).input_value()==v: return True
        pg.wait_for_timeout(100)
    return False

with sync_playwright() as p:
    br=p.chromium.launch(executable_path=CHROME)
    errs=[]
    A=br.new_context(viewport={'width':1280,'height':900}); A.route('http://fake.local/**',api)
    a=open_speed(A,errs)
    check('A: empty cloud -> app renders sample data', sel(a,9).input_value()=='Project')
    sel(a,9).select_option('Shakers'); check('A: edit saved to cloud', wait_synced(a))
    keys=sorted(table); check('table has sectioned items', {'main/root','main/ws~speed','main/ws~fa','main/ws~bodega'}<=set(keys), keys)

    B=br.new_context(viewport={'width':1280,'height':900}); B.route('http://fake.local/**',api)
    b=open_speed(B,errs)
    check('B (new browser): loads A\'s edit from cloud', sel(b,9).input_value()=='Shakers')

    n_before=len(events)
    sel(a,13).select_option('Learning'); wait_synced(a)
    check('B: sees A\'s second edit live (no reload)', wait_value(b,13,'Learning'))
    b.wait_for_timeout(800)
    echo=[e for e in events[n_before:] if e['updatedBy']!=events[-1]['updatedBy']]
    check('B did not echo the remote change back', len(events)-n_before==1, f'{len(events)-n_before} writes')

    sel(b,10).select_option('Shakers'); wait_synced(b)
    check('A: sees B\'s edit live', wait_value(a,10,'Shakers'))

    a.reload(); a.get_by_text('Weekly builder rotation').first.click(); a.wait_for_timeout(500); a.get_by_role('button',name='ROTATION').click(); a.wait_for_timeout(300)
    check('A reload: all three edits persisted', [sel(a,i).input_value() for i in (9,10,13)]==['Shakers','Shakers','Learning'])

    # stale local copy in a browser that used the standalone file before
    C=br.new_context(viewport={'width':1280,'height':900}); C.route('http://fake.local/**',api)
    stale=json.loads(a.evaluate("localStorage.getItem('rotationTrackerV2')"))
    stale['workspaces']['speed']['rotation']['Mon']['Q1']={}
    C.add_init_script("localStorage.setItem('rotationTrackerV2', %s)" % json.dumps(json.dumps(stale)))
    c=open_speed(C,errs)
    check('C: stale localStorage does not override cloud', sel(c,9).input_value()=='Shakers')

    # standalone fallback: cloud.js blocked -> RTCloud undefined -> plain localStorage app
    S=br.new_context(viewport={'width':1280,'height':900}); S.route('**/cloud.js', lambda r: r.abort())
    s=open_speed(S,errs); sel(s,9).select_option('Shakers'); s.wait_for_timeout(300)
    s.reload(); s.get_by_text('Weekly builder rotation').first.click(); s.wait_for_timeout(400); s.get_by_role('button',name='ROTATION').click(); s.wait_for_timeout(300)
    check('No cloud.js: behaves as standalone (localStorage)', sel(s,9).input_value()=='Shakers' and s.evaluate('typeof window.RTCloud')=='undefined')

    # migration: empty cloud + this browser has real data -> upload on confirm
    table.clear(); events.clear()
    D=br.new_context(viewport={'width':1280,'height':900}); D.route('http://fake.local/**',api)
    mine=json.loads(json.dumps(stale)); mine['workspaces']['speed']['rotation']['Mon']['Q1'][next(iter(stale['workspaces']['speed']['rotation']['Mon']['Q2']))]='Feed the Belt'
    mine['weekOf']='2026-09-21'
    D.add_init_script("if(!sessionStorage.x){sessionStorage.x=1;localStorage.setItem('rotationTrackerV2', %s)}" % json.dumps(json.dumps(mine)))
    d=open_speed(D,errs); wait_synced(d)
    check('Migration: browser data uploaded to empty cloud', 'main/root' in table)
    E=br.new_context(viewport={'width':1280,'height':900}); E.route('http://fake.local/**',api)
    e=open_speed(E,errs)
    check('Migration: other browser sees migrated data', e.locator('input[type=date]').first.input_value()=='2026-09-21')
    check('No page errors', not errs, errs)
    
print('\n%d/%d passed' % (sum(r for _,r in results), len(results)))
sys.exit(0 if all(r for _,r in results) else 1)
