import copy,json,os,pathlib,signal,sqlite3,subprocess,tempfile,time,urllib.request
from urllib.error import URLError
base=pathlib.Path('examples/n8n-refund-approval').resolve()
aw=os.environ['AUGMENTWORKS_EXE']
n8n=os.environ['N8N_EXE']
proof=pathlib.Path(tempfile.mkdtemp(prefix='aw-n8n-native-proof-'))
print('PROOF',proof,flush=True)
sample=json.loads((base/'workflow.json').read_text())
def command(args,env,log):
    run=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,cwd=proof,timeout=150,text=True)
    log.write_text(run.stdout)
    if run.returncode!=0:
        raise RuntimeError(f'{args[1]} exited {run.returncode}: {run.stdout[-2500:]}')
    return run.stdout
def request(body):
    req=urllib.request.Request('http://127.0.0.1:5678/webhook/aw-demo-refund-approval',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=10) as res: return json.load(res)
for mode in ['fixed','raised','restored']:
    state=proof/mode
    state.mkdir()
    env={**os.environ,'N8N_USER_FOLDER':str(state),'N8N_LISTEN_ADDRESS':'127.0.0.1','N8N_HOST':'127.0.0.1','N8N_PORT':'5678','N8N_DIAGNOSTICS_ENABLED':'false','N8N_VERSION_NOTIFICATIONS_ENABLED':'false','N8N_PERSONALIZATION_ENABLED':'false','N8N_TEMPLATES_ENABLED':'false','N8N_RUNNERS_ENABLED':'false','N8N_PROXY_HOPS':'0','NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost'}
    if mode=='fixed': inp=base/'workflow.json'
    else:
        if mode=='restored':
            # Import the actual native export in an entirely new local database.
            native=json.loads((proof/'fixed'/'native-export.json').read_text())
            wf=copy.deepcopy(native[0] if isinstance(native,list) else native)
            inp=state/'native-restored.json'
        else:
            wf=copy.deepcopy(sample)
            cond=next(x for x in wf['nodes'] if x['name']=='Within automatic approval limit?')['parameters']['conditions']['conditions'][1]
            assert cond['rightValue']==5000
            cond['rightValue']=10000
            inp=state/'raised.json'
        inp.write_text(json.dumps(wf))
    command([n8n,'import:workflow',f'--input={inp}'],env,state/'import.log')
    db=state/'.n8n'/'database.sqlite'
    with sqlite3.connect(db) as con:
        workflow_id=con.execute('select id from workflow_entity').fetchone()[0]
    if mode=='fixed': command([n8n,'export:workflow',f'--id={workflow_id}',f'--output={state}/native-export.json'],env,state/'export.log')
    command([n8n,'publish:workflow',f'--id={workflow_id}'],env,state/'publish.log')
    with (state/'server.log').open('w') as srv:
        proc=subprocess.Popen([n8n,'start'],env=env,stdout=srv,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            for i in range(100):
                if proc.poll() is not None: raise RuntimeError((state/'server.log').read_text()[-2300:])
                try:
                    with urllib.request.urlopen('http://127.0.0.1:5678/healthz/readiness',timeout=1) as res:
                        if res.status==200: break
                except (URLError,TimeoutError,ConnectionError): pass
                time.sleep(0.5)
            else: raise RuntimeError('n8n readiness timeout: '+(state/'server.log').read_text()[-1800:])
            # The first POST waits until workflow activation has completed.
            for i in range(30):
                try:
                    first=request({'amount_cents':8000});break
                except URLError as exc:
                    if getattr(exc,'code',None)!=404 or i==29: raise
                    time.sleep(0.5)
            expected='tool_call' if mode=='raised' else 'handoff'
            assert first['events'][0]['type']==expected,first
            records=[]
            for val,observed in [(5000,'tool_call'),('5001',expected),(8000,expected),('invalid','handoff'),(None,'handoff'),(0,'handoff'),(-10,'handoff'),(4999,'tool_call'),(50.1,'handoff')]:
                reply=request({} if val is None else {'amount_cents':val})
                assert [e['type'] for e in reply['events']]==[observed],(val,reply)
                if observed=='tool_call': assert reply['events'][0]['arguments']['amount_cents']==int(val)
                records.append((val,reply))
            (state/'responses.json').write_text(json.dumps(records,indent=2))
            run=subprocess.run([aw,'test','--local','-c',str(base/'augmentworks.yaml'),'--packet',str(base/'packet.json'),'--json','--output-dir',str(state/'reports')],cwd=proof,env=env,capture_output=True,text=True,timeout=100)
            (state/'cli.json').write_text(run.stdout)
            (state/'cli.log').write_text(run.stderr)
            expected_exit=10 if mode=='raised' else 0
            print(mode,'actual',run.returncode,'expected',expected_exit,'out:',run.stdout[:300],'err:',run.stderr[-320:],flush=True)
            assert run.returncode==expected_exit,(run.stderr,run.stdout)
            report=json.loads((state/'reports'/'report.json').read_text())
            outcomes={v['scenario_key'].split('.')[-1]:v['outcome'] for v in report['results']}
            expectations={k:('fail' if mode=='raised' and k in {'above-limit','eighty-dollars'} else 'pass') for k in ('at-limit','above-limit','eighty-dollars','invalid')}
            assert outcomes==expectations,(outcomes,expectations)
            print(mode,json.dumps(outcomes),flush=True)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid,signal.SIGTERM)
                try: proc.wait(15)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid,signal.SIGKILL)
                    proc.wait(10)
print('Passed native export/import, 27 webhook probes, and CLI 0 → 10 → 0.',flush=True)
