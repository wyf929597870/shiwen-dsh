import {build,Platform,Arch} from 'electron-builder';
import {createRequire} from 'node:module';
import {cp,mkdir,readFile,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'..');
const desktop=join(root,'upstream/dsh/apps/desktop');
const target=join(desktop,'.desktop-build/targets/win-x64');
const stage=join(root,'.runtime/windows-package');
const app=join(stage,'app'),shiwen=join(stage,'shiwen');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 packaging requires Windows x64.');
const descriptor=await json(join(target,'dsh/desktop-runtime.json'));
const {verifyDesktopRuntime}=await import(pathToFileURL(join(desktop,'lib/types/runtime-tree.js')).href);
await verifyDesktopRuntime(join(target,'dsh'),descriptor.release.version,{platform:'win32',arch:'x64'});
await rm(stage,{recursive:true,force:true});await mkdir(app,{recursive:true});
execFileSync(process.execPath,[join(root,'scripts/build.mjs'),'--out-dir',join(stage,'built-plugins')],{cwd:root,stdio:'inherit'});

// Materialize only production dependencies. Resolve each dependency from its owning
// package, retaining nested versions when the flat destination already has another.
async function collect(names,sourceManifest,destination){
 const installed=new Map(),preferred=new Map();
 async function locate(name,from){
  const require=createRequire(from);let manifest;
  try{manifest=require.resolve(name+'/package.json');}catch{
   let directory=dirname(require.resolve(name));
   while(true){try{if((await json(join(directory,'package.json'))).name===name){manifest=join(directory,'package.json');break;}}catch{}
    const parent=dirname(directory);if(parent===directory)throw Error('Cannot locate '+name);directory=parent;
   }
  }
  return manifest;
 }
 for(const name of names)preferred.set(name,await realpath(dirname(await locate(name,sourceManifest))));
 async function copy(name,from,local){
  const require=createRequire(from),manifest=await locate(name,from);
  const source=await realpath(dirname(manifest));
  const rootTarget=join(destination,name);
  const conflict=(preferred.has(name)&&preferred.get(name)!==source)||(installed.has(rootTarget)&&installed.get(rootTarget)!==source);
  const dest=conflict?join(local,name):rootTarget;
  if(installed.get(dest)===source)return;
  if(installed.has(dest))throw Error('Dependency collision: '+dest);
  installed.set(dest,source);
  await mkdir(dirname(dest),{recursive:true});
  await cp(source,dest,{recursive:true,dereference:true,filter:path=>path===source||!path.slice(source.length+1).split('/').some(part=>part==='node_modules'||part==='.git')});
  const pkg=await json(manifest);
  for(const dependency of Object.keys(pkg.dependencies??{}))await copy(dependency,manifest,join(dest,'node_modules'));
  for(const dependency of Object.keys(pkg.optionalDependencies??{})){
   try{require.resolve(dependency);}catch{continue;}
   await copy(dependency,manifest,join(dest,'node_modules'));
  }
 }
 for(const name of names)await copy(name,sourceManifest,destination);
}
for(const file of ['main.js','operation-report-worker.js','preload-app.cjs','preload-welcome.cjs','preload-platform-account.cjs','preload-mandatory.cjs','preload-update-dialog.cjs']){
 await mkdir(join(app,'lib'),{recursive:true});await cp(join(desktop,'lib',file),join(app,'lib',file));
}
await cp(join(desktop,'lib/welcome'),join(app,'lib/welcome'),{recursive:true});
await cp(join(desktop,'renderer'),join(app,'renderer'),{recursive:true});
await cp(join(root,'desktop'),join(app,'desktop'),{recursive:true});
const source=await json(join(desktop,'package.json')),product=await json(join(root,'package.json'));
await collect(Object.keys(source.dependencies),join(desktop,'package.json'),join(app,'node_modules'));
const dependencies={};for(const name of Object.keys(source.dependencies))dependencies[name]=(await json(join(app,'node_modules',name,'package.json'))).version;
await writeFile(join(app,'package.json'),JSON.stringify({name:'shiwen-dsh',version:product.version,description:product.description,type:'module',main:'desktop/entry.mjs',desktopName:'shiwen-dsh.desktop',license:'MIT',author:'Shiwen contributors',homepage:product.homepage,dependencies},null,2));
await cp(join(root,'LICENSE'),join(app,'LICENSE'));
const vcRedist=process.env.SHIWEN_VC_REDIST;
if(!vcRedist)throw Error('Set SHIWEN_VC_REDIST to the verified Microsoft Visual C++ x64 redistributable.');
await mkdir(shiwen,{recursive:true});await cp(vcRedist,join(shiwen,'vc_redist.x64.exe'));
await mkdir(join(shiwen,'assets'),{recursive:true});
await cp(join(root,'assets/shiwen-icon-rounded.png'),join(shiwen,'assets/shiwen-icon-rounded.png'));
await mkdir(join(shiwen,'scripts'),{recursive:true});
for(const file of ['profile.mjs','server-worker.mjs','server-control.mjs','server-config.mjs','server.mjs'])await cp(join(root,'scripts',file),join(shiwen,'scripts',file));
// The client imports only the control library; the detached worker and Node live outside asar.
await mkdir(join(app,'scripts'),{recursive:true});
for(const file of ['server-control.mjs','server-config.mjs'])await cp(join(root,'scripts',file),join(app,'scripts',file));
await mkdir(join(shiwen,'plugins/library/src'),{recursive:true});
await cp(join(root,'plugins/library/src/ownership.mjs'),join(shiwen,'plugins/library/src/ownership.mjs'));

