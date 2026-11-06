import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const electron=join(root,'.runtime/electron-44.7.0/electron');
if(!existsSync(electron))throw Error('Electron runtime missing; see docs/development.md');
// Preparation never touches a running service snapshot or the user's profile.
if(!existsSync(join(root,'.runtime/server/current.json')))await new Promise((yes,no)=>{
 const child=spawn(process.execPath,[join(root,'scripts/prepare-server.mjs')],{cwd:root,stdio:'inherit'});child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Server preparation failed')));
});
const env={...process.env,SHIWEN_NODE_EXECUTABLE:process.execPath};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[join(root,'desktop')],{cwd:root,env,stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
