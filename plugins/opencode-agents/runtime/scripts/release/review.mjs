// Apply an explicit parent-authored review. Never infer acceptance from text markers.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { rpcRequest } from '../../dist/rpc.js';
const args=process.argv.slice(2),opt=name=>args[args.indexOf(name)+1];
assert(args.includes('--case-dir')&&args.includes('--decision'),'Supply --case-dir and --decision');
const dir=resolve(opt('--case-dir'));
let source=dir; const seen=new Set();
while(existsSync(join(source,'continuation.json'))){assert(!seen.has(source),'Continuation cycle');seen.add(source);source=resolve(JSON.parse(readFileSync(join(source,'continuation.json'))).source_case);}
const state=join(source,'state');
const prior=JSON.parse(readFileSync(join(dir,'final.json'))),decision=JSON.parse(readFileSync(resolve(opt('--decision'))));
const metrics=JSON.parse(readFileSync(join(dir,'metrics.json')));
assert(decision.review && typeof decision.review_started_at==='string' && Number.isSafeInteger(decision.context_bytes), 'Explicit review and measurement required');
const env={...process.env,OPENCODE_AGENTS_STATE_DIR:state,OPENCODE_AGENTS_CONFIG:join(state,'config.json')};
const client=new Client({name:'release-parent-review',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../dist/cli.js',import.meta.url)),'mcp'],cwd:dir,env,stderr:'pipe'});
try{
 await client.connect(transport);
 const current=await client.callTool({name:'opencode_get_task',arguments:{scope_id:prior.scopeId,task_id:prior.taskId,execution_id:prior.executionId}});
 assert(!current.isError); const task=current.structuredContent;
 assert.equal(task.finalManifestHash,prior.finalManifestHash);
 const reviewed=await client.callTool({name:'opencode_record_review',arguments:{scope_id:prior.scopeId,task_id:prior.taskId,
   execution_id:prior.executionId,expected_revision:task.revision,idempotency_key:decision.idempotency_key,review:decision.review}});
 assert(!reviewed.isError,JSON.stringify(reviewed));
 metrics.parent_review=reviewed.structuredContent.reviewStatus;
 metrics.parent_review_started_at=decision.review_started_at;
 metrics.parent_review_elapsed_ms=Date.now()-Date.parse(decision.review_started_at);
 metrics.parent_context_bytes=decision.context_bytes;
 metrics.status=decision.gate_status; // Parent's explicit gate verdict, distinct from deliverable disposition.
 writeFileSync(join(dir,'review.json'),JSON.stringify({decision,result:reviewed.structuredContent},null,2));
 writeFileSync(join(dir,'metrics.json'),JSON.stringify(metrics,null,2));
 console.log(JSON.stringify({case:dir,review:metrics.parent_review,gate:metrics.status}));
}finally{await client.close();await rpcRequest(state,'daemon_stop',{});}