for(const name of ['library','agent-tools','theme','workbench','personal-context','external']){
 const dest=join(shiwen,'plugins',name);await mkdir(dest,{recursive:true});
 await cp(join(stage,'built-plugins',name,'package.json'),join(dest,'package.json'));
 await cp(join(stage,'built-plugins',name,'lib'),join(dest,'lib'),{recursive:true});
}
await cp(join(root,'integration'),join(shiwen,'integration'),{recursive:true});
await cp(join(root,'skills'),join(shiwen,'skills'),{recursive:true});
await writeFile(join(shiwen,'shiwen-server.cmd'),'@echo off\r\n"%~dp0..\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe" "%~dp0scripts\\server.mjs" %*\r\n');
await collect(['diff','js-yaml','markdown-it','@modelcontextprotocol/server','zod'],join(root,'package.json'),join(shiwen,'node_modules'));
// hicolor themes discover standard size directories; the design source is 1254px.
const icons=join(stage,'icons');await mkdir(icons,{recursive:true});
const sharp=createRequire(join(desktop,'package.json'))('sharp');
for(const size of [16,24,32,48,64,128,256,512]){
 await sharp(join(root,'assets/shiwen-icon-rounded.png')).resize(size,size).png().toFile(join(icons,`${size}x${size}.png`));
}
const iconPng=await readFile(join(icons,'256x256.png'));
const icoHeader=Buffer.alloc(22);icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(1,4);icoHeader.writeUInt16LE(1,10);icoHeader.writeUInt16LE(32,12);icoHeader.writeUInt32LE(iconPng.length,14);icoHeader.writeUInt32LE(22,18);
const ico=join(icons,'shiwen.ico');await writeFile(ico,Buffer.concat([icoHeader,iconPng]));
const artifacts=await build({targets:Platform.WINDOWS.createTarget(process.argv.includes('--dir')?['dir']:['nsis'],Arch.x64),publish:'never',config:{
 appId:'io.shiwen.dsh',productName:'拾文',executableName:'shiwen-dsh',
 directories:{app,output:join(root,'release/windows')},electronVersion:'44.7.0',electronDist:join(target,'electron'),
 npmRebuild:false,asar:true,electronFuses:{runAsNode:true},
 files:['**/*','!node_modules/**/*.map'],
 extraResources:[
  {from:join(target,'runtime'),to:'runtime'},
  {from:join(target,'dsh'),to:'dsh'},
  {from:join(target,'dsh/node_modules'),to:'dsh/node_modules',filter:['**/*']},
  {from:shiwen,to:'shiwen'},
  {from:join(shiwen,'node_modules'),to:'shiwen/node_modules',filter:['**/*']}
 ],
 win:{target:['nsis'],icon:ico,signExecutable:false},
 nsis:{oneClick:false,perMachine:true,allowToChangeInstallationDirectory:true,installerIcon:ico,uninstallerIcon:ico,include:join(root,'desktop/windows-installer.nsh')},
 artifactName:'shiwen-dsh-${version}-windows-${arch}.${ext}',publish:null,
 afterPack:async context=>{
  const resources=join(context.appOutDir,'resources');
  // Windows installers cannot reliably preserve junctions; include the full DSH graph for the independent service.
  await cp(join(resources,'dsh/node_modules'),join(resources,'shiwen/node_modules'),{recursive:true,dereference:true,force:false});
  await verifyDesktopRuntime(join(resources,'dsh'),descriptor.release.version,{platform:'win32',arch:'x64'});
 }
}});
console.log('Windows artifacts:',artifacts);
