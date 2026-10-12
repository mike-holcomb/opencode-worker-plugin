import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { rpcRequest } from '../../dist/rpc.js';
const args=process.argv.slice(2),opt=name=>args[args.indexOf(name)+1];
assert(args.includes('--plugin-dir')&&args.includes('--out'));
const plugin=resolve(opt('--plugin-dir')),out=resolve(opt('--out'));mkdirSync(out);
const inventory={};
function walk(dir){for(const name of readdirSync(dir).sort()){const p=join(dir,name),s=statSync(p);
 if(s.isDirectory()){walk(p);chmodSync(p,0o555);}else{inventory[p]=createHash('sha256').update(readFileSync(p)).digest('hex');chmodSync(p,0o444);}}}
walk(plugin);chmodSync(plugin,0o555);
const state=join(out,'state'),client=new Client({name:'tagged-install-smoke',version:'1'});
const wiring=JSON.parse(readFileSync(join(plugin,'.mcp.json'))).mcpServers.opencode_agents;
const env={...process.env,OPENCODE_AGENTS_STATE_DIR:state,OPENCODE_AGENTS_CONFIG:join(state,'config.json')};
const transport=new StdioClientTransport({command:process.execPath,args:wiring.args,cwd:resolve(plugin,wiring.cwd),env,stderr:'pipe'});
try{
 await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,10);
 const health=await client.callTool({name:'opencode_health',arguments:{}});assert(!health.isError);
 for(const [p,digest]of Object.entries(inventory))assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'),digest);
 writeFileSync(join(out,'result.json'),JSON.stringify({status:'passed',node:process.version,platform:process.platform,
  plugin,tools:tools.tools.map(t=>t.name),health:health.structuredContent,bundle_unchanged:true,state_outside_bundle:true,
  executable_sha256:inventory[join(plugin,'bin/opencode-agents.mjs')],file_count:Object.keys(inventory).length},null,2));
 console.log('installed MCP smoke passed');
}finally{await client.close();await rpcRequest(state,'daemon_stop',{});}
