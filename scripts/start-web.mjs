import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {preparePlugin} from './package-plugin.mjs';
import {setupWebProfile} from './web-profile.mjs';
const root=resolve(import.meta.dirname,'..');
const argv=process.argv.slice(2);
if(argv.includes('--help')){
 console.log('npm run start:web -- [--no-theme] [--no-persona] [DSH Web flags]\nUses the dedicated shiwen-web profile; DSH_HOME chooses its home.\n--no-theme/--no-persona set initial profile defaults only. Existing preferences are preserved.\nDSH Web flags include --port <number>, --host <IP>, --no-open. Default: loopback, port 3080.');
}else{
 const home=resolve(process.env.DSH_HOME??join(homedir(),'.dsh'));
 const bundle=await preparePlugin();
 const profile=await setupWebProfile({home,bundle,theme:!argv.includes('--no-theme'),persona:!argv.includes('--no-persona')});
 const args=argv.filter(value=>!['--no-theme','--no-persona'].includes(value));
 const env={...process.env,DSH_HOME:home};
 // This launcher is the stock Node/Web host, independent of desktop runtime flags.
 for(const key of ['ELECTRON_RUN_AS_NODE','SHIWEN_DESKTOP','SHIWEN_APP_PATCH'])delete env[key];
 console.log('Shiwen Web profile:',profile);
 const child=spawn(process.execPath,[join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','shiwen-web',...args],{cwd:root,env,stdio:'inherit'});
 child.on('error',error=>{console.error(error.message);process.exitCode=1;});
 child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}
