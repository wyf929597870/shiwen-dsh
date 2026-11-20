// Run with the model parent and the fixed synthetic evaluation directory.
// Writes vectors for verify-pc-semantic-model.py; never reads the user library.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createModel,QUERY_INSTRUCTION} from '../plugins/library/src/search/model.mjs';
const [modelDir,fixtureDir,output]=process.argv.slice(2);if(!modelDir||!fixtureDir||!output)throw Error('Usage: node scripts/verify-pc-semantic-model.mjs MODEL_PARENT FIXTURE_DIR OUTPUT_JSON');
const fixture=JSON.parse(await readFile(join(resolve(fixtureDir),'fixture.json'))),chunks=JSON.parse(await readFile(join(resolve(fixtureDir),'chunks.json')));
const texts=[...chunks.map(c=>c.text),...fixture.queries.map(q=>QUERY_INSTRUCTION+q.text)],model=createModel({directory:resolve(modelDir)});
try{if(!await model.available())throw Error('Model assets missing or checksum invalid');await model.enable();const vectors=[];for(const text of texts)vectors.push((await model.embed([text]))[0]);await writeFile(resolve(output),JSON.stringify(vectors));console.log(`wrote ${vectors.length} vectors`);}finally{await model.close();}
