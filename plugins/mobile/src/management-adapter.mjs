import {randomUUID} from 'node:crypto';

const ACTIONS = Object.freeze({
  capabilities: 'read',
  'plugins.listBundles': 'read',
  'plugins.listPlugins': 'read',
  'plugins.marketIndexes': 'read',
  'plugins.marketSearch': 'read',
  'plugins.install': 'write',
  'plugins.installProgress': 'read',
  'plugins.cancelInstall': 'write',
  'plugins.enableBundle': 'write',
  'plugins.enablePlugin': 'write',
  'plugins.removeBundle': 'write',
  'plugins.versions': 'read',
  'plugins.readDetail': 'read',
  'plugins.update': 'write',
  'settings.describe': 'read',
  'settings.mutate': 'write',
  'settings.secretSet': 'write',
  'schedules.list': 'read',
  'schedules.catalog': 'read',
  'schedules.view': 'read',
  'schedules.history': 'read',
  'schedules.create': 'write',
  'schedules.edit': 'write',
  'schedules.run': 'write',
  'schedules.deleteInactive': 'write',
});

const optional = (ctx, name) => {
  try { return ctx.get(name); } catch { return undefined; }
};
const invalid = message => Object.assign(new Error(message), {code:'INVALID_REQUEST'});
const unavailable = service => Object.assign(new Error(`${service} service is unavailable`), {code:'MANAGEMENT_UNAVAILABLE'});
const requireObject = (value, label='args') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value;
};
const requireString = (value, field, max=512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${field} is required`);
  return value;
};
// Check every union branch and dynamic array/dict entry, including slots that
// are absent from the current value and therefore absent from secrets[].
function touchesSecret(schema,path){
  if(!schema||typeof schema!=='object')return false;
  if(schema.meta?.role==='secret')return true;
  if(!path.length)return Object.values(schema.dict??{}).some(child=>touchesSecret(child,[]))||touchesSecret(schema.inner,[])||(schema.list??[]).some(child=>touchesSecret(child,[]));
  if(schema.type==='object')return touchesSecret(schema.dict?.[path[0]],path.slice(1));
  if(schema.type==='array'||schema.type==='dict')return touchesSecret(schema.inner,path.slice(1));
  if(schema.inner)return touchesSecret(schema.inner,path);
  return (schema.list??[]).some(child=>touchesSecret(child,path));
}
const installSummary = result => {
  if (!result || typeof result !== 'object') return result;
  const keys=['changed','application','restartReason','stage','target','enabled','error','warnings','bundle','version','pendingBuilds','approvedBuilds','registries','failedAt','from','to','step'];
  if(result.result)return {...Object.fromEntries(keys.filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]])),result:installSummary(result.result),...(result.restore?{restore:installSummary(result.restore)}:{})};
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]]));
};

/**
 * DSH 0.2.2-alpha.3 Host service adapter. The adapter intentionally uses the Host
 * service objects directly; it never starts another DSH process or invokes a model.
 */
export function createManagementAdapter(ctx) {
  const installRuns = new Map();

  const serviceFor = action => action.startsWith('plugins.')
    ? optional(ctx, action.startsWith('plugins.market') ? 'pluginMarket' : 'pluginManager')
    : action.startsWith('schedules.') ? optional(ctx, 'schedule') : action.startsWith('settings.') ? optional(ctx,'settings') : true;

  const capabilities = () => {
    const supportedActions = Object.keys(ACTIONS).filter(action => action === 'capabilities' || Boolean(serviceFor(action)));
    const unavailableServices = [];
    if (!optional(ctx,'pluginManager')) unavailableServices.push({service:'pluginManager', actions:Object.keys(ACTIONS).filter(a=>a.startsWith('plugins.')&&!a.startsWith('plugins.market'))});
    if (!optional(ctx,'pluginMarket')) unavailableServices.push({service:'pluginMarket', actions:Object.keys(ACTIONS).filter(a=>a.startsWith('plugins.market'))});
    if (!optional(ctx,'schedule')) unavailableServices.push({service:'schedule', actions:Object.keys(ACTIONS).filter(a=>a.startsWith('schedules.'))});
    if (!optional(ctx,'settings')) unavailableServices.push({service:'settings', actions:Object.keys(ACTIONS).filter(a=>a.startsWith('settings.'))});
    return {supportedActions, unavailableServices};
  };

  const execute = async (action, rawArgs={}, signal) => {
    if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) throw invalid('Unsupported management action');
    const args = requireObject(rawArgs);
    if (action === 'capabilities') return {action, data:capabilities()};
    if (!serviceFor(action)) throw unavailable(action.startsWith('plugins.market')?'pluginMarket':action.startsWith('plugins.')?'pluginManager':'schedule');
    const pluginManager=optional(ctx,'pluginManager');
    const pluginMarket=optional(ctx,'pluginMarket');
    const schedule=optional(ctx,'schedule');
    let data;
    switch (action) {
      case 'plugins.listBundles': data = await pluginManager.listBundles(); break;
      case 'plugins.listPlugins': data = await pluginManager.listPlugins(); break;
      case 'plugins.versions': data=await pluginManager.listVersions(requireString(args.name,'name',256),{},signal);break;
      case 'plugins.readDetail': data=await pluginManager.readBundleDetail(requireString(args.name,'name',256),requireString(args.language??'zh-CN','language',40));break;
      case 'plugins.update': {
        const name=requireString(args.name,'name',256),version=requireString(args.version,'version',128),installId=requireString(args.installId,'installId',128);
        const fingerprint=JSON.stringify({action,name,version}),old=installRuns.get(installId);
        if(old){if(old.fingerprint!==fingerprint)throw Object.assign(new Error('installId is already bound to another request'),{code:'CONFLICT'});data={installId,status:old.status};break;}
        const terminal=[...installRuns.values()].filter(item=>item.status!=='running').sort((a,b)=>a.updatedAt-b.updatedAt);
        while(installRuns.size>=64&&terminal.length)installRuns.delete(terminal.shift().installId);
        if(installRuns.size>=64)throw Object.assign(new Error('Too many plugin installs are in progress'),{code:'MANAGEMENT_BUSY'});
        const state={installId,status:'running',fingerprint,updatedAt:Date.now()};installRuns.set(installId,state);
        state.promise=Promise.resolve().then(()=>pluginManager.updateBundle(name,version,{requestId:installId}));
        state.promise.then(result=>{state.status='completed';state.result=result;state.updatedAt=Date.now();},error=>{state.status='failed';state.error=String(error?.message??error);state.updatedAt=Date.now();});
        data={installId,status:'running'};break;
      }
      case 'settings.describe': {
        const settings=optional(ctx,'settings');
        data={writable:settings.writable,namespaces:settings.describe({redactSecrets:true})};break;
      }
      case 'settings.secretSet': {
        const settings=optional(ctx,'settings'),ns=requireString(args.ns,'ns',256);
        const descriptor=settings.describe({redactSecrets:true}).find(item=>item.ns===ns);
        if(!settings.writable||!descriptor||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0)throw invalid('Configuration revision is required');
        if(!Array.isArray(args.path)||!args.path.length||args.path.some(key=>typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)))throw invalid('Secret field path is required');
        if(!(descriptor.secrets??[]).some(secret=>JSON.stringify(secret.path)===JSON.stringify(args.path)))throw invalid('Only declared secret fields can be edited');
        if(typeof args.value!=='string'||!args.value||args.value.length>8192)throw invalid('A nonempty secret is required');
        await settings.mutate(ns,[{op:'set',path:args.path,value:args.value}],args.expectedRevision);data={ok:true};break;
      }
      case 'settings.mutate': {
        const settings=optional(ctx,'settings'),ns=requireString(args.ns,'ns',256);
        const descriptor=settings.describe({redactSecrets:true}).find(item=>item.ns===ns);
        if(!settings.writable||!descriptor)throw invalid('Configuration is unavailable or read-only');
        if(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0)throw invalid('expectedRevision is required');
        if(!Array.isArray(args.ops)||!args.ops.length||args.ops.length>100)throw invalid('Expected 1 to 100 field edits');
        for(const op of args.ops){
          if(!['set','unset'].includes(op?.op)||!Array.isArray(op.path)||!op.path.length||op.path.length>32||op.path.some(key=>typeof key!=='string'||!key||['__proto__','constructor','prototype'].includes(key)))throw invalid('Use an explicit configuration field path');
          // A redacted form cannot replace a parent of a hidden credential.
          if(touchesSecret(descriptor.schema,op.path)||(descriptor.secrets??[]).some(secret=>op.path.slice(0,Math.min(op.path.length,secret.path.length)).every((key,i)=>key===secret.path[i])))throw invalid('Use the native credential editor for secret fields');
          if(op.op==='set'&&!Object.hasOwn(op,'value'))throw invalid('Set requires a value');
        }
        await settings.mutate(ns,args.ops,args.expectedRevision);data={ok:true};break;
      }
      case 'plugins.marketIndexes': data = await pluginMarket.listIndexes(); break;
      case 'plugins.marketSearch': {
        const url = requireString(args.url,'url',2048);
        const indexes = await pluginMarket.listIndexes();
        if (!indexes.some(index => index.url === url)) throw Object.assign(new Error('Market index is not configured'),{code:'INVALID_REQUEST'});
        const query = requireObject(args.query,'query');
        data = await pluginMarket.search(url, query);
        break;
      }
      case 'plugins.install': {
        const spec = requireString(args.spec,'spec',2048);
        const installId = args.installId === undefined ? randomUUID() : requireString(args.installId,'installId',128);
        const options = requireObject(args.options ?? {},'options');
        const allowed=new Set(['enabled','saveExact','approvedBuilds','registry']);
        if(Object.keys(options).some(key=>!allowed.has(key))) throw invalid('Unsupported install option');
        if(options.enabled!==undefined&&typeof options.enabled!=='boolean') throw invalid('enabled must be boolean');
        if(options.saveExact!==undefined&&typeof options.saveExact!=='boolean') throw invalid('saveExact must be boolean');
        if(options.approvedBuilds!==undefined&&(!Array.isArray(options.approvedBuilds)||options.approvedBuilds.some(x=>typeof x!=='string'||!x))) throw invalid('approvedBuilds must be a string array');
        if(options.registry!==undefined&&typeof options.registry!=='string') throw invalid('registry must be a string');
        const fingerprint=JSON.stringify({spec,options});
        const old=installRuns.get(installId);
        if(old){
          if(old.fingerprint!==fingerprint) throw Object.assign(new Error('installId is already bound to another request'),{code:'CONFLICT'});
          data={installId,status:old.status};
          break;
        }
        const terminal=[...installRuns.values()].filter(item=>item.status!=='running').sort((a,b)=>a.updatedAt-b.updatedAt);
        while(installRuns.size>=64&&terminal.length) installRuns.delete(terminal.shift().installId);
        if(installRuns.size>=64) throw Object.assign(new Error('Too many plugin installs are in progress'),{code:'MANAGEMENT_BUSY'});
        const promise = Promise.resolve().then(() => pluginManager.installBundle(spec,{...options,requestId:installId}));
        const state = {installId,status:'running',result:undefined,error:undefined,promise,fingerprint,updatedAt:Date.now()};
        installRuns.set(installId,state);
        promise.then(result=>{state.status='completed';state.result=result;state.updatedAt=Date.now();},error=>{state.status='failed';state.error=String(error?.message??error);state.updatedAt=Date.now();});
        data = {installId,status:'running'};
        break;
      }
      case 'plugins.installProgress': {
        const installId = requireString(args.installId,'installId',128);
        const state = installRuns.get(installId);
        if (!state) { data={installId,status:'unknown'}; break; }
        if (state.status==='running') data={installId,status:'running'};
        else if (state.status==='failed') data={installId,status:'failed',error:state.error};
        else data={installId,status:'completed',result:installSummary(state.result)};
        break;
      }
      case 'plugins.cancelInstall': {
        const installId = requireString(args.installId,'installId',128);
        data = await pluginManager.cancelInstall(installId);
        break;
      }
      case 'plugins.enableBundle':
        if(typeof args.enabled!=='boolean') throw invalid('enabled must be boolean');
        data = await pluginManager.setBundleEnabled(requireString(args.name,'name',256), args.enabled); break;
      case 'plugins.enablePlugin':
        if(typeof args.enabled!=='boolean') throw invalid('enabled must be boolean');
        data = await pluginManager.setPluginEnabled(requireString(args.id,'id',256), args.enabled); break;
      case 'plugins.removeBundle':
        data = await pluginManager.removeBundle(requireString(args.name,'name',256)); break;
      case 'schedules.list': data = await schedule.remoteList(args.request ?? {}); break;
      case 'schedules.catalog': data = await schedule.catalog(); break;
      case 'schedules.view': data = await schedule.view(requireObject(args.request,'request')); break;
      case 'schedules.history': data = await schedule.remoteHistory(requireObject(args.request,'request')); break;
      case 'schedules.create': data = await schedule.remoteCreate(requireObject(args.request,'request'), signal); break;
      case 'schedules.edit': {
        const request = requireObject(args.request,'request');
        if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== null && typeof request.expectedUpdatedAt !== 'string') throw invalid('expectedUpdatedAt must be a string or null');
        data = await schedule.remoteEdit(request, signal);
        break;
      }
      case 'schedules.run': data = await schedule.run(requireObject(args.request,'request'), signal); break;
      case 'schedules.deleteInactive': data = await schedule.deleteInactive(); break;
      default: throw invalid('Unsupported management action');
    }
    return {action,data:data===undefined?{ok:true}:data};
  };

  return {execute, capabilities};
}

export const mobileManagementActions = Object.freeze({...ACTIONS});
