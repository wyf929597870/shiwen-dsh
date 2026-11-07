import {readdirSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve, delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const cache = process.env.SHIWEN_KOTLIN_CACHE || join(homedir(), '.gradle/caches/modules-2/files-2.1');
function jar(group, name, version) {
  const dir = join(cache, group, name, version);
  if (existsSync(dir)) for (const hash of readdirSync(dir)) for (const file of readdirSync(join(dir, hash)))
    if (file.endsWith('.jar') && !file.endsWith('-sources.jar')) return join(dir, hash, file);
  throw Error(`Missing cached ${group}:${name}:${version}. Supply SHIWEN_KOTLIN_CACHE; no dependency is downloaded by this probe.`);
}
const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.22');
const annotations = jar('org.jetbrains', 'annotations', '13.0');
const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.22'), stdlib,
  jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '1.9.22'), annotations,
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330')];
const runtime = [stdlib, annotations, jar('org.jetbrains.kotlinx', 'kotlinx-serialization-json-jvm', '1.6.3'),
  jar('org.jetbrains.kotlinx', 'kotlinx-serialization-core-jvm', '1.6.3')];
const dir = mkdtempSync(join(tmpdir(), 'shiwen-kotlin-contract-'));
function run(args) {
  const result = spawnSync('java', args, {cwd: root, encoding: 'utf8', timeout: 60_000});
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw result.error ?? Error(`Kotlin probe failed: ${result.status}`);
}
try {
  const output = join(dir, 'probe.jar');
  run(['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-classpath', runtime.join(delimiter), '-d', output,
    'android/native/core/model/src/main/kotlin/io/github/wyf929597870/shiwen/model/Canonical.kt', 'android/probes/CanonicalProbe.kt']);
  run(['-cp', [output, ...runtime].join(delimiter), 'CanonicalProbeKt', 'contracts/mobile/v1/fixtures/canonical.json']);
} finally { rmSync(dir, {recursive: true, force: true}); }
