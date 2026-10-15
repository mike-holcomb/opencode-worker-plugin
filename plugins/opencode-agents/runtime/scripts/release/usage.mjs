// Read-only, exact-turn usage evidence from the isolated OpenCode 1.19.0 database.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync,readdirSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
const root=resolve(process.argv[2]);
for(const name of readdirSync(root)){
 const dir=join(root,name);if(!existsSync(join(dir,'final.json'))||!existsSync(join(dir,'metrics.json')))continue;
 const final=JSON.parse(readFileSync(join(dir,'final.json'))),metrics=JSON.parse(readFileSync(join(dir,'metrics.json')));
 let location=dir; const seen=new Set();
 while(existsSync(join(location,'continuation.json'))){assert(!seen.has(location),'Continuation cycle');seen.add(location);location=resolve(JSON.parse(readFileSync(join(location,'continuation.json'))).source_case);}
 const file=join(location,'xdg-data/opencode/opencode.db');if(!existsSync(file))continue;
 const db=new DatabaseSync(file,{readOnly:true});
 const predecessorFile=join(dir,'predecessor.json');
 const predecessor=existsSync(predecessorFile)?JSON.parse(readFileSync(predecessorFile)):null;
 const turns=[final,...(predecessor&&predecessor.executionId!==final.executionId?[predecessor]:[])];
 for(const turn of turns){
 const prefix=turn.executionId===final.executionId?'':'predecessor-';
 const messages=db.prepare('SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id').all(turn.sessionId)
  .map(r=>({id:r.id,...JSON.parse(r.data)})).filter(m=>m.role==='assistant'&&m.parentID===turn.userMessageId)
  .map(m=>({id:m.id,parent_id:m.parentID,finish:m.finish??null,tokens:m.tokens??null,raw_cost:m.cost??null}));
 const sum=key=>messages.length&&messages.every(m=>Number.isFinite(m.tokens?.[key]))&&messages.some(m=>(m.tokens?.total??0)>0)?messages.reduce((n,m)=>n+m.tokens[key],0):null;
 const usage={source:'opencode_1.19.0_exact_assistant_messages',execution_id:turn.executionId,session_id:turn.sessionId,user_message_id:turn.userMessageId,
  input_tokens:sum('input'),output_tokens:sum('output'),total_tokens:sum('total'),assistant_messages:messages.length,
  reported_cost:null,cost_note:'Raw OpenCode cost may use configured defaults; no verified billing measurement is available.',messages};
 writeFileSync(join(dir,prefix+'observed-usage.json'),JSON.stringify(usage,null,2));
 metrics[prefix?'predecessor_observed_inference':'observed_inference']={...usage,messages:undefined};writeFileSync(join(dir,'metrics.json'),JSON.stringify(metrics,null,2));
 console.log(JSON.stringify({case:prefix+name,input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}));
 }
 db.close();
}
