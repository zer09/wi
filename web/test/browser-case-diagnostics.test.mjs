import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import Reporter, { sourceFiles, joinedScenarios, families, livePhases, contentPhases, cleanupSteps, annotationType, reportName,
  storedObservation, appendMeasurementAnnotation, encodeReport, decodeReport, publicSummary, writeReport, kinds, matchers, bodyClasses } from '../test-support/browser-case-diagnostics.mjs';
import { preparationRedactor, sanitizeRecord } from '../test-support/browser-fixture-preparation.mjs';
import { phases } from '../test-support/live-commit-measurements.mjs';
import { contentPhases as actualContentPhases } from '../test-support/content-measurements.mjs';

const {serializeError}=createRequire(import.meta.url)('../node_modules/playwright/lib/util.js');
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const quiet=preparationRedactor({});
const clone=v=>structuredClone(v);
async function temporary(t) { const root=await fs.mkdtemp(join(tmpdir(),'wi-case-diagnostic-unit-'));t.after(()=>fs.rm(root,{recursive:true}));return root; }
const declaration=(n=3,title='synthetic case',line=56,column=3)=>({location:{file:join(ROOT,sourceFiles[n-1]),line,column},title});
const result=(extra={})=>({status:'failed',workerIndex:0,duration:200,errors:[],annotations:[],...extra});
function packet(family=1,checkpoint='first_dom') {
  const info={annotations:[]};appendMeasurementAnnotation(()=>({info,family,packet:Object.freeze({first_operation:checkpoint}),body_success:false,cleanup:false,steps:[{name:'root',ok:false}]}));return info.annotations;
}
const envelope={version:1,scope:'invocation observations only',consumed:true,first_failure:'child',
  child:{spawned:true,closed:true,error_observed:false,code:1,signal:null},terminal:{code:1,signal:null}};
const c91Wrappers=[
  [16,10,'Rich parity failed: stage=fresh; check=handshake',{stage:'fresh',check:'handshake'},[10,6,6,null,null,null,null,null,null]],
  [18,11,'Skill fidelity failed: stage=task-2; check=paused-12',{stage:'task-2',check:'paused-12'},[11,4,16,null,null,null,null,null,null]],
  [31,12,'Stale history failed: release and exact stale-history rejection; kind=TimeoutError line=295; capture=private-tail',{stage:'release and exact stale-history rejection',kind:'TimeoutError',stored_line:295},[12,5,null,4,null,295,null,null,null]],
  [21,13,'Account mismatch failed: one-shot private rotation after audited completion; kind=ProtocolError line=297; capture=private-tail',{stage:'one-shot private rotation after audited completion',kind:'ProtocolError',stored_line:297},[13,4,null,5,null,297,null,null,null]],
];
function emit(tests,results,registered=tests.length) {
  const r=new Reporter();r.onBegin({projects:[]},{allTests:()=>Array.from({length:registered},(_,i)=>tests[i]??declaration(1,'registered '+i))});
  for(let i=0;i<tests.length;i++){r.onTestBegin(tests[i],results[i]);r.onTestEnd(tests[i],results[i]);}
  return r;
}
function report(r,run='failed') { return encodeReport({completion:'complete',run,counts:r.counts,cases:r.cases,omitted:r.omitted},quiet); }
function realistic() {
  const tests=[declaration(10,joinedScenarios[0]),declaration(10,joinedScenarios[1]),declaration(30),declaration(4),declaration(12),declaration(3),declaration(11),declaration(29)];
  const errors=[
    [{message:'Joined browser assertion failed: task 1 before-commit acceptance; toBe; line=254',location:{file:tests[0].location.file,line:450,column:17}}],
    [{message:'Joined browser assertion failed: task 2 exact authoritative answer and tool output; toHaveText; line=345',location:{file:tests[1].location.file,line:450,column:17}}],
    [{message:'private timeout details',location:{file:tests[2].location.file,line:275,column:9}}],
    [{message:'private body error'},{message:'secondary private error'}],
    [{message:'private native boundary'}],
    [{message:'Client handoff failed: stage=first-completion; check=dto'}],
    [{message:'Lifecycle failure failed: checkpoint 2 display; kind=TimeoutError; check=entry-fields; entry=2; capture={}; faults={}; posts={}'}],
    [{message:'Reload epoch failed: explicit Connect reads retained A exactly once without command recovery or resubmission; capture={"create":{},"task":{"body_rejection_class":"get_response_body_no_resource"},"latest":[]}; disconnectedView=null; faults={}; network={}; h20Progress=null'}],
  ];
  const results=errors.map((errors,i)=>{
    let annotations=[];if(i===3)annotations=packet(2,'partial_dom_poll');else if(i===4)annotations=packet();
    return result({errors:errors.map(e=>({...serializeError(new Error(e.message)),location:e.location})),status:i===2?'timedOut':'failed',annotations});
  });
  const allTests=[...tests,...Array.from({length:81},(_,i)=>declaration(1,'registered '+i,100+i,1))];
  const r=emit(allTests,[...results,...Array.from({length:81},()=>result({status:'passed'}))],89);
  return {r,encoded:report(r),tests,results};
}

