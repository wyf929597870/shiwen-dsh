// esbuild transpiles JSX without checking unresolved variable names. Use the
// existing TypeScript compiler to catch these runtime crashes in JavaScript UI.
// This is a reference check, not a claim that the JavaScript app is fully typed.
import ts from 'typescript';
import {globSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=globSync('web/*.{jsx,js,mjs}',{cwd:root}).map(path=>resolve(root,path));
const program=ts.createProgram(files,{allowJs:true,checkJs:true,noEmit:true,jsx:ts.JsxEmit.ReactJSX,
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,skipLibCheck:true});
const diagnostics=ts.getPreEmitDiagnostics(program).filter(item=>[2304,2552].includes(item.code));
for(const item of diagnostics){
  const position=item.file.getLineAndCharacterOfPosition(item.start);
  console.error(`${item.file.fileName}:${position.line+1}:${position.character+1} ${ts.flattenDiagnosticMessageText(item.messageText,' ')}`);
}
const nativeSource=readFileSync(resolve(root,'native/app/src/main/java/io/github/wyf929597870/shiwen/probe/LibraryProbePlugin.kt'),'utf8');
const nativeMethods=new Set([...nativeSource.matchAll(/@PluginMethod\s+fun\s+(\w+)/g)].map(match=>match[1]));
let missing=0;
for(const file of files){
  const source=program.getSourceFile(file);
  const visit=node=>{
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
      const method=node.arguments[0].text;
      // `call` is the native bridge import. Recovery wraps it in a fixed request helper.
      if((node.expression.text==='call'||node.expression.text==='request'&&method.startsWith('recovery'))&&!nativeMethods.has(method)){
        const position=source.getLineAndCharacterOfPosition(node.getStart());
        console.error(`${file}:${position.line+1} Native bridge method ${method} is not registered.`);missing++;
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
}
if(diagnostics.length||missing)process.exitCode=1;
else console.log(`Checked unresolved UI references and native bridge methods in ${files.length} JavaScript modules.`);
