import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
const root=resolve(import.meta.dirname,'..');
if(process.platform!=='linux')throw new Error('This development launcher supports Linux only.');
const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('`','\\`').replaceAll('$','\\$').replaceAll('%','%%')+'"';
const directory=join(process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'applications');
const destination=join(directory,'shiwen-dsh-dev.desktop');
const marker='X-Shiwen-Development-Launcher=true';
let previous;try{previous=await readFile(destination,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
if(previous&&!previous.includes(marker))throw new Error('Existing desktop entry is not owned by this launcher.');
const content=`[Desktop Entry]\nType=Application\nName=Shiwen (Development)\nName[zh_CN]=拾文（开发版）\nComment=Personal agent workbench\nExec=${quote(process.execPath)} ${quote(join(root,'scripts/start-native.mjs'))}\nIcon=${join(root,'assets/shiwen-icon-rounded.png')}\nTerminal=false\nCategories=Office;\nStartupWMClass=shiwen-dsh-dev\nStartupNotify=true\n${marker}\n`;
await mkdir(directory,{recursive:true});await writeFile(destination,content,{mode:0o644});
console.log(destination);
