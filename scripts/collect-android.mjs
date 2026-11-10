import {readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {artifactOutput} from './artifact-output.mjs';
const root=resolve(import.meta.dirname,'..'),debug=process.argv.includes('--debug'),variant=debug?'debug':'release';
const output=await artifactOutput({root,platform:'android',channel:variant,args:process.argv.slice(2)});
try{
 const directory=join(root,'android/native/app/build/outputs/apk',variant);
 const metadata=JSON.parse(await readFile(join(directory,'output-metadata.json'),'utf8'));
 const element=metadata.elements[0];if(metadata.elements.length!==1)throw Error('Expected one universal APK');
 const expectedId='io.github.wyf929597870.shiwen'+(debug?'.probe':'');
 if(metadata.applicationId!==expectedId||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-debug)?$/.test(element.versionName)||element.outputFile!==`app-${variant}.apk`)throw Error('Unexpected or unsigned APK');
 const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||((await readFile(join(root,'android/native/local.properties'),'utf8')).match(/^sdk\.dir=(.+)$/m)?.[1]);
 if(!sdk)throw Error('Set ANDROID_HOME or ANDROID_SDK_ROOT');
 const signer=join(sdk,'build-tools/36.0.0',process.platform==='win32'?'apksigner.bat':'apksigner');
 const input=join(directory,element.outputFile),files=[input];
 execFileSync(signer,['verify',input],{stdio:'inherit',shell:process.platform==='win32'});
 const {copyFile}=await import('node:fs/promises');
 const staged=join(output.directory,`shiwen-android-${element.versionName}.apk`);await copyFile(input,staged);
 const artifacts=[staged];
 if(process.argv.includes('--include-tests')){
  if(!debug)throw Error('Instrumentation APKs belong in debug only');
  const test=join(root,'android/native/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
  execFileSync(signer,['verify',test],{stdio:'inherit',shell:process.platform==='win32'});
  const target=join(output.directory,`shiwen-android-${element.versionName}-androidTest.apk`);await copyFile(test,target);artifacts.push(target);files.push(test);
 }
 console.log('Android artifacts:',await output.publish(artifacts));
 for(const file of files)await rm(file); // Gradle regenerates missing outputs on the next build.
}finally{await output.dispose();}