test('C89 maps bind the actual 34-source inventory, legacy ID order and six joined public labels',async()=>{
  assert.equal(sourceFiles.length,34);assert.equal(new Set(sourceFiles).size,34);
  const launch=await fs.readFile(new URL('../scripts/launch-browser-suite.mjs',import.meta.url),'utf8');
  const names=[...launch.slice(launch.indexOf('const reporterFiles'),launch.indexOf('const handoffStages')).matchAll(/'([a-z-]+)'/g)].map(m=>`web/e2e/${m[1]}.spec.mjs`);
  assert.deepEqual(sourceFiles,names);
  const actual=(await fs.readdir(new URL('../e2e/',import.meta.url))).filter(n=>n.endsWith('.spec.mjs')).map(n=>'web/e2e/'+n).sort();
  assert.deepEqual([...sourceFiles].sort(),actual);
  const joined=await fs.readFile(new URL('../e2e/joined.spec.mjs',import.meta.url),'utf8');
  for(const name of joinedScenarios)assert.ok(joined.includes("['"+name+"',"));
  assert.deepEqual(livePhases,phases);assert.deepEqual(contentPhases,[...actualContentPhases,'outside_path']);
});
test('C89 closed family vocabularies bind literal and template stage/check assignments in all nine actual sources',async t=>{
  for(const family of families.slice(0,9))await t.test(sourceFiles[family.source-1],async()=>{
    const text=await fs.readFile(join(ROOT,sourceFiles[family.source-1]),'utf8');assert.ok(text.includes(family.prefix));
    const ast=ts.createSourceFile('source.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const stages=new Set(),checks=new Set();
    const take=(node,set)=>{
      if(ts.isStringLiteral(node))set.add(node.text);
      else if(ts.isConditionalExpression(node)){take(node.whenTrue,set);take(node.whenFalse,set);}
      else if(ts.isTemplateExpression(node)){
        const nums=node.head.text==='task '?[1,2]:[1,2,3,4];
        for(const n of nums)set.add(node.head.text+n+node.templateSpans.map(s=>s.literal.text).join(''));
      }
    };
    function visit(n){
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(n.left)){
        if(n.left.text==='stage')take(n.right,stages);if(n.left.text==='check')take(n.right,checks);
      }
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer){if(n.name.text==='stage')take(n.initializer,stages);if(n.name.text==='check')take(n.initializer,checks);}
      ts.forEachChild(n,visit);
    }
    visit(ast);
    for(const s of stages)if(s!=='unknown')assert.ok(family.stages.includes(s),'missing stage: '+s);
    for(const s of checks)if(s!=='unknown')assert.ok(family.checks.includes(s),'missing check: '+s);
    for(const s of family.stages)assert.ok(stages.has(s)||text.includes("fatal(label, '"+s+"'"),'stale stage: '+s);
    for(const s of family.checks)assert.ok(checks.has(s)||text.includes("'"+s+"'"),'stale check: '+s);
  });
});
test('C91 appends four families without changing the reviewed source and family dictionaries',()=>{
  const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(digest(sourceFiles),'9bdf81ed7a07b1de20ff3f7d5e96efa31f38361aebc8f03b40eeb8d1c6ca32f1');
  assert.equal(digest(families.slice(0,9)),'a7196db54e5b197a1ac00bcc8a0aa17cfcbca5e16573636876220209ae77b206');
  assert.equal(digest(kinds),'ac68313482d32433eacf8cebfebc39811bfc6baf7535e10f17cdcd42df3a9bea');
  assert.equal(digest(matchers),'fd14bd2a654aee81e48026c3bde30b2b33204f5a30f4318393441e2ac272ab2d');
  assert.equal(digest(bodyClasses),'f106079606a00e2e425a80523440ac761f3de37f5cbf5b2ee3715a86ad3b2766');
  assert.equal(families.length,13);assert.deepEqual(families.slice(9).map(f=>f.source),[16,18,31,21]);
  const encoded=report(emit([declaration()],[result()]));assert.equal(encoded.version,1);assert.equal(encoded.source_map,2);
  assert.equal(reportName,'case-observations.v1.json');assert.equal(publicSummary(encoded,envelope,quiet).value.case_observations.source_map,2);
});
test('C91 actual constructors and exact closed vocabularies bind all four source grammars and finite skill loops',async t=>{
  for(const family of families.slice(9))await t.test(family.prefix,async()=>{
    const text=await fs.readFile(join(ROOT,sourceFiles[family.source-1]),'utf8');
    const ast=ts.createSourceFile('source.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const stages=new Set(),checks=new Set(),constructors=[],loops=[],dynamic=[];
    const compact=n=>n.getText(ast).replace(/\s+/g,'');
    const tasks=[0,1],gates=tasks.flatMap(task=>Array.from({length:6},(_,i)=>task*6+i+1));
    const forms=new Map([
      ['`task-${task+1}`',tasks.map(task=>'task-'+(task+1))],
      ["index===1?'changed-observer':'deleted-observer'",['changed-observer','deleted-observer']],
      ['`paused-${task*6+1}`',tasks.map(task=>'paused-'+(task*6+1))],
      ['`drive-${gate}`',gates.map(gate=>'drive-'+gate)],
      ['gate<task*6+6?`paused-${gate+1}`:`finished-${task+1}`',tasks.flatMap(task=>Array.from({length:6},(_,i)=>{
        const gate=task*6+i+1;return gate<task*6+6?'paused-'+(gate+1):'finished-'+(task+1);
      }))],
    ]);
    function take(node,set){
      if(ts.isStringLiteral(node)){set.add(node.text);return;}
      assert.equal(family.source,18,'Only the inventoried skill forms are dynamic.');
      const form=compact(node);assert.ok(forms.has(form),'Unexpected dynamic label: '+form);dynamic.push(form);
      for(const value of forms.get(form))set.add(value);
    }
    function visit(n){
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer){
        if(n.name.text==='stage')take(n.initializer,stages);if(n.name.text==='check')take(n.initializer,checks);
      }
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(n.left)){
        if(n.left.text==='stage')take(n.right,stages);if(n.left.text==='check')take(n.right,checks);
      }
      if(ts.isNewExpression(n)&&n.expression.getText(ast)==='Error'&&ts.isTemplateExpression(n.arguments?.[0])&&n.arguments[0].head.text.startsWith(family.prefix))constructors.push(n.arguments[0]);
      if(ts.isForOfStatement(n)&&['consttask','constindex'].includes(compact(n.initializer)))loops.push(compact(n.initializer)+'of'+compact(n.expression));
      if(ts.isForStatement(n)&&n.initializer?.getText(ast).startsWith('let gate'))loops.push([n.initializer,n.condition,n.incrementor].map(compact).join(';'));
      ts.forEachChild(n,visit);
    }
    visit(ast);assert.equal(constructors.length,1);
    const constructor=constructors[0];
    if(family.source===16){
      assert.equal(compact(constructor),"`Richparityfailed:stage=${stages.includes(stage)?stage:'unknown'};check=${checks.includes(check)?check:'unknown'}`");
      for(const [name,values]of [['stages',family.stages],['checks',family.checks]]){
        const variable=ast.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(n=>n.name.getText(ast)===name);
        assert.ok(ts.isArrayLiteralExpression(variable?.initializer));assert.deepEqual(variable.initializer.elements.map(n=>{assert.ok(ts.isStringLiteral(n));return n.text;}),values);
      }
      for(const value of stages)assert.ok(family.stages.includes(value));for(const value of checks)assert.ok(family.checks.includes(value));
    }else{
      assert.deepEqual([...stages].sort(),[...family.stages].sort());assert.deepEqual([...checks].sort(),[...family.checks].sort());
      if(family.source===18){
        assert.equal(compact(constructor),'`Skillfidelityfailed:stage=${stage};check=${check}`');
        assert.deepEqual(dynamic.sort(),[...forms.keys()].sort());
        assert.deepEqual(loops,['consttaskof[0,1]','letgate=task*6+1;gate<=task*6+6;gate++','constindexof[1,2]','consttaskof[0,1]']);
      }else{
        assert.deepEqual(constructor.templateSpans.map(s=>s.expression.getText(ast)),['stage','kind','line','JSON.stringify(observed)','JSON.stringify(assetEvidence)','JSON.stringify(faults)','JSON.stringify(posts)','JSON.stringify(displayReads)']);
        assert.deepEqual(constructor.templateSpans.map(s=>s.literal.text),['; kind=',' line=','; capture=','; assets=','; faults=','; posts=','; display=','']);
        assert.equal(constructor.head.text,family.prefix+' ');
        assert.match(text,/\['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'\]\.includes\(cause\?\.name\)/);
        assert.ok(text.includes("?.[1] ?? 'none'"));
      }
    }
  });
});
test('C89 source guards bind matcher, error-kind and body-rejection vocabularies without copying message tails',async()=>{
  const joined=await fs.readFile(join(ROOT,sourceFiles[9]),'utf8');
  for(const matcher of matchers)assert.ok(joined.includes("'"+matcher+"'"));
  const classes=new Set();
  for(const sourceID of [29,30]){
    const text=await fs.readFile(join(ROOT,sourceFiles[sourceID-1]),'utf8');
    for(const kind of kinds)if(kind!=='other')assert.ok(text.includes("'"+kind+"'")||sourceID===29);
    const start=sourceID===29?text.indexOf('function bodyRejectionClass'):text.indexOf('facts.body_rejected = true');
    const end=sourceID===29?text.indexOf('function requestFailureClass',start):text.indexOf('throw cause;',start);
    for(const value of bodyClasses)if(text.slice(start,end).includes("'"+value+"'"))classes.add(value);
  }
  assert.deepEqual([...classes].sort(),[...bodyClasses].sort());
});
test('C89 cleanup IDs bind both actual registration tables without moving cleanup',async()=>{
  const found=new Set();
  for(const name of ['live-commit-measurements','content-measurements']){
    const text=await fs.readFile(new URL('../e2e/'+name+'.spec.mjs',import.meta.url),'utf8');
    for(const m of text.matchAll(/(?:acquireResource\(owned,\s*|owned\.register\()'([^']+)'/g)){assert.ok(cleanupSteps.includes(m[1]));found.add(m[1]);}
    for(const m of text.matchAll(/name:\s*'final-collector'/g)){assert.ok(cleanupSteps.includes('final-collector'));found.add('final-collector');}
  }
  assert.deepEqual([...found].sort(),[...cleanupSteps].sort());
});
test('C89 actual source-owned prefix grammars retain only closed stage/check/class/matcher/line observations',async t=>{
  const messages=[
    'Interrupted parity failed: stage=connect-observer; check=handshake',
    'Presentation failed: label=long-selected; stage=final-item; check=fields; kind=TypeError',
    'Fixed head failed: terminal; kind=TimeoutError; check=bytes; capture={}; faults={}; network={}',
    'Selection epoch failed: actual session-list switch retires A display; kind=ProtocolError line=268; capture={"creates":[],"task":{"body_rejection_class":"target_closed"},"latest":[]}; delay={}; faults={}; network={}',
    'Client handoff failed: stage=first-completion; check=dto',
    'Joined browser assertion failed: task 2 final supplied display state; toHaveCount; line=339',
    'Lifecycle failure failed: checkpoint 4 read-only reconcile; kind=Error; check=reconcile-reply; entry=3; capture={}; faults={}; posts={}',
    'Reload epoch failed: actual full reload retires the accepted first document; capture={"create":{},"task":{},"latest":[{"body_rejection_class":"method_io_read"}]}; disconnectedView=null; faults={}; network={}',
    'Tool fidelity failed: first reuse privacy; kind=SyntaxError; faults={}; posts={}',
  ];
  for(const [i,message]of messages.entries())await t.test(families[i].prefix,()=>{
    const observation=storedObservation(sourceFiles[families[i].source-1],message);
    assert.ok(observation.stage!==null);assert.equal(observation.family,i+1);
    assert.equal(JSON.stringify(observation).includes('capture='),false);
    assert.equal(storedObservation(sourceFiles[(families[i].source+1)%34],message),null);
    assert.equal(storedObservation(sourceFiles[families[i].source-1],'private prelude '+message),null);
  });
  const unknown=storedObservation(sourceFiles[9],'Joined browser assertion failed: private stage; private matcher; line=unknown');
  assert.equal(unknown.stage,null);assert.equal(unknown.matcher,null);assert.equal(unknown.stored_line,null);
  assert.equal(storedObservation(sourceFiles[2],'Client handoff failed: stage=create; check=dto; private tail'),null);
});
test('C90 installed serializer carries all nine ordinary Error wrappers through reporter callbacks',async t=>{
  const controls=[
    [9,'Interrupted parity failed: stage=connect-observer; check=handshake',{stage:'connect-observer',check:'handshake'}],
    [13,'Presentation failed: label=long-selected; stage=final-item; check=fields; kind=TypeError',{stage:'final-item',check:'fields',kind:'TypeError',presentation:'long-selected'}],
    [24,'Fixed head failed: terminal; kind=TimeoutError; check=bytes; capture={}; faults={}',{stage:'terminal',check:'bytes',kind:'TimeoutError'}],
    [30,'Selection epoch failed: actual session-list switch retires A display; kind=ProtocolError line=268; capture={"creates":[],"task":{"body_rejection_class":"target_closed"},"latest":[]}; delay={}',{stage:'actual session-list switch retires A display',kind:'ProtocolError',stored_line:268,body_classes:['target_closed']}],
    [3,'Client handoff failed: stage=first-completion; check=dto',{stage:'first-completion',check:'dto'}],
    [10,'Joined browser assertion failed: task 2 final supplied display state; toHaveCount; line=339',{stage:'task 2 final supplied display state',matcher:'toHaveCount',stored_line:339}],
    [11,'Lifecycle failure failed: checkpoint 4 read-only reconcile; kind=Error; check=reconcile-reply; entry=3; capture={}',{stage:'checkpoint 4 read-only reconcile',kind:'Error',check:'reconcile-reply',entry:3}],
    [29,'Reload epoch failed: actual full reload retires the accepted first document; capture={"create":{},"task":{},"latest":[{"body_rejection_class":"method_io_read"}]}; disconnectedView=null',{stage:'actual full reload retires the accepted first document',body_classes:['method_io_read']}],
    [33,'Tool fidelity failed: first reuse privacy; kind=SyntaxError; faults={}; posts={}',{stage:'first reuse privacy',kind:'SyntaxError'}],
  ];
  for(const [i,[sourceID,message,expected]]of controls.entries())await t.test(String(i+1),()=>{
    const q=declaration(sourceID,sourceID===10?joinedScenarios[2]:'synthetic',61,4);
    const error=Object.freeze({...serializeError(new Error(message)),location:Object.freeze({...q.location,line:222,column:8})});
    assert.equal(error.message,'Error: '+message);
    const before=Object.getOwnPropertyDescriptors(error);
    const r=emit([q,q],[result({errors:[error]}),result({errors:[serializeError(new Error('private first')),error]})]);
    const c=decodeReport(report(r),quiet).cases[1];
    assert.deepEqual(c.errors[1].stored,{family:i+1,stage:null,check:null,kind:null,matcher:null,stored_line:null,presentation:null,entry:null,body_classes:null,...expected});
    assert.equal(c.file,sourceFiles[sourceID-1]);assert.deepEqual(c.declaration,[61,4]);
    assert.equal(c.scenario,sourceID===10?joinedScenarios[2]:null);
    assert.deepEqual([c.begin,c.end,c.result,c.errors[1].ordinal],[2,2,2,2]);assert.deepEqual(c.errors[1].location,[222,8]);
    const row=publicSummary(report(r),envelope,quiet).value.case_observations.cases[1];
    assert.deepEqual(row.slice(0,4),[sourceID,61,4,sourceID===10?3:null]);assert.deepEqual(row[9].slice(0,3),[2,2,i+1]);assert.equal(row[7],2);assert.equal(row[9][7],expected.stored_line??null);
    assert.deepEqual(Object.getOwnPropertyDescriptors(error),before);
  });
});
test('C91 installed serializer retains four actual wrapper facts with exact error, result, source and public tag2 associations',async t=>{
  for(const [sourceID,family,message,expected,tuple]of c91Wrappers)await t.test('family '+family,()=>{
    const q=declaration(sourceID,'synthetic',61,4),error=Object.freeze({...serializeError(new Error(message)),location:Object.freeze({...q.location,line:222,column:8})});
    assert.equal(error.message,'Error: '+message);const before=Object.getOwnPropertyDescriptors(error);
    const r=emit([q,q],[result({errors:[error]}),result({errors:[serializeError(new Error('private first')),error]})]);
    const encoded=report(r),c=decodeReport(encoded,quiet).cases[1];
    assert.deepEqual(c.errors[1].stored,{family,stage:null,check:null,kind:null,matcher:null,stored_line:null,presentation:null,entry:null,body_classes:null,...expected});
    assert.deepEqual(encoded.cases[1][11][1][2],tuple);assert.equal(c.file,sourceFiles[sourceID-1]);assert.deepEqual(c.declaration,[61,4]);
    assert.equal(c.status,'failed');assert.equal(c.error_count,2);assert.deepEqual([c.begin,c.end,c.result,c.errors[1].ordinal],[2,2,2,2]);assert.deepEqual(c.errors[1].location,[222,8]);
    const row=publicSummary(encoded,envelope,quiet).value.case_observations.cases[1];
    assert.deepEqual(row.slice(0,4),[sourceID,61,4,null]);assert.equal(row[7],2);assert.deepEqual(row[9],[2,2,...tuple.slice(0,6),null]);
    assert.deepEqual(Object.getOwnPropertyDescriptors(error),before);assert.ok(!JSON.stringify(encoded).includes('private-tail'));
  });
});
test('C91 every new closed stage, check, kind and bounded line survives the actual serializer and codec',async t=>{
  for(const [sourceID,family]of c91Wrappers){
    const f=families[family-1],q=declaration(sourceID);
    for(const [field,values]of [['stage',f.stages],['check',f.checks],['kind',family>=12?kinds:[]]])for(const value of values)await t.test(family+' '+field+' '+value,()=>{
      const stage=field==='stage'?value:f.stages[0],check=field==='check'?value:f.checks[0],kind=field==='kind'?value:'Error';
      const message=family<12?`${f.prefix} stage=${stage}; check=${check}`:`${f.prefix} ${stage}; kind=${kind} line=1; capture=private-tail`;
      const encoded=report(emit([q],[result({errors:[serializeError(new Error(message))]})])),c=decodeReport(encoded,quiet).cases[0];
      assert.equal(c.errors[0].stored[field],value);assert.equal(c.errors[0].stored.family,family);assert.equal(c.errors[0].stored.body_classes,null);
      assert.equal(publicSummary(encoded,envelope,quiet).value.case_observations.cases[0][9][0],2);
    });
    if(family>=12)for(const [line,expected]of [['1',1],['1000000',1_000_000],['1000001',null],['9999999',null],['none',null]])await t.test(family+' line '+line,()=>{
      const message=`${f.prefix} startup; kind=Error line=${line}; capture=not JSON`;
      const c=emit([q],[result({errors:[serializeError(new Error(message))]})]).cases[0];assert.equal(c.errors[0].stored.stored_line,expected);
    });
  }
});
test('C91 strict new wrappers reject malformed envelopes and retain only known partial labels',async t=>{
  for(const [sourceID,family,message]of c91Wrappers)await t.test('family '+family,async t=>{
    const file=sourceFiles[sourceID-1],q=declaration(sourceID),f=families[family-1];
    for(const [i,value]of [null,undefined,42,{},new String(message),'Error: '+message,'private '+message,'\n'+message,message.replace(f.prefix,'Unsupported wrapper:')].entries())await t.test('bare negative '+i,()=>assert.equal(storedObservation(file,value),null));
    assert.equal(storedObservation('unknown source',message),null);assert.equal(storedObservation(sourceFiles[0],message),null);
    for(const [i,value]of [message,'TypeError: '+message,'Error: Error: '+message,' Error: '+message,'Error: private '+message,'Error:\t'+message].entries())await t.test('callback negative '+i,()=>{
      const c=emit([q],[result({errors:[{message:value}]})]).cases[0];assert.equal(c.errors[0].stored,null);assert.equal(c.errors[0].reason,'unsupported_error');
    });
    if(family<12){
      for(const tail of ['; private-tail','\nprivate-tail','\rprivate-tail'])assert.equal(storedObservation(file,message+tail),null);
      const partial=storedObservation(file,`${f.prefix} stage=foreign; check=foreign`);assert.equal(partial.stage,null);assert.equal(partial.check,null);
    }else{
      for(const header of ['startup; kind=Error line=0; capture=','startup; kind=Error line=-1; capture=','startup; kind=Error line=01; capture=','startup; kind=Error line=1.5; capture=','startup; kind=Error line=10000000; capture=','startup; kind=Error line=unknown; capture=','startup; kind=Error line=1; assets=','startup; kind=Error; line=1; capture=','startup\n; kind=Error line=1; capture='])assert.equal(storedObservation(file,f.prefix+' '+header),null);
      const partial=storedObservation(file,`${f.prefix} foreign; kind=foreign line=none; capture=`);assert.equal(partial.stage,null);assert.equal(partial.kind,null);assert.equal(partial.stored_line,null);
      const original=storedObservation(file,message);
      for(const tail of ['{not JSON','{"task":{"body_rejection_class":"target_closed"}}; delay={}; disconnectedView={}','\nError: private\r\n; stage=startup; kind=Error line=1; capture=private']){
        assert.deepEqual(storedObservation(file,message.slice(0,message.indexOf('capture=')+8)+tail),original);
      }
    }
    const text=await fs.readFile(join(ROOT,file),'utf8'),ast=ts.createSourceFile('source.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),cleanup=[];
    function visit(n){if(ts.isNewExpression(n)&&n.expression.getText(ast)==='Error'&&ts.isStringLiteral(n.arguments?.[0]))cleanup.push(n.arguments[0].text);ts.forEachChild(n,visit);}visit(ast);
    assert.ok(cleanup.length>=2);for(const value of cleanup){assert.equal(storedObservation(file,value),null);assert.equal(emit([q],[result({errors:[serializeError(new Error(value))]})]).cases[0].errors[0].stored,null);}
  });
});
test('C91 new private tuples reject old typed maps and malformed dictionaries before public omission',async t=>{
  for(const [sourceID,family,message]of c91Wrappers)await t.test('family '+family,async t=>{
    const encoded=report(emit([declaration(sourceID)],[result({errors:[serializeError(new Error(message))]})]));
    assert.equal(decodeReport(encoded,quiet).cases[0].errors[0].stored.family,family);
    const mutations={oldmap:v=>v.source_map=1,unknownmap:v=>v.source_map=3,schema:v=>v.version=2,unknownfamily:v=>v.cases[0][11][0][2][0]=14,
      source:v=>v.cases[0][0]=3,stage:v=>v.cases[0][11][0][2][1]=999,check:v=>v.cases[0][11][0][2][2]=999,kind:v=>v.cases[0][11][0][2][3]=7,line:v=>v.cases[0][11][0][2][5]=1_000_001};
    for(const [name,mutate]of Object.entries(mutations))await t.test(name,()=>{
      const bad=clone(encoded);mutate(bad);assert.throws(()=>decodeReport(bad,quiet),{code:'schema_unavailable'});
      assert.deepEqual(publicSummary(bad,envelope,quiet,1),{value:null,reason:'schema_unavailable'});
    });
    for(const map of [1,3])assert.throws(()=>decodeReport({version:1,source_map:map,unavailable:9},quiet),{code:'schema_unavailable'});
  });
});
test('C91 new fields collide before passed-case, ninth-error, retained-case and public omission',async t=>{
  for(const [sourceID,family,message,expected]of c91Wrappers)await t.test('family '+family,async t=>{
    const q=declaration(sourceID),error=serializeError(new Error(message)),positive=emit([q],[result({errors:[error]})]),encoded=report(positive);
    assert.equal(positive.cases[0].errors[0].stored.stage,expected.stage);
    const tokens=['stage','kind','family',expected.stage];if(expected.check)tokens.push('check',expected.check);
    for(const token of tokens)await t.test(token,()=>{
      const redact=preparationRedactor({SYNTHETIC_TOKEN:token});assert.throws(()=>decodeReport(encoded,redact),{code:'privacy_collision'});
      assert.deepEqual(publicSummary(encoded,envelope,redact,1),{value:null,reason:'privacy_collision'});
      for(const status of ['passed','skipped']){
        const x=result({status,errors:[error]}),r=new Reporter();r.redact=redact;r.onBegin({projects:[]},{allTests:()=>[q]});r.onTestBegin(q,x);r.onTestEnd(q,x);assert.equal(r.collision,true);
      }
    });
    for(const mode of ['ninth','omitted'])await t.test(mode,()=>{
      const count=mode==='omitted'?257:1,tests=Array.from({length:count},(_,i)=>declaration(sourceID,'synthetic '+i,100+i)),results=tests.map((_,i)=>result({errors:i===count-1?[...Array.from({length:mode==='ninth'?8:0},()=>serializeError(new Error('private first'))),error]:[]}));
      const control=emit(tests,results);assert.equal(control.collision,false);assert.equal(control.omitted[mode==='ninth'?1:0],1);
      const r=new Reporter();r.redact=preparationRedactor({SYNTHETIC_TOKEN:expected.stage});r.onBegin({projects:[]},{allTests:()=>tests});for(let i=0;i<count;i++){r.onTestBegin(tests[i],results[i]);r.onTestEnd(tests[i],results[i]);}assert.equal(r.collision,true);
    });
    if(family>=12){
      const redact=preparationRedactor({SYNTHETIC_TOKEN:'capture-canary'}),privateError=serializeError(new Error(message+'capture-canary'));
      const r=emit([q],[result({errors:[privateError]})]);assert.deepEqual(r.cases[0].errors[0].stored,positive.cases[0].errors[0].stored);
      assert.equal(publicSummary(report(r),envelope,redact).reason,null);assert.ok(!JSON.stringify(report(r)).includes('capture-canary'));
    }
  });
});
test('C91 new-family collisions publish only the map2 rejection marker across filtering and retention',async t=>{
  for(const [sourceID,family,message,expected]of c91Wrappers)for(const mode of ['retained','passed','ninth','omitted'])await t.test(family+' '+mode,async t=>{
    const parent=await temporary(t),output=join(parent,'playwright-output'),count=mode==='omitted'?257:1;
    const tests=Array.from({length:count},(_,i)=>declaration(sourceID,'synthetic '+i,100+i));
    const results=tests.map((_,i)=>result({status:mode==='passed'?'passed':'failed',errors:i===count-1?[...Array.from({length:mode==='ninth'?8:0},()=>serializeError(new Error('private first'))),serializeError(new Error(message))]:[]}));
    const positive=emit([tests.at(-1)],[result({errors:[results.at(-1).errors.at(-1)]})]);assert.equal(positive.cases[0].errors[0].stored.stage,expected.stage);
    const r=new Reporter();r.redact=preparationRedactor({SYNTHETIC_TOKEN:expected.stage});r.onBegin({projects:[{outputDir:output}]},{allTests:()=>tests});
    for(let i=0;i<count;i++){r.onTestBegin(tests[i],results[i]);r.onTestEnd(tests[i],results[i]);}assert.equal(r.collision,true);
    await r.onEnd({status:'failed'});const raw=await fs.readFile(join(output,reportName),'utf8');
    assert.equal(raw,'{"version":1,"source_map":2,"unavailable":9}\n');assert.deepEqual(await fs.readdir(output),[reportName]);
    assert.equal((await fs.lstat(join(output,reportName))).mode&0o7777,0o600);
    assert.throws(()=>decodeReport(JSON.parse(raw),quiet),{code:'privacy_collision'});assert.deepEqual(publicSummary(JSON.parse(raw),envelope,quiet),{value:null,reason:'privacy_collision'});
  });
});
test('C90 callback envelopes reject alternate names, nested prefixes, preludes and malformed inputs',async t=>{
  const bare='Client handoff failed: stage=create; check=dto',canonical=serializeError(new Error(bare)).message;
  assert.equal(storedObservation(sourceFiles[2],bare).stage,'create');
  assert.equal(storedObservation(sourceFiles[2],canonical),null);
  const alternate=new TypeError(bare),renamed=new Error(bare);renamed.name='TimeoutError';
  const controls=[bare,serializeError(alternate).message,serializeError(renamed).message,
    'Error: '+canonical,' '+canonical,'\t'+canonical,'\n'+canonical,'\uFEFF'+canonical,'\u001b[31m'+canonical,
    'private prelude '+canonical,'Error:\t'+bare,'Error:  '+bare,'Error:'+bare,'Error: private prelude '+bare,
    'Error: '+bare+'; private tail','Error: '+bare+'\n'+canonical,new String(canonical),null,undefined,23,{},
    serializeError(new Error('Presentation failed: label=long-selected; stage=final-item; check=fields; kind=Error')).message,
    ...['Rich parity failed: startup','Skill fidelity failed: startup','Stale history failed: startup','Account mismatch failed: startup'].map(message=>serializeError(new Error(message)).message)];
  for(const [i,message]of controls.entries())await t.test(String(i),()=>{
    let reads=0;const q=declaration(),error={get message(){reads++;return message;},location:q.location};
    for(const key of ['name','stack','cause','snippet','value'])Object.defineProperty(error,key,{get(){assert.fail('excluded callback field');}});
    const r=emit([q],[result({errors:[error]})]),e=r.cases[0].errors[0];
    assert.equal(reads,1);assert.equal(e.stored,null);assert.equal(e.reason,'unsupported_error');assert.deepEqual(e.location,[56,3]);
    assert.deepEqual(publicSummary(report(r),envelope,quiet).value.case_observations.cases[0][9],[1,1,56,3]);
  });
  for(const mode of ['missing','throwing'])await t.test(mode,()=>{
    let reads=0;const error={};if(mode==='throwing')Object.defineProperty(error,'message',{get(){reads++;throw Error('synthetic getter');}});
    const e=emit([declaration()],[result({errors:[error]})]).cases[0].errors[0];
    assert.equal(reads,Number(mode==='throwing'));assert.equal(e.stored,null);assert.equal(e.reason,mode==='missing'?'unsupported_error':'malformed_error');
  });
  const q=declaration(),unknown=serializeError(new Error('Client handoff failed: stage=private; check=private'));
  const e=emit([q],[result({errors:[unknown]})]).cases[0].errors[0];
  assert.equal(e.stored.family,5);assert.equal(e.stored.stage,null);assert.equal(e.stored.check,null);
  const wrong=declaration();wrong.location.file='/unknown/source';
  assert.equal(emit([wrong],[result({errors:[serializeError(new Error(bare))]})]).cases[0].errors[0].stored,null);
});
test('C90 original serialized primitive string length is capped before removing its one envelope',async t=>{
  const prefix='Fixed head failed: terminal; kind=TimeoutError; check=bytes; capture=';
  for(const length of [999_999,1_000_000,1_000_001,1_000_007])for(const unicode of [false,true])await t.test(length+' '+unicode,()=>{
    const room=length-7-prefix.length,tail=unicode?'😀'.repeat(Math.floor(room/2))+'x'.repeat(room%2):'x'.repeat(room);
    const original=new Error(prefix+tail);
    // The length guard does not depend on the SDK scanning a million-character stack header.
    original.stack='';const error=serializeError(original);assert.equal(error.message.length,length);
    const e=emit([declaration(24)],[result({errors:[error]})]).cases[0].errors[0];
    if(length<=1_000_000){assert.equal(e.stored.family,3);assert.equal(e.stored.stage,'terminal');assert.equal(e.stored.check,'bytes');assert.equal(e.stored.kind,'TimeoutError');}
    else {assert.equal(e.stored,null);assert.equal(e.reason,'unsupported_error');}
    // The tail stays opaque, and the original bare API retains its own independent cap.
    assert.equal(storedObservation(sourceFiles[23],prefix+tail)?.stage??null,length-7<=1_000_000?'terminal':null);
    assert.ok(!JSON.stringify(e).includes('capture='));
  });
});
test('C90 passed and skipped serializer-backed stored fields collide before public filtering',async t=>{
  for(const status of ['passed','skipped'])await t.test(status,()=>{
    const q=declaration(),x=result({status,errors:[serializeError(new Error('Client handoff failed: stage=create; check=receipt'))]});
    const r=emit([q],[x]),encoded=report(r);assert.equal(r.cases[0].errors[0].stored.check,'receipt');
    assert.deepEqual(publicSummary(encoded,envelope,quiet).value.case_observations.cases,[]);
    assert.deepEqual(publicSummary(encoded,envelope,preparationRedactor({SYNTHETIC_TOKEN:'receipt'})),{value:null,reason:'privacy_collision'});
    const guarded=new Reporter();guarded.redact=preparationRedactor({SYNTHETIC_TOKEN:'receipt'});
    guarded.onBegin({projects:[]},{allTests:()=>[q]});guarded.onTestBegin(q,x);guarded.onTestEnd(q,x);assert.equal(guarded.collision,true);
  });
});
test('C89 reporter counts callbacks, not bodies; synthesized unexecuted callbacks and worker -1 remain explicit',()=>{
  const tests=[declaration(),declaration()],results=[result({status:'skipped',workerIndex:-1,duration:0}),result({status:'interrupted',workerIndex:-1})];
  const r=emit(tests,results);const value=decodeReport(report(r),quiet);
  assert.deepEqual(value.counts,[2,2,2,0,0,0,0,1,1,0]);
  assert.equal(value.cases[0].worker,null);assert.equal(value.cases[0].begin,1);assert.equal(value.cases[0].result,1);
  assert.equal(value.cases[1].status,'interrupted');assert.equal(r.printsToStdio(),false);
});
test('C89 errors array is counted once and the first-error alias and excluded getters are never accessed',()=>{
  const q=declaration(),e={...serializeError(new Error('Client handoff failed: stage=create; check=receipt')),location:{...q.location,line:247,column:15}};
  delete e.stack;delete e.cause;
  let reads=0;const message=e.message;Object.defineProperty(e,'message',{get(){reads++;return reads===1?message:'private later read';}});
  const trap=()=>assert.fail('excluded field read');
  for(const key of ['name','stack','snippet','value','cause'])Object.defineProperty(e,key,{get:trap});
  const x=result({errors:[e,e]});for(const key of ['error','stdout','stderr','attachments','startTime'])Object.defineProperty(x,key,{get:trap});
  for(const key of ['id','annotations','parent','results'])Object.defineProperty(q,key,{get:trap});
  Object.defineProperty(q,'title',{get:trap});const r=emit([q],[x]);
  assert.equal(r.cases[0].error_count,2);assert.deepEqual(r.cases[0].errors.map(e=>e.ordinal),[1,2]);
  assert.deepEqual(r.cases[0].errors[0].location,[247,15]);assert.equal(r.cases[0].errors[0].stored.stage,'create');assert.equal(reads,2);
});
test('C89 unknown titles/sources/statuses, foreign locations and malformed errors never become guessed facts',()=>{
  const q=declaration(10,'private unknown scenario'),x=result({status:'timedout',workerIndex:-1,duration:Infinity,errors:[{message:'private',location:{file:'/unknown/source',line:1,column:1}},null]});
  const r=emit([q],[x]);assert.equal(r.cases[0].scenario,null);assert.equal(r.cases[0].reason,'unknown_scenario');
  assert.equal(r.cases[0].status,null);assert.equal(r.cases[0].duration,null);assert.equal(r.cases[0].errors[0].location,null);
  assert.equal(r.cases[0].errors[1].reason,'malformed_error');
  const unknown=declaration();unknown.location.file='/unknown/source';const rr=emit([unknown],[result({errors:[{location:{file:'/also/unknown',line:1,column:1}}]})]);
  assert.equal(rr.cases[0].file,null);assert.equal(rr.cases[0].errors[0].location,null);assert.equal(rr.cases[0].reason,'unknown_source');
});
test('C89 ordinal identity survives retries, duplicate callbacks and end-without-begin without certifying execution',()=>{
  const q=declaration(),r=new Reporter();r.onBegin({projects:[]},{allTests:()=>[q]});
  const a=result(),b=result();r.onTestBegin(q,a);r.onTestEnd(q,a);r.onTestBegin(q,b);r.onTestEnd(q,b);
  assert.deepEqual(r.cases.map(c=>[c.begin,c.end,c.result]),[[1,1,1],[2,2,2]]);
  r.onTestEnd(q,b);assert.equal(r.incomplete,true);assert.equal(r.cases.length,2);
  const c=result();r.onTestEnd(q,c);assert.equal(r.cases[2].begin,null);assert.equal(r.cases[2].result,3);
  r.onError({message:'private global error'});assert.equal(r.counts[3],1);assert.equal(r.cases.length,3);
});
test('C89 callbacks contain typed-field/getter failures and do not inspect arbitrary API keys',()=>{
  const r=new Reporter();assert.doesNotThrow(()=>r.onBegin({get projects(){throw Error('private');}},{get allTests(){throw Error('private');}}));
  assert.doesNotThrow(()=>r.onTestBegin(null,null));assert.doesNotThrow(()=>r.onTestEnd(null,null));assert.equal(r.incomplete,true);
  const q=declaration(),x=result();Object.defineProperty(x,'errors',{get(){throw Error('private');}});
  const rr=emit([q],[x]);assert.equal(rr.incomplete,true);assert.equal(rr.cases.length,0);
});
test('C89 measurement annotations are string tuples, result-level, source-bound and separate from every error ordinal',()=>{
  const q=declaration(12),r=emit([q],[result({errors:[{message:'private first'},{message:'private second'}],annotations:packet()})]);
  const c=decodeReport(report(r),quiet).cases[0];assert.equal(c.measurement.checkpoint,'first_dom');assert.equal(c.measurement.family,1);
  assert.equal(Object.hasOwn(c.measurement,'ordinal'),false);assert.equal(c.errors.length,2);
  const wrong=emit([declaration(4)],[result({annotations:packet()})]);assert.equal(wrong.cases[0].measurement,null);assert.equal(wrong.cases[0].reason,'malformed_annotation');
});
test('C89 malformed/duplicate/foreign annotations and all extraction/access/append failures are contained',async t=>{
  for(const annotations of [null,[],[{type:'private',get description(){assert.fail('excluded annotation description');}}],
    [{type:annotationType,description:'private'}],[{type:annotationType,description:'[1,1,999,false,false,null]'}],
    [{type:annotationType,description:[1,1,1,false,false,null]}],[...packet(),...packet()]])await t.test('annotation control',()=>{
    const r=emit([declaration(12)],[result({annotations})]);assert.equal(r.cases[0].measurement,null);
  });
  for(const read of [()=>{throw Error('extraction');},()=>({get info(){throw Error('argument');}}),()=>({family:1,get packet(){throw Error('packet');}}),
    ()=>({family:1,packet:{get first_operation(){throw Error('operation');}}}),()=>({family:1,steps:[{get ok(){throw Error('cleanup');}}]}),
    ()=>({family:1,info:{get annotations(){throw Error('info');}}}),()=>({family:1,info:{annotations:{push(){throw Error('append');}}}})])assert.doesNotThrow(()=>appendMeasurementAnnotation(read));
});
test('C89 actual annotation function VM contains encode/stringify failures inside the same original boundary',async()=>{
  const text=await fs.readFile(new URL('../test-support/browser-case-diagnostics.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('module.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='appendMeasurementAnnotation').getText(ast).replace('export ','');
  for(const phase of ['encode','stringify']){
    let appended=false;
    const action=new Function('encodeMeasurement','preparationRedactor','clean','livePhases','contentPhases','cleanupSteps','bool','annotationType','process','JSON','return ('+fn+');')(
      ()=>{if(phase==='encode')throw Error('synthetic encoder');return [1,1,false,false,null];},()=>v=>v,v=>v,livePhases,contentPhases,cleanupSteps,v=>typeof v==='boolean'?v:null,annotationType,{env:{}},
      {stringify(){throw Error('synthetic stringify');}});
    assert.doesNotThrow(()=>action(()=>({family:1,info:{annotations:{push(){appended=true;}}},packet:Object.freeze({first_operation:'first_dom'}),steps:[]})));
    assert.equal(appended,false);
  }
});
test('C89 eight realistic failed callbacks include shared joined coordinates, timedOut, multiple errors and both measurements within terminal 1024',()=>{
  const {encoded}=realistic(),decoded=decodeReport(encoded,quiet),out=publicSummary(encoded,envelope,quiet);assert.equal(out.reason,null);
  assert.equal(decoded.cases[0].errors[0].stored.stored_line,254);assert.equal(decoded.cases[1].errors[0].stored.stored_line,345);
  assert.equal(decoded.cases[7].errors[0].stored.body_classes[0],'get_response_body_no_resource');
  assert.ok(Buffer.byteLength('browser_suite_launch: failure '+JSON.stringify(out.value)+'\n')<=1024);
  const rows=out.value.case_observations.cases;assert.equal(rows.length,8);assert.equal(out.value.case_observations.counts[0],89);
  assert.deepEqual(rows[0].slice(0,3),rows[1].slice(0,3));assert.notEqual(rows[0][3],rows[1][3]);
  for(const row of rows){assert.ok(row[0]>0);assert.ok(row[1]>0);assert.ok(row[2]>0);assert.ok(row[4]>0);assert.ok(row[5]>0);assert.ok(row[6]>0);assert.ok(row[7]>0);assert.ok(row[8]>0);assert.ok(row[9]!==null);}
  assert.equal(rows[2][4],3);assert.equal(rows[3][9][0],3);assert.equal(rows[4][9][0],3);
  assert.equal(out.value.case_observations.omitted[0],0);assert.ok(out.value.case_observations.omitted[1]>=2);
});
test('C89 compact codec checks labels before IDs and omission, including a secondary error beyond private retention',()=>{
  const {encoded}=realistic();
  assert.equal(decodeReport(encoded,quiet).cases[1].errors[0].stored.stage,'task 2 exact authoritative answer and tool output');
  assert.deepEqual(decodeReport(encoded,quiet).cases[7].errors[0].stored.body_classes,['get_response_body_no_resource']);
  for(const text of ['web/e2e/joined.spec.mjs','WS recovered','task 2 exact authoritative answer and tool output','get_response_body_no_resource','timedOut']){
    const redact=preparationRedactor({SYNTHETIC_TOKEN:text});assert.equal(publicSummary(encoded,envelope,redact,400).value,null);
    assert.throws(()=>decodeReport(encoded,redact));
  }
  const r=new Reporter();r.redact=preparationRedactor({SYNTHETIC_TOKEN:'receipt'});
  const q=declaration();r.onBegin({projects:[]},{allTests:()=>[q]});const x=result({errors:Array.from({length:9},(_,i)=>serializeError(new Error('Client handoff failed: stage=create; check='+(i===8?'receipt':'dto'))))});
  assert.equal(emit([q],[result({errors:[x.errors[8]]})]).cases[0].errors[0].stored.check,'receipt');
  r.onTestBegin(q,x);r.onTestEnd(q,x);assert.equal(r.collision,true);assert.equal(r.cases[0].errors.length,8);assert.equal(r.omitted[1],1);
});
test('C89 case retention and duplicate annotation omission still check every known closed label for collision',()=>{
  const tests=Array.from({length:257},(_,i)=>declaration(3,'synthetic '+i,100+i));
  const results=tests.map((_,i)=>result({errors:[serializeError(new Error('Client handoff failed: stage=create; check='+(i===256?'receipt':'dto')))]}));
  assert.equal(emit([tests[256]],[results[256]]).cases[0].errors[0].stored.check,'receipt');
  const r=new Reporter();r.redact=preparationRedactor({SYNTHETIC_TOKEN:'receipt'});r.onBegin({projects:[]},{allTests:()=>tests});
  for(let i=0;i<tests.length;i++){r.onTestBegin(tests[i],results[i]);r.onTestEnd(tests[i],results[i]);}
  assert.equal(r.cases.length,256);assert.equal(r.omitted[0],1);assert.equal(r.collision,true);
  const rr=new Reporter();rr.redact=preparationRedactor({SYNTHETIC_TOKEN:'first_dom'});const q=declaration(12),x=result({annotations:[...packet(),...packet()]});
  rr.onBegin({projects:[]},{allTests:()=>[q]});rr.onTestBegin(q,x);rr.onTestEnd(q,x);assert.equal(rr.collision,true);assert.equal(rr.cases[0].measurement,null);
});
test('C89 byte boundaries 1024/1025/1026 and overflow omit only whole tuples with exact omission facts',()=>{
  const {encoded}=realistic();const base=publicSummary(encoded,envelope,quiet,10000);const rawSize=Buffer.byteLength('browser_suite_launch: failure '+JSON.stringify(base.value)+'\n');
  assert.ok(rawSize<1024);
  for(const target of [1024,1025,1026,4096]){
    const padded={...envelope,scope:envelope.scope+'x'.repeat(target-rawSize)};
    const out=publicSummary(encoded,padded,quiet);if(out.value===null){assert.ok(target>1024);continue;}
    const summary=out.value.case_observations;assert.ok(Buffer.byteLength('browser_suite_launch: failure '+JSON.stringify(out.value)+'\n')<=1024);
    assert.equal(summary.omitted[0],8-summary.cases.length);for(const row of summary.cases)assert.equal(row.length,10);
    if(target===1024)assert.equal(summary.cases.length,8);else assert.ok(summary.cases.length<8);
  }
});
test('C89 private codec rejects unknown enums, malformed tuples, duplicate ordinals, bounds and wrong family/source',async t=>{
  const {encoded}=realistic();
  const mutations=[v=>v.extra=1,v=>v.version=2,v=>v.source_map=1,v=>v.source_map=3,v=>v.run=5,v=>v.completion=3,v=>v.counts[0]=-1,v=>v.counts.push(0),v=>v.omitted[0]=1.5,
    v=>v.cases[0][0]=35,v=>v.cases[0][3]=7,v=>v.cases[0][7]=6,v=>v.cases[0][1]=0,v=>v.cases[0][8]=-1,v=>v.cases[0][9]=Infinity,
    v=>v.cases[0][11][0][0]=2,v=>v.cases[0][11][0][2][1]=999,v=>v.cases[0][11][0][2][0]=1,v=>v.cases[0][5]=1000,
    v=>v.cases[1][5]=v.cases[0][5],v=>v.cases[0][6]=1000,v=>v.cases[3][12][1]=999,v=>v.cases[3][12][2]=0];
  for(const [i,mutate]of mutations.entries())await t.test(String(i),()=>{const v=clone(encoded);mutate(v);assert.throws(()=>decodeReport(v,quiet));});
});
test('C89 F5 actual known error counts retain the complete capped prefix and honest omissions',async t=>{
  for(const n of [0,1,2,8,9])await t.test('known '+n,()=>{
    const errors=Array.from({length:n},()=>serializeError(new Error('Client handoff failed: stage=create; check=dto')));
    const r=emit([declaration()],[result({errors})]),encoded=report(r),decoded=decodeReport(encoded,quiet);
    const retained=Math.min(n,8),overflow=Math.max(n-8,0),c=decoded.cases[0];
    assert.equal(c.error_count,n);assert.equal(c.errors.length,retained);
    assert.deepEqual(c.errors.map(e=>e.ordinal),Array.from({length:retained},(_,i)=>i+1));
    assert.deepEqual(decoded.omitted,[0,overflow]);
    const out=publicSummary(encoded,envelope,quiet);assert.equal(out.reason,null);
    assert.equal(out.value.case_observations.cases[0][8],n);
    assert.deepEqual(out.value.case_observations.omitted,[0,Math.max(n-1,0)]);
    assert.equal(out.value.case_observations.cases[0][9]===null,n===0);
    if(n>0){assert.equal(c.errors[0].stored.stage,'create');assert.equal(c.errors[0].stored.check,'dto');}
  });
});
test('C89 F5 rejects removed errors, fake omissions and short known prefixes before public filtering or byte omission',async t=>{
  const samples=new Map();
  for(const n of [0,1,2,8,9]){
    const errors=Array.from({length:n},()=>serializeError(new Error('Client handoff failed: stage=create; check=dto')));
    samples.set(n,report(emit([declaration()],[result({errors})])));
  }
  const controls=[
    ['removed sole actionable error',1,v=>{v.cases[0][11]=[];}],
    ['removed sole error with fake compensating omission',1,v=>{v.cases[0][11]=[];v.omitted[1]=1;}],
    ['short two-error prefix',2,v=>{v.cases[0][11].pop();}],
    ['short eight-error prefix',8,v=>{v.cases[0][11].pop();}],
    ['short nine-error prefix with compensating omission',9,v=>{v.cases[0][11].pop();v.omitted[1]=2;}],
    ['false omission with known zero',0,v=>{v.omitted[1]=1;}],
    ['false omission with known one',1,v=>{v.omitted[1]=1;}],
    ['ninth error omission understated',9,v=>{v.omitted[1]=0;}],
    ['ninth error omission overstated',9,v=>{v.omitted[1]=2;}],
    ['removed error in publicly filtered passed case',1,v=>{v.cases[0][11]=[];v.cases[0][7]=1;v.counts[4]=1;v.counts[5]=0;}],
    ['incomplete report still requires known prefix',1,v=>{v.cases[0][11]=[];v.completion=2;}],
  ];
  for(const [name,n,mutate] of controls)await t.test(name,()=>{
    const original=clone(samples.get(n));assert.equal(decodeReport(original,quiet).cases[0].error_count,n);
    assert.equal(publicSummary(original,envelope,quiet).reason,null);
    const invalid=clone(original);mutate(invalid);
    assert.throws(()=>decodeReport(invalid,quiet),{code:'schema_unavailable'});
    for(const limit of [1024,1])assert.deepEqual(publicSummary(invalid,envelope,quiet,limit),{value:null,reason:'schema_unavailable'});
    assert.deepEqual(samples.get(n),original);
  });
});
test('C89 F5 unknown counts stay unknown and omitted cases permit only the known retained overflow floor',async t=>{
  for(const mixed of [false,true])await t.test(mixed?'mixed known and unknown':'unknown count',()=>{
    const tests=mixed?[declaration(),declaration()]:[declaration()];
    const results=mixed?[result({errors:Array.from({length:9},()=>serializeError(new Error('Client handoff failed: stage=create; check=dto')))}),result({errors:undefined})]:[result({errors:undefined})];
    const r=emit(tests,results),encoded=report(r);assert.equal(r.incomplete,true);encoded.completion=2;
    const decoded=decodeReport(encoded,quiet),unknown=decoded.cases.at(-1),knownOverflow=Number(mixed);
    assert.equal(unknown.error_count,null);assert.deepEqual(unknown.errors,[]);assert.equal(decoded.completion,'incomplete');
    assert.deepEqual(decoded.omitted,[0,knownOverflow]);
    const out=publicSummary(encoded,envelope,quiet);assert.equal(out.reason,null);
    assert.equal(out.value.case_observations.cases.at(-1)[8],null);assert.equal(out.value.case_observations.cases.at(-1)[9],null);
    assert.deepEqual(out.value.case_observations.omitted,[0,mixed?8:0]);
    // An unavailable count does not justify invented observed omissions or numbered errors.
    for(const omitted of mixed?[0,2]:[1]){
      const invalid=clone(encoded);invalid.omitted[1]=omitted;
      assert.throws(()=>decodeReport(invalid,quiet),{code:'schema_unavailable'});
      assert.deepEqual(publicSummary(invalid,envelope,quiet),{value:null,reason:'schema_unavailable'});
    }
    const numbered=clone(encoded);numbered.cases.at(-1)[11]=[[1,null,null,3]];
    assert.throws(()=>decodeReport(numbered,quiet),{code:'schema_unavailable'});
  });
  for(const tail of [0,2,null])await t.test('omitted case count '+tail,()=>{
    const tests=Array.from({length:257},(_,i)=>declaration(3,'synthetic omitted '+i,100+i,1));
    const results=tests.map((_,i)=>{
      let n=0;if(i===0)n=9;else if(i===256)n=tail;
      return result({status:i===0||i===256?'failed':'passed',errors:n===null?undefined:Array.from({length:n},()=>serializeError(new Error('Client handoff failed: stage=create; check=dto')))});
    });
    const r=emit(tests,results),encoded=report(r);if(tail===null){assert.equal(r.incomplete,true);encoded.completion=2;}
    const decoded=decodeReport(encoded,quiet);assert.equal(decoded.cases.length,256);assert.equal(decoded.cases[0].error_count,9);
    assert.deepEqual(decoded.omitted,[1,1+(tail??0)]);
    const out=publicSummary(encoded,envelope,quiet);assert.equal(out.reason,null);
    assert.deepEqual(out.value.case_observations.omitted,[1,8+(tail??0)]);
    const invalid=clone(encoded);invalid.omitted[1]=0;
    assert.throws(()=>decodeReport(invalid,quiet),{code:'schema_unavailable'});
    for(const limit of [1024,1])assert.deepEqual(publicSummary(invalid,envelope,quiet,limit),{value:null,reason:'schema_unavailable'});
    // The omitted case cannot supply an exact error total or an upper bound.
    for(const omitted of [1,5,1000]){
      const possible=clone(encoded);possible.omitted[1]=omitted;
      assert.deepEqual(decodeReport(possible,quiet).omitted,[1,omitted]);
      assert.deepEqual(publicSummary(possible,envelope,quiet).value.case_observations.omitted,[1,omitted+7]);
    }
  });
});
test('C89 helper collision crosses workers through actual annotations, reporter, writer and public codec',async t=>{
  const module=pathToFileURL(join(ROOT,'web/test-support/browser-case-diagnostics.mjs')).href;
  const code=`import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import Reporter,{appendMeasurementAnnotation,annotationType,sourceFiles,reportName,decodeReport,publicSummary} from ${JSON.stringify(module)};
const [mode,familyText]=process.argv.slice(1),family=Number(familyText),annotations=[];
const environment={...process.env},original=Error('synthetic original'),descriptors=Object.getOwnPropertyDescriptors(original);
const phase=family===1?'first_dom':'partial_dom_poll',packet=Object.freeze({first_operation:phase});
let accesses=0;
const info={get annotations(){accesses++;if(mode==='access-unavailable')throw Error('synthetic access');return annotations;}};
if(mode==='append-unavailable')Object.defineProperty(annotations,'push',{value(){throw Error('synthetic append');}});
try{appendMeasurementAnnotation(()=>{if(mode==='extraction')throw Error('synthetic extraction');return {info,family,packet,body_success:false,cleanup:false,steps:[{name:'root',ok:false}]};});throw original;}catch(e){assert.equal(e,original);}
assert.deepEqual(Object.getOwnPropertyDescriptors(original),descriptors);assert.equal(isDeepStrictEqual({...process.env},environment),true);
const unavailable=['extraction','access-unavailable','append-unavailable','wrapper-unavailable'].includes(mode);
const ordinary=mode==='ordinary';
if(unavailable)assert.equal(annotations.length,0);
else if(ordinary)assert.deepEqual(JSON.parse(annotations[0].description),[1,family,family===1?18:14,false,false,12]);
else assert.deepEqual(annotations,[{type:annotationType,description:'[1,0]'}]);
if(mode==='extraction'||mode==='wrapper-unavailable')assert.equal(accesses,0);else assert.equal(accesses,1);
if(mode==='duplicate-before')annotations.unshift({...annotations[0]});
if(mode==='duplicate-after')annotations.push({...annotations[0]});
if(mode==='malformed-before')annotations.unshift({type:annotationType,description:'not JSON'});
if(mode==='malformed-after')annotations.push({type:annotationType,description:'[1,1,999,false,false,null]'});
if(mode==='getter-before')annotations.unshift({get type(){throw Error('synthetic annotation getter');}});
if(mode==='getter-description-before')annotations.unshift({type:annotationType,get description(){throw Error('synthetic description getter');}});
const parent=await fs.mkdtemp(join(tmpdir(),'wi-case-collision-unit-')),output=join(parent,'playwright-output');
try{
  const count=mode.startsWith('omitted-')?257:1,at=mode==='omitted-first'?0:count-1;
  const tests=Array.from({length:count},(_,i)=>({title:'synthetic',location:{file:sourceFiles[family===1?11:3],line:100+i,column:1}}));
  const r=new Reporter();r.onBegin({projects:[{outputDir:output}]},{allTests:()=>tests});
  for(let i=0;i<count;i++){const x={status:'failed',workerIndex:0,duration:1,errors:[{message:'synthetic',location:{...tests[i].location,line:231,column:5}}],annotations:i===at?annotations:[]};r.onTestBegin(tests[i],x);r.onTestEnd(tests[i],x);}
  assert.equal(r.collision,!ordinary&&!unavailable);
  if(count===257){assert.equal(r.cases.length,256);assert.equal(r.omitted[0],1);}
  assert.equal(await r.onEnd({status:'failed'}),undefined);
  const raw=await fs.readFile(join(output,reportName),'utf8'),encoded=JSON.parse(raw);
  const envelope={version:1,terminal:{code:1,signal:null}};
  if(!ordinary&&!unavailable){
    assert.equal(raw,'{"version":1,"source_map":2,"unavailable":9}\\n');
    assert.throws(()=>decodeReport(encoded),{code:'privacy_collision'});
    for(const limit of [1024,1])assert.deepEqual(publicSummary(encoded,envelope,undefined,limit),{value:null,reason:'privacy_collision'});
  }else{
    const value=decodeReport(encoded);assert.equal(value.cases[0].measurement?.checkpoint??null,ordinary?phase:null);
    assert.equal(value.cases[0].reason,ordinary?null:'missing_annotation');assert.equal(publicSummary(encoded,envelope).reason,null);
  }
  const stat=await fs.lstat(join(output,reportName));assert.equal(stat.mode&0o7777,0o600);assert.equal(stat.nlink,1);
}finally{await fs.rm(parent,{recursive:true});}
await assert.rejects(fs.lstat(parent),{code:'ENOENT'});
`;
  const controls=[['ordinary',1,'synthetic_noncollision'],['ordinary',2,'synthetic_noncollision'],['extraction',1,'synthetic_noncollision'],
    ['value',1,'first_dom'],['key',1,'checkpoint'],['key',2,'checkpoint'],['value',2,'partial_dom_poll'],
    ...['duplicate-before','duplicate-after','malformed-before','malformed-after','getter-before','getter-description-before','omitted-first','omitted-last'].map(mode=>[mode,1,'first_dom']),
    ['access-unavailable',1,'first_dom'],['append-unavailable',1,'first_dom'],['wrapper-unavailable',1,annotationType]];
  for(const [mode,family,token] of controls)await t.test(mode+' family '+family,async()=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,mode,String(family)],{cwd:ROOT,env:{...process.env,SYNTHETIC_TOKEN:token},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    const terminal=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
    assert.deepEqual(terminal,{code:0,signal:null},stderr);assert.equal(stdout,'');assert.equal(stderr,'');
    assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  });
});
test('C89 retained histogram bins agree exactly without omissions and bound all omitted/incomplete statuses',async t=>{
  const statuses=['passed','failed','timedOut','skipped','interrupted',null];
  for(const [index,status] of statuses.entries())for(const mode of ['complete','incomplete','omitted'])await t.test(String(status)+' '+mode,()=>{
    const r=emit([declaration()],[result({status})]),encoded=report(r);
    if(mode==='incomplete'){encoded.completion=2;encoded.counts[0]=2;}
    if(mode==='omitted'){
      encoded.omitted[0]=1;encoded.counts[0]=2;encoded.counts[1]=2;encoded.counts[2]=2;encoded.counts[4+(index+1)%6]++;
    }
    assert.equal(decodeReport(encoded,quiet).cases[0].status,status);
    assert.equal(publicSummary(encoded,envelope,quiet).reason,null);
    const invalid=clone(encoded);invalid.counts[4+index]--;invalid.counts[4+(index+1)%6]++;
    assert.equal(invalid.counts.slice(4).reduce((a,b)=>a+b,0),encoded.counts.slice(4).reduce((a,b)=>a+b,0));
    assert.throws(()=>decodeReport(invalid,quiet),{code:'schema_unavailable'});
    assert.deepEqual(publicSummary(invalid,envelope,quiet,1),{value:null,reason:'schema_unavailable'});
    assert.deepEqual(decodeReport(encoded,quiet).counts,encoded.counts);
  });
  const extra=report(emit([declaration()],[result()]));extra.counts[4]++;
  assert.throws(()=>decodeReport(extra,quiet),{code:'schema_unavailable'});
  // Incomplete transport does not excuse an extra declared bin with no omitted row.
  const incomplete=report(emit([declaration()],[result()]));incomplete.completion=2;incomplete.counts[0]=3;incomplete.counts[2]=2;
  assert.throws(()=>decodeReport(incomplete,quiet),{code:'schema_unavailable'});
});
test('C89 private writer exclusively creates one 0600 regular file behind canonical private parent and awaits completion',async t=>{
  const parent=await temporary(t),output=join(parent,'playwright-output'),{encoded}=realistic();await writeReport(output,encoded);
  const stat=await fs.lstat(join(output,reportName));assert.equal(stat.mode&0o7777,0o600);assert.equal(stat.nlink,1);assert.equal(stat.isFile(),true);
  assert.deepEqual(JSON.parse(await fs.readFile(join(output,reportName),'utf8')),encoded);
  assert.deepEqual(decodeReport(encoded).counts,encoded.counts);
  const before=await fs.readFile(join(output,reportName));
  await assert.rejects(writeReport(output,encoded),{code:'EEXIST'});assert.deepEqual(await fs.readFile(join(output,reportName)),before);
});
test('C89 private writer refuses public parent, symlink output/file, occupied file/hardlink and ambiguous namespace',async t=>{
  const {encoded}=realistic();assert.deepEqual(decodeReport(encoded).counts,encoded.counts);
  const text=await fs.readFile(new URL('../test-support/browser-case-diagnostics.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('writer.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const functions=['directory','writeReport'].map(name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast).replace('export ',''));
  const {constants}=await import('node:fs'),{basename,resolve}=await import('node:path'),{isDeepStrictEqual}=await import('node:util');
  const trace=[];
  const observedFS=Object.fromEntries(['lstat','realpath','mkdir','open'].map(name=>[name,async(...args)=>{trace.push(name);return fs[name](...args);} ]));
  // Observe the real writer guards without changing globals or adding a production seam.
  const observed=new Function('fs','constants','basename','dirname','join','resolve','isDeepStrictEqual','preparationRedactor','collisionRecord','decodeReport','process','reject','reportName',functions.join('\n')+'\nreturn writeReport;')(
    observedFS,constants,basename,dirname,join,resolve,isDeepStrictEqual,preparationRedactor,()=>false,v=>{trace.push('decode');const report=decodeReport(v);trace.push('decoded');return report;},process,()=>{throw Object.assign(Error('policy refusal'),{code:'schema_unavailable'});},reportName);
  const allowed=await temporary(t);await observed(join(allowed,'playwright-output'),encoded);
  assert.deepEqual(JSON.parse(await fs.readFile(join(allowed,'playwright-output',reportName),'utf8')),encoded);assert.ok(trace.includes('open'));
  for(const kind of ['public','symlink-output','symlink-file','existing','hardlink','namespace','noncanonical'])await t.test(kind,async t=>{
    const parent=await temporary(t),output=join(parent,'playwright-output'),target=join(parent,'target');await fs.writeFile(target,'preserved',{mode:0o600});
    let destination=output;
    if(kind==='public')await fs.chmod(parent,0o755);
    if(kind==='namespace')destination=join(parent,'other');
    if(kind==='noncanonical')destination=parent+'/./playwright-output';
    if(kind==='symlink-output')await fs.symlink(parent,output);
    if(['symlink-file','existing','hardlink'].includes(kind)){
      await fs.mkdir(output,{mode:0o755});if(kind==='symlink-file')await fs.symlink(target,join(output,reportName));
      if(kind==='existing')await fs.writeFile(join(output,reportName),'preserved',{mode:0o600});
      if(kind==='hardlink')await fs.link(target,join(output,reportName));
    }
    const occupied=['symlink-file','existing','hardlink'].includes(kind),file=join(output,reportName);
    const before=occupied?await fs.readFile(file):null;
    const error={code:occupied?'EEXIST':'schema_unavailable'};
    await assert.rejects(writeReport(destination,encoded),error);
    trace.length=0;await assert.rejects(observed(destination,encoded),error);
    const validated=['decode','decoded','decode','decoded'];
    const expected={public:[...validated,'lstat','realpath'],
      'symlink-output':[...validated,'lstat','realpath','lstat','lstat'],
      namespace:validated,noncanonical:validated};
    if(occupied){assert.deepEqual(trace.slice(0,4),validated);assert.equal(trace.at(-1),'open');assert.deepEqual(await fs.readFile(file),before);}
    else assert.deepEqual(trace,expected[kind]);
    assert.equal(await fs.readFile(target,'utf8'),'preserved');
  });
});
test('C89 import/list/no-result/ambiguous-root reporter callbacks write nothing and onEnd never overrides status',async t=>{
  const parent=await temporary(t),output=join(parent,'playwright-output'),q=declaration();
  for(const mode of ['list','empty','ambiguous','bad-output','exception']){
    const r=new Reporter();r.onBegin({projects:[{outputDir:output},...(mode==='ambiguous'?[{outputDir:join(parent,'elsewhere')}]:[])]},{allTests:()=>[q]});
    if(['ambiguous','bad-output','exception'].includes(mode)){const x=result();r.onTestBegin(q,x);r.onTestEnd(q,x);}
    if(mode==='bad-output')r.output=join(parent,'other');
    const terminal=mode==='exception'?{get status(){throw Error('synthetic result getter');}}:{status:'failed'};
    assert.equal(await r.onEnd(terminal),undefined);
  }
  assert.deepEqual(await fs.readdir(parent),[]);
});
test('C89 privacy rejection publishes no partial facts and distinguishes collision from missing transport',async t=>{
  const parent=await temporary(t),output=join(parent,'playwright-output'),q=declaration(),x=result({errors:[serializeError(new Error('Client handoff failed: stage=create; check=receipt'))]});
  assert.equal(emit([q],[x]).cases[0].errors[0].stored.check,'receipt');
  const r=new Reporter();r.redact=preparationRedactor({SYNTHETIC_TOKEN:'receipt'});
  r.onBegin({projects:[{outputDir:output}]},{allTests:()=>[q]});r.onTestBegin(q,x);r.onTestEnd(q,x);await r.onEnd({status:'failed'});
  const unavailable=JSON.parse(await fs.readFile(join(output,reportName),'utf8'));
  assert.deepEqual(Object.keys(unavailable).sort(),['source_map','unavailable','version']);
  assert.equal(publicSummary(unavailable,envelope,quiet).reason,'privacy_collision');
  assert.equal(publicSummary({},envelope,quiet).reason,'schema_unavailable');
});
test('C89 reporter publishes complete/incomplete accounting and keeps global errors separate',async t=>{
  const parent=await temporary(t),output=join(parent,'playwright-output'),q=declaration(),x=result();
  const r=new Reporter();r.onBegin({projects:[{outputDir:output}]},{allTests:()=>[q,declaration()]});r.onError({});r.onTestEnd(q,x);
  assert.equal(await r.onEnd({status:'timedout'}),undefined);
  const encoded=JSON.parse(await fs.readFile(join(output,reportName),'utf8')),value=decodeReport(encoded,quiet);
  assert.equal(value.run,'timedout');assert.equal(value.completion,'incomplete');assert.equal(value.counts[3],1);assert.equal(value.cases[0].begin,null);
});
// Hold only this module's real writer, so late callbacks cannot depend on machine scheduling.
async function cutoffWriter(t) {
  const parent=await temporary(t),output=join(parent,'playwright-output');
  const reached=Promise.withResolvers(),release=Promise.withResolvers(),writes=[];
  t.after(()=>release.resolve());
  let held=false,closed=0;
  const facade={...fs,
    async lstat(path){const stat=await fs.lstat(path);if(path===parent&&!held){held=true;reached.resolve();await release.promise;}return stat;},
    async open(...args){const handle=await fs.open(...args);return {
      stat:()=>handle.stat(),writeFile:async(raw,encoding)=>{writes.push(raw);return handle.writeFile(raw,encoding);},
      close:async()=>{await handle.close();closed++;},
    };},
  };
  const url=new URL('../test-support/browser-case-diagnostics.mjs',import.meta.url);
  const text=await fs.readFile(url,'utf8');assert.equal(text.split('import.meta.url').length,2);
  const compiled=ts.transpileModule(text.replace('import.meta.url',JSON.stringify(url.href)),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  const require=createRequire(import.meta.url),module={exports:{}};
  new Function('require','module','exports',compiled)(name=>{
    if(name==='node:fs/promises')return facade;
    if(name==='./browser-fixture-preparation.mjs')return {preparationRedactor,sanitizeRecord};
    if(name==='node:fs')return require('node:fs');
    if(name==='node:path')return require('node:path');
    if(name==='node:url')return require('node:url');
    if(name==='node:util')return require('node:util');
    throw Error('Unsupported synthetic import');
  },module,module.exports);
  return {api:module.exports,parent,output,reached:reached.promise,release:release.resolve,writes,closed:()=>closed};
}
function cutoffCallbacks(api,output,count=2,ended=count-1,errors=[],sourceID=12) {
  const tests=Array.from({length:count},(_,i)=>declaration(sourceID,'synthetic cutoff '+i,100+i,1));
  const results=tests.map(()=>result({errors})),r=new api.default();
  r.onBegin({projects:[{outputDir:output}]},{allTests:()=>tests});
  for(let i=0;i<count;i++){r.onTestBegin(tests[i],results[i]);if(i<ended)r.onTestEnd(tests[i],results[i]);}
  return {r,tests,results};
}
test('C89 F4 encoded tuples own counters, omissions and every nested mutable array',()=>{
  const q=declaration(),r=emit([q],[result({errors:[{...serializeError(new Error('Client handoff failed: stage=create; check=dto')),location:q.location}]})]);
  const encoded=report(r),expected=clone(encoded);
  r.counts[3]++;r.omitted[0]++;r.cases[0].declaration[0]++;r.cases[0].errors[0].location[0]++;
  assert.deepEqual(encoded,expected);assert.equal(publicSummary(encoded,envelope,quiet).reason,null);
  const rr=emit([declaration(30)],[result({errors:[serializeError(new Error('Selection epoch failed: startup; kind=Error line=12; capture={"task":{"body_rejection_class":"timeout"}}; delay={}'))]})]);
  const nested=report(rr),before=clone(nested);rr.cases[0].errors[0].stored.body_classes.push('other');
  assert.deepEqual(nested,before);
});
test('C89 F4 onEnd-entry cutoff fixes all callback accounting across the actual held writer',async t=>{
  for(const mode of ['no-late','late-end','late-error','late-ninth-error','retention','late-collision','late-getters','duplicate-end'])await t.test(mode,async t=>{
    const w=await cutoffWriter(t),capped=mode==='retention'||mode==='late-collision';
    const errors=Array.from({length:9},()=>({message:'synthetic unsupported'}));
    const {r,tests,results}=cutoffCallbacks(w.api,w.output,capped?257:2,capped?256:1,capped?errors:[]);
    const expected=w.api.encodeReport({completion:'incomplete',run:'timedout',counts:r.counts,cases:r.cases,omitted:r.omitted});
    const raw=JSON.stringify(expected)+'\n',state=clone({counts:r.counts,omitted:r.omitted,incomplete:r.incomplete,collision:r.collision});
    let endReads=0;
    const terminal=Object.freeze({status:'timedout'}),pending=r.onEnd(terminal);await w.reached;
    try{
      if(['late-end','late-ninth-error','retention','late-collision'].includes(mode)){
        if(mode==='late-ninth-error')results.at(-1).errors=errors;
        if(mode==='late-collision')results.at(-1).annotations=[{type:annotationType,description:'[1,0]'}];
        r.onTestEnd(tests.at(-1),results.at(-1));
      }
      if(mode==='late-error')r.onError({get message(){assert.fail('late global error getter');}});
      if(mode==='late-getters'){
        const trap=new Proxy({},{get(){assert.fail('excluded late callback getter');}});
        r.onBegin(trap,trap);r.onTestBegin(trap,trap);r.onTestEnd(trap,trap);r.onError(trap);
      }
      if(mode==='duplicate-end')assert.equal(await r.onEnd({get status(){endReads++;return 'failed';}}),undefined);
    }finally{w.release();await pending;}
    if(mode==='duplicate-end')assert.equal(await r.onEnd({get status(){endReads++;return 'failed';}}),undefined);
    const persisted=await fs.readFile(join(w.output,reportName),'utf8');assert.equal(persisted,raw);assert.deepEqual(w.writes,[raw]);assert.equal(w.closed(),1);
    assert.equal(endReads,0);
    assert.deepEqual({counts:r.counts,omitted:r.omitted,incomplete:r.incomplete,collision:r.collision},state);
    assert.deepEqual(terminal,{status:'timedout'});
    const decoded=w.api.decodeReport(JSON.parse(persisted));assert.equal(decoded.completion,'incomplete');assert.equal(decoded.run,'timedout');
    assert.equal(decoded.counts[2],capped?256:1);assert.deepEqual(decoded.omitted,capped?[0,256]:[0,0]);
    const summary=w.api.publicSummary(JSON.parse(persisted),envelope);assert.equal(summary.reason,null);assert.deepEqual(summary.value.terminal,envelope.terminal);
    const s=await fs.lstat(join(w.output,reportName));assert.equal(s.mode&0o7777,0o600);assert.equal(s.nlink,1);
  });
});
test('C89 F4 writer writes the exact bytes validated before its first filesystem await',async t=>{
  const w=await cutoffWriter(t),{encoded}=realistic(),raw=JSON.stringify(encoded)+'\n';
  const pending=w.api.writeReport(w.output,encoded);await w.reached;
  try{encoded.counts[3]++;encoded.omitted[1]++;encoded.cases[0][11][0][1][0]++;}finally{w.release();await pending;}
  const persisted=await fs.readFile(join(w.output,reportName),'utf8');assert.equal(persisted,raw);assert.deepEqual(w.writes,[raw]);
  assert.equal(w.api.decodeReport(JSON.parse(persisted)).counts[3],0);assert.equal(w.api.publicSummary(JSON.parse(persisted),envelope).reason,null);
});
test('C89 F4 before-cutoff collisions reject all facts including an omitted case or ninth error',async t=>{
  for(const mode of ['retained','omitted-case','ninth-error'])await t.test(mode,async t=>{
    const w=await cutoffWriter(t),count=mode==='omitted-case'?257:1;
    const {r,tests,results}=cutoffCallbacks(w.api,w.output,count,count-1,[],mode==='ninth-error'?3:12);
    if(mode==='ninth-error'){
      r.redact=preparationRedactor({SYNTHETIC_TOKEN:'receipt'});
      results.at(-1).errors=Array.from({length:9},(_,i)=>serializeError(new Error('Client handoff failed: stage=create; check='+(i===8?'receipt':'dto'))));
      assert.equal(emit([tests.at(-1)],[result({errors:[results.at(-1).errors[8]]})]).cases[0].errors[0].stored.check,'receipt');
    }else results.at(-1).annotations=[{type:annotationType,description:'[1,0]'}];
    r.onTestEnd(tests.at(-1),results.at(-1));assert.equal(r.collision,true);
    const pending=r.onEnd({get status(){assert.fail('collision must not inspect terminal status');}});await w.reached;
    w.release();assert.equal(await pending,undefined);
    const raw=await fs.readFile(join(w.output,reportName),'utf8');assert.equal(raw,'{"version":1,"source_map":2,"unavailable":9}\n');assert.deepEqual(w.writes,[raw]);
    assert.throws(()=>w.api.decodeReport(JSON.parse(raw)),{code:'privacy_collision'});
    assert.deepEqual(w.api.publicSummary(JSON.parse(raw),envelope),{value:null,reason:'privacy_collision'});
  });
});
test('C89 F4 installed TaskRunner expired cleanup can finish after the diagnostic cutoff without reopening it',async t=>{
  const require=createRequire(import.meta.url),{TaskRunner}=require('../node_modules/playwright/lib/runner/taskRunner.js');
  const {monotonicTime}=require('playwright-core/lib/utils');
  assert.equal(JSON.parse(await fs.readFile(new URL('../node_modules/playwright/package.json',import.meta.url),'utf8')).version,'1.58.2');
  const w=await cutoffWriter(t),{r,tests,results}=cutoffCallbacks(w.api,w.output);
  const setup=Promise.withResolvers(),teardown=Promise.withResolvers(),setupDone=Promise.withResolvers(),teardownDone=Promise.withResolvers();
  t.after(()=>{setup.resolve();teardown.resolve();});
  let setupStarted=false,teardownStarted=false;
  const runner=new TaskRunner(r,1);
  runner.addTask({title:'synthetic cutoff',async setup(){setupStarted=true;await setup.promise;r.onTestEnd(tests[1],results[1]);setupDone.resolve();},async teardown(){teardownStarted=true;await teardown.promise;teardownDone.resolve();}});
  // An already-expired deadline makes the race deterministic without a timer or worker.
  const status=await runner.run({},monotonicTime()-1);
  assert.equal(status,'timedout');assert.equal(setupStarted,true);assert.equal(teardownStarted,true);assert.equal(r.counts[3],2);
  const expected=JSON.stringify(w.api.encodeReport({completion:'incomplete',run:status,counts:r.counts,cases:r.cases,omitted:r.omitted}))+'\n';
  const pending=r.onEnd({status});await w.reached;
  try{setup.resolve();teardown.resolve();await Promise.all([setupDone.promise,teardownDone.promise]);}finally{setup.resolve();teardown.resolve();w.release();await pending;}
  const raw=await fs.readFile(join(w.output,reportName),'utf8');assert.equal(raw,expected);
  assert.equal(w.api.decodeReport(JSON.parse(raw)).counts[2],1);assert.equal(w.api.publicSummary(JSON.parse(raw),envelope).reason,null);assert.equal(status,'timedout');
});
test('C89 installed pinned Playwright Node-only smoke delivers actual callbacks, annotations, test timedOut/run timedout and awaited report',async t=>{
  const parent=await temporary(t),fixture=join(parent,'fixture'),output=join(parent,'playwright-output');await fs.mkdir(fixture,{mode:0o700});
  const reporter=fileURLToPath(new URL('../test-support/browser-case-diagnostics.mjs',import.meta.url));
  const pw=fileURLToPath(new URL('../node_modules/@playwright/test/index.mjs',import.meta.url));
  const cli=fileURLToPath(new URL('../node_modules/@playwright/test/cli.js',import.meta.url));
  assert.equal(JSON.parse(await fs.readFile(new URL('../node_modules/@playwright/test/package.json',import.meta.url),'utf8')).version,'1.58.2');
  const code=`import {test,expect} from ${JSON.stringify(pathToFileURL(pw).href)};
import {compileFunction} from 'node:vm';
import {appendMeasurementAnnotation} from ${JSON.stringify(pathToFileURL(reporter).href)};
compileFunction(\`test('synthetic strict',async()=>{test.fail();throw new Error('Client handoff failed: stage=create; check=receipt');});\`,['test'],{filename:${JSON.stringify(join(ROOT,sourceFiles[2]))},lineOffset:20})(test);
compileFunction(\`test('synthetic capture',async()=>{test.fail();throw new Error('Selection epoch failed: startup; kind=ProtocolError line=268; capture={"task":{"body_rejection_class":"target_closed"}}; delay={}');});\`,['test'],{filename:${JSON.stringify(join(ROOT,sourceFiles[29]))},lineOffset:30})(test);
${c91Wrappers.map(([sourceID,family,message])=>`compileFunction(${JSON.stringify(`test('synthetic family ${family}',async()=>{test.fail();throw new Error(${JSON.stringify(message)});});`)},['test'],{filename:${JSON.stringify(join(ROOT,sourceFiles[sourceID-1]))},lineOffset:40})(test);`).join('\n')}
compileFunction(\`test('synthetic live',async({},info)=>{append(()=>({info,family:1,packet:Object.freeze({first_operation:'first_dom'}),body_success:false,cleanup:false,steps:[]}));expect.soft(1).toBe(2);expect(3).toBe(4);});\`,['test','expect','append'],{filename:${JSON.stringify(join(ROOT,sourceFiles[11]))},lineOffset:10})(test,expect,appendMeasurementAnnotation);
test('synthetic local timeout',async()=>{test.setTimeout(1000);await new Promise(()=>{});});
test('synthetic global timeout',async()=>{test.setTimeout(20000);await new Promise(()=>{});});
test('synthetic unexecuted',async()=>{});
`;
  await fs.writeFile(join(fixture,'b-smoke.spec.mjs'),code,{mode:0o600});
  await fs.writeFile(join(fixture,'a-skipped.spec.mjs'),`import {test} from ${JSON.stringify(pathToFileURL(pw).href)};test.skip('synthetic declared skip',async()=>{});`,{mode:0o600});
  const config=join(parent,'playwright.config.mjs');await fs.writeFile(config,'export default '+JSON.stringify({testDir:fixture,outputDir:output,reporter:[[reporter]],workers:1,retries:0,timeout:20000,globalTimeout:10000})+';\n',{mode:0o600});
  const child=spawn(process.execPath,['--',cli,'test','--config',config],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  const terminal=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));assert.deepEqual(terminal,{code:1,signal:null});
  const encoded=JSON.parse(await fs.readFile(join(output,reportName),'utf8'));
  t.diagnostic(JSON.stringify({synthetic_transport:true,completion:encoded.completion,counts:encoded.counts,omitted:encoded.omitted,statuses:encoded.cases.map(c=>c[7])}));
  const value=decodeReport(encoded,quiet);
  assert.equal(value.run,'timedout');assert.equal(value.counts[0],11);assert.ok(value.counts[2]>=9&&value.counts[2]<=11);
  t.diagnostic(JSON.stringify({synthetic_node_only:true,run:value.run,completion:value.completion,counts:value.counts,statuses:value.cases.map(c=>c.status),workers:value.cases.map(c=>c.worker)}));
  assert.ok(value.cases.some(c=>c.status==='timedOut'));assert.ok(value.cases.some(c=>c.worker===null&&c.status==='skipped'));
  const measured=value.cases.find(c=>c.file===sourceFiles[11]);assert.equal(measured.measurement.checkpoint,'first_dom');assert.equal(measured.error_count,2);
  assert.equal(measured.errors.length,2);assert.ok(stdout.length<4096);assert.ok(stderr.length<4096);
  const summary=publicSummary(encoded,envelope,quiet);assert.equal(summary.reason,null);
  for(const [sourceID,expected,tuple]of [
    [3,{family:5,stage:'create',check:'receipt',kind:null,matcher:null,stored_line:null,presentation:null,entry:null,body_classes:null},[2,1,5,2,2,null,null,null,null]],
    [30,{family:4,stage:'startup',check:null,kind:'ProtocolError',matcher:null,stored_line:268,presentation:null,entry:null,body_classes:['target_closed']},[2,1,4,1,null,5,null,268,2]],
    ...c91Wrappers.map(([sourceID,family,,expected,tuple])=>[sourceID,{family,stage:null,check:null,kind:null,matcher:null,stored_line:null,presentation:null,entry:null,body_classes:null,...expected},[2,1,...tuple.slice(0,6),null]]),
  ]){
    const c=value.cases.find(c=>c.file===sourceFiles[sourceID-1]);assert.ok(c);assert.equal(c.status,'failed');
    assert.deepEqual(c.errors[0].stored,expected);assert.equal(c.error_count,1);assert.equal(c.errors[0].ordinal,1);assert.equal(c.result,1);
    assert.ok(c.worker!==null);assert.ok(c.declaration.every(n=>n>0));assert.ok(c.errors[0].location.every(n=>n>0));
    const row=summary.value.case_observations.cases.find(row=>row[0]===sourceID);
    assert.deepEqual(row.slice(1,3),c.declaration);assert.equal(row[5],c.begin);assert.equal(row[6],c.end);assert.equal(row[7],c.result);assert.deepEqual(row[9],tuple);
  }
  const measuredRow=summary.value.case_observations.cases.find(row=>row[0]===12);
  assert.equal(measuredRow[8],2);assert.deepEqual(measuredRow[9],[3,1,18,false,false,null]);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  assert.equal((await fs.lstat(join(output,reportName))).mode&0o7777,0o600);
});
