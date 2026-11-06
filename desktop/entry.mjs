// Set application-owned paths before importing the native DSH main process.
import {app} from 'electron';
import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
const base=resolve(process.env.SHIWEN_ROOT_DIR??join(process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'shiwen-dsh'));
const userData=join(base,'desktop'),library=join(base,'library');
mkdirSync(userData,{recursive:true,mode:0o700});mkdirSync(library,{recursive:true,mode:0o700});
app.setPath('userData',userData);
process.env.SHIWEN_DESKTOP='1';
process.env.DSH_HOME=join(base,'dsh');
process.env.SHIWEN_DATA_DIR=library;
process.env.SHIWEN_ICON_PATH=join(process.resourcesPath,'shiwen/assets/shiwen-icon-rounded.png');
await import('../lib/main.js');
