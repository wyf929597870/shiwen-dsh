import {inspectLegacy,migrateLegacy} from '../plugins/library/src/migrate.mjs';
const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);if(index<0||!args[index+1]||args[index+1].startsWith('--'))throw new Error(`需要 ${name}`);return args[index+1];}
try{
 const source=option('--source');
 const result=args.includes('--apply')?await migrateLegacy({source,target:option('--target')}):inspectLegacy(source);
 console.log(JSON.stringify({mode:args.includes('--apply')?'migrated':'preview',...result},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
