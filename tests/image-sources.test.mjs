import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { createKnowledgeBase, replaceKnowledgeBase, transaction } from '../src/knowledge-bases/service.ts';
import { prepareImage, addImageSource } from '../src/ingestion/image-sources.ts';
import { IngestionProcessor } from '../src/ingestion/processor.ts';
import { IngestionError } from '../src/ingestion/embeddings.ts';
import { startIngestionWorker } from '../src/ingestion/worker.ts';
import { TelegramService } from '../src/telegram/service.ts';
import { processUploadNext } from '../src/telegram/upload-worker.ts';
import { OwnerOpenAI } from '../src/providers/owner-openai.ts';
import { QuestionAnswering } from '../src/queries/service.ts';

const name=`say_ai_images_test_${randomBytes(8).toString('hex')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
let pool, created=false, url;
const key=randomBytes(32).toString('base64url');
const png=await readFile(new URL('./fixtures/images/size-chart.png',import.meta.url));
const chart=JSON.parse(await readFile(new URL('./fixtures/images/ground-truth.json',import.meta.url)));
const sig=()=>new AbortController().signal;
const embedder={model:'text-embedding-3-small',dimensions:3,async embed(texts){return texts.map(()=>[1,0,0]);}};
const recognizer={model:'fixture-vision',async recognize(){return chart;}};
let servers=[];
const migrate=(...args)=>promisify(execFile)(process.execPath,['node_modules/node-pg-migrate/bin/node-pg-migrate.js',...args,'--no-verbose'],{env:{...process.env,DATABASE_URL:url.toString()}});
before(async()=>{
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  url=new URL(process.env.DATABASE_URL);url.pathname=`/${name}`;
  await migrate('up');pool=new pg.Pool({connectionString:url.toString()});
});
beforeEach(async()=>{
  await pool.query('TRUNCATE knowledge_bases,upload_drafts,telegram_sessions CASCADE');
  await pool.query('UPDATE image_storage_settings SET owner_bytes=200000000');
});
after(async()=>{
  for(const server of servers) await new Promise(resolve=>server.close(resolve));
  await pool?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();
});
async function app(owner='owner',available=true){
  const server=createApp({pool,apiKey:key,ownerId:owner,imageAvailable:async()=>available}).listen(0,'127.0.0.1');
  servers.push(server);await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;
}
async function upload(baseUrl,bytes=png,filename='chart.png',base){
  const form=new FormData();form.set('file',new Blob([bytes]),filename);
  return fetch(`${baseUrl}/knowledge-bases${base?`/${base}/content`:''}`,{method:base?'PUT':'POST',headers:{Authorization:`Bearer ${key}`},body:form});
}
async function taskFor(base){return (await pool.query('SELECT * FROM ingestion_tasks WHERE knowledge_base_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[base])).rows[0];}
async function processNext(provider=async()=>recognizer,embedding=embedder){
  const client=await pool.connect();
  try{
    const processor=new IngestionProcessor(client,embedding,[0,0],undefined,undefined,async(taskId,signal)=>{
      const rows=(await pool.query('SELECT id FROM image_sources WHERE ingestion_task_id=$1',[taskId])).rows;
      const parts=[];for(const row of rows)parts.push(await prepareImage(pool,row.id,provider,signal));return parts.join('\n\n');
    });
    await processor.recover();return await processor.processNext(sig());
  }finally{client.release();}
}
async function draft(provider=async()=>recognizer,download=async()=>png,credentials){
  const user=1001;
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES($1,'en')",[user]);
  const service=new TelegramService(pool,{token:'100:manager',managerId:'100',encryptionKey:randomBytes(32)}, {async call(){return true;},download},undefined,credentials,provider);
  await transaction(pool,db=>service.uploads.start(db,user,'Charts'));
  const id=(await pool.query('SELECT id FROM upload_drafts WHERE user_id=$1',[user])).rows[0].id;
  return {service,user,id};
}
async function add(f,messageId,filename='chart.png',size=png.length){
  return transaction(pool,db=>f.service.uploads.add(db,f.user,f.id,messageId,{file_id:String(messageId),file_name:filename,file_size:size},undefined,'Product Aurora'));
}
async function done(f){await transaction(pool,db=>f.service.uploads.action(db,f.user,`ud:${f.id}`));}

test('HTTP image submissions are durable, pending, owner isolated and invalid images are rejected before ingestion',async()=>{
  const endpoint=await app();
  const response=await upload(endpoint);assert.equal(response.status,201);
  const result=await response.json();assert.equal(result.queryable,false);
  assert.equal((await taskFor(result.id)).source_text,null);
  const stored=(await pool.query('SELECT * FROM image_sources')).rows[0];
  assert.ok(stored.original_bytes.equals(png));assert.equal(stored.reserved_bytes,png.length);
  const other=await app('other');
  assert.equal((await upload(other,png,'chart.png',result.id)).status,404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_sources')).rows[0].n,1);
  assert.equal((await upload(endpoint,Buffer.from('bad'),'bad.png')).status,400);
  assert.equal((await upload(endpoint,png,'bad.webp')).status,400);
  const unavailable=await app('without-key',false);
  assert.equal((await upload(unavailable)).status,503);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM knowledge_bases')).rows[0].n,1);
});

test('ingestion activates image context and preserves extracted checkpoints across an embedding failure',async()=>{
  let calls=0;
  const submitted=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  const provider=async()=>({model:'fixture-vision',async recognize(){calls++;return chart;}});
  await processNext(provider,{...embedder,async embed(){throw new IngestionError('temporary','Temporary embedding failure.');}});
  assert.equal((await taskFor(submitted.id)).status,'pending');assert.equal(calls,1);
  assert.equal((await pool.query('SELECT active_version_id FROM knowledge_bases')).rows[0].active_version_id,null);
  await processNext(provider);assert.equal(calls,1);
  assert.equal((await taskFor(submitted.id)).status,'ready');
  const chunks=(await pool.query('SELECT text FROM chunks')).rows.map(row=>row.text);
  assert.ok(chunks.some(text=>text.includes('"Size": "M"')&&text.includes('92–96')&&text.includes('Chest (cm)')));
  const questions=new QuestionAnswering({pool,embedder:()=>embedder,answerer:{async answer(question,context){
    assert.equal(question,'What is the chest range for size M?');
    const row=context.find(chunk=>chunk.text.includes('"Size": "M"'));
    assert.ok(row);assert.ok(row.text.includes('Body measurements'));
    return {outcome:'answered',answer:'92–96 cm.',chunk_ids:[row.id],topic:'related'};
  }}});
  const result=await questions.ask(submitted.id,'owner','What is the chest range for size M?',sig());
  assert.equal(result.answer,'92–96 cm.');assert.ok(result.sources[0].text.includes('92–96'));
});

test('the actual ingestion worker prepares durable images without a Telegram configuration',async()=>{
  const submitted=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  let failure=false,calls=0;
  const worker=await startIngestionWorker(pool,embedder,()=>{failure=true;},undefined,async()=>({model:'fixture',async recognize(){calls++;return chart;}}));
  try{
    const deadline=Date.now()+10000;
    while((await taskFor(submitted.id)).status!=='ready'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await taskFor(submitted.id)).status,'ready');assert.equal(calls,1);assert.equal(failure,false);
  }finally{await worker.stop();}
});

test('failed image replacement keeps the prior active version and rejects concurrent replacements',async()=>{
  const base=await transaction(pool,db=>createKnowledgeBase(db,'owner','Existing returns policy.'));
  await processNext();
  const prior=(await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id=$1',[base.id])).rows[0].active_version_id;
  const replacement=await transaction(pool,db=>replaceKnowledgeBase(db,'owner',base.id,{bytes:png,filename:'chart.png'}));
  assert.equal(replacement.queryable,true);
  await assert.rejects(transaction(pool,db=>replaceKnowledgeBase(db,'owner',base.id,{bytes:png,filename:'another.png'})),{code:'ingestion_in_progress'});
  await processNext(async()=>({model:'fixture',async recognize(){throw new IngestionError('empty_image','Unreadable image.',false);}}));
  assert.equal((await taskFor(base.id)).status,'failed');
  assert.equal((await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id=$1',[base.id])).rows[0].active_version_id,prior);
});

test('image ownership, durable-source constraints and storage reservations hold under concurrent admission',async()=>{
  const base=await transaction(pool,db=>createKnowledgeBase(db,'owner','Existing content.'));
  await assert.rejects(pool.query('INSERT INTO ingestion_tasks(knowledge_base_id,source_text) VALUES($1,NULL)',[base.id]),{code:'23505'});
  await processNext();
  await assert.rejects(pool.query('INSERT INTO ingestion_tasks(knowledge_base_id,source_text) VALUES($1,NULL)',[base.id]),{code:'23514'});
  await assert.rejects(transaction(pool,db=>addImageSource(db,'other','chart.png',{task:base.taskId},png)),{code:'23514'});
  const f=await draft();
  await pool.query('UPDATE image_storage_settings SET owner_bytes=20000000');
  const results=await Promise.allSettled([add(f,1,'first.png',20000000),add(f,2,'second.png',20000000)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(results.find(row=>row.status==='rejected').reason.code,'image_storage_full');
  await assert.rejects(transaction(pool,db=>f.service.uploads.action(db,f.user+1,`ux:${f.id}`)),{code:'expired_upload'});
  await transaction(pool,db=>f.service.uploads.action(db,f.user,`ux:${f.id}`));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_sources')).rows[0].n,0);
});

test('mixed Telegram upload retains recognition after another file fails, transfers sources atomically and releases storage on base deletion',async()=>{
  let calls=0,downloads=0;
  const f=await draft(async()=>({model:'fixture',async recognize(){calls++;return chart;}}),async(_token,id)=>{downloads++;return id==='2'?Buffer.from('broken PDF'):png;});
  await add(f,1);await add(f,2,'broken.pdf',10);await done(f);await processUploadNext(f.service);
  assert.equal(calls,1);
  const state=(await pool.query('SELECT * FROM upload_drafts WHERE id=$1',[f.id])).rows[0];assert.equal(state.status,'collecting');assert.equal(state.task_id,null);
  const bad=(await pool.query("SELECT id FROM upload_draft_items WHERE filename='broken.pdf'")).rows[0];
  await transaction(pool,db=>f.service.uploads.action(db,f.user,`ur:${f.id}:${bad.id}`));
  await transaction(pool,db=>f.service.uploads.add(db,f.user,f.id,3,undefined,'Returns within 14 days.'));
  await done(f);await processUploadNext(f.service);assert.equal(calls,1);assert.equal(downloads,2);
  const image=(await pool.query('SELECT * FROM image_sources')).rows[0];assert.ok(image.ingestion_task_id);assert.equal(image.draft_item_id,null);
  assert.ok(image.original_bytes.equals(png));assert.equal(image.caption,'Product Aurora');
  const task=(await pool.query('SELECT source_text FROM ingestion_tasks WHERE id=$1',[image.ingestion_task_id])).rows[0];
  assert.ok(task.source_text.includes('Returns within 14 days.'));assert.ok(task.source_text.includes('92–96'));
  await processNext();
  const base=(await pool.query('SELECT knowledge_base_id FROM ingestion_tasks WHERE id=$1',[image.ingestion_task_id])).rows[0];
  await transaction(pool,db=>f.service.action(db,f.user,`confirmdelete:${base.knowledge_base_id}`));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_sources')).rows[0].n,0);
});

test('Telegram photos select largest size and use the normal draft, while captions remain source data',async()=>{
  const f=await draft();
  await transaction(pool,db=>f.service.handle(db,'100',{update_id:5,message:{message_id:5,from:{id:f.user},chat:{id:f.user,type:'private'},caption:'Aurora chart',photo:[{file_id:'large',width:1000,height:460,file_size:png.length},{file_id:'small',width:100,height:46,file_size:100}]}}));
  const item=(await pool.query('SELECT * FROM upload_draft_items')).rows[0];assert.equal(item.file_id,'large');assert.equal(item.filename,'photo.jpg');assert.equal(item.caption,'Aurora chart');
  // Real Telegram photos are JPEG; the test above verifies routing without downloading.
});

test('cancelled downloads, missing keys and invalid images suppress recognition',async()=>{
  let calls=0;
  const provider=async()=>({model:'fixture',async recognize(){calls++;return chart;}});
  let cancel;
  const f=await draft(provider,async()=>{await cancel();return png;});
  await add(f,1);await done(f);
  cancel=()=>transaction(pool,db=>f.service.uploads.action(db,f.user,`ux:${f.id}`));
  await processUploadNext(f.service);assert.equal(calls,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_sources')).rows[0].n,0);
  await pool.query('DELETE FROM telegram_sessions');
  const invalid=await draft(provider,async()=>Buffer.from('invalid image'));await add(invalid,1);await done(invalid);await processUploadNext(invalid.service);assert.equal(calls,0);
  await transaction(pool,db=>invalid.service.uploads.action(db,invalid.user,`ux:${invalid.id}`));await pool.query('DELETE FROM telegram_sessions');
  const noKey=await draft(provider,async()=>png,{async available(){return false;}});await add(noKey,1);await done(noKey);await processUploadNext(noKey.service);assert.equal(calls,0);
  assert.equal((await pool.query('SELECT original_bytes FROM image_sources')).rows[0].original_bytes,null);
});

test('owner-funded image calls record ingestion spending',async()=>{
  const owner='telegram:9001';
  const keys=new OwnerOpenAI(pool,randomBytes(32),undefined,undefined,undefined,async()=>Response.json({
    status:'completed',model:'gpt-6-luna',usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(chart)}]}]
  }));
  await keys.save(owner,'sk-image-fixture-key-1234567890');
  const provider=await keys.imageRecognizer(owner);await provider.recognize(png,sig());
  const rows=(await pool.query('SELECT purpose,owner_id,estimated_usd FROM provider_spending WHERE owner_id=$1',[owner])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].purpose,'ingestion');assert.ok(Number(rows[0].estimated_usd)>0);
  await keys.remove(owner);
});

test('restart reuses a persisted recognition even before task text is saved, and exhausted images make no further paid call',async()=>{
  let calls=0;
  const provider=async()=>({model:'fixture',async recognize(){calls++;return chart;}});
  const base=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  const image=(await pool.query('SELECT id FROM image_sources WHERE ingestion_task_id=$1',[base.taskId])).rows[0];
  await pool.query("UPDATE ingestion_tasks SET status='processing',attempts_started=1 WHERE id=$1",[base.taskId]);
  await prepareImage(pool,image.id,provider,sig());
  assert.equal((await taskFor(base.id)).source_text,null);assert.equal(calls,1);
  await processNext(provider);assert.equal(calls,1);assert.equal((await taskFor(base.id)).status,'ready');
  const exhausted=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  await pool.query('UPDATE image_sources SET attempts=3 WHERE ingestion_task_id=$1',[exhausted.taskId]);
  await processNext(provider);assert.equal(calls,1);assert.equal((await taskFor(exhausted.id)).status,'failed');
});

test('transient recognition failures stop after three attempts without activating partial evidence',async()=>{
  let calls=0;
  const provider=async()=>({model:'fixture',async recognize(){calls++;throw new IngestionError('image_provider_error','Temporary provider failure.');}});
  const base=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  for(let i=0;i<4;i++)await processNext(provider);
  assert.equal(calls,3);assert.equal((await taskFor(base.id)).status,'failed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM chunks')).rows[0].n,0);
});

test('cancellation during recognition prevents saving evidence or creating a knowledge base',async()=>{
  let started,finish;
  const entered=new Promise(resolve=>{started=resolve;});const complete=new Promise(resolve=>{finish=resolve;});
  const f=await draft(async()=>({model:'fixture',async recognize(){started();await complete;return chart;}}));
  await add(f,1);await done(f);
  const running=processUploadNext(f.service);await entered;
  await transaction(pool,db=>f.service.uploads.action(db,f.user,`ux:${f.id}`));finish();await running;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_sources')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM knowledge_bases')).rows[0].n,0);
});

test('image source migration rolls back and reapplies and refuses to discard unfinished image tasks',async()=>{
  const rollbackCount=String((await pool.query(`SELECT count(*)::int AS n FROM pgmigrations
    WHERE id >= (SELECT id FROM pgmigrations WHERE name='1793491200000_image_sources')`)).rows[0].n);
  const base=await transaction(pool,db=>createKnowledgeBase(db,'owner',{bytes:png,filename:'chart.png'}));
  await assert.rejects(migrate('down',rollbackCount));
  assert.equal((await taskFor(base.id)).source_text,null);
  await processNext();
  await migrate('down',rollbackCount);assert.equal((await pool.query("SELECT to_regclass('image_sources') AS name")).rows[0].name,null);
  await migrate('up');assert.equal((await taskFor(base.id)).status,'ready');
});

// This is semantic evidence only when explicitly enabled and run with real providers.
test('live image extraction and grounded size-chart answers', {skip:process.env.RUN_LIVE_IMAGE_TEST!=='true'}, async t=>{
  assert.ok(process.env.OPENAI_API_KEY,'OPENAI_API_KEY is required for the explicitly enabled paid image evaluation.');
  const {OpenAIImageRecognizer}=await import('../src/ingestion/image-recognition.ts');
  const {OpenAIEmbedder}=await import('../src/ingestion/embeddings.ts');
  const {OpenAIAnswerer}=await import('../src/queries/answerer.ts');
  const apiKey=process.env.OPENAI_API_KEY;
  const realEmbedder=new OpenAIEmbedder(apiKey,'text-embedding-3-small',1536);
  const realRecognizer=new OpenAIImageRecognizer(apiKey);
  const realAnswerer=new OpenAIAnswerer(apiKey);
  const normalize=value=>value.replace(/[–—]/g,'-').replace(/\s/g,'').toLowerCase();
  const cases=[
    {file:'size-chart.png',label:'M',values:['92-96','76-80','96-100'],question:'What chest range in cm does size M support for Aurora shirts?',required:['92','96'],unit:/cm|centimet/i},
    {file:'held-out-chart.png',label:'32',values:['32.5','32'],question:'What is the garment waist measurement for Boreal trousers labeled 32? Keep the original units.',required:['32.5'],unit:/inch|in\b/i},
    {file:'rotated-chart.png',label:'M',values:['92-96','76-80','96-100'],question:'Какой обхват груди указан для размера M в таблице Aurora?',required:['92','96'],unit:/см|сантим|cm/i},
  ];
  for(const item of cases){
    const bytes=await readFile(new URL(`./fixtures/images/${item.file}`,import.meta.url));
    const submitted=await transaction(pool,db=>createKnowledgeBase(db,'live-image-eval',{bytes,filename:item.file}));
    const started=performance.now();
    await processNext(async()=>realRecognizer,realEmbedder);
    const task=await taskFor(submitted.id);assert.equal(task.status,'ready',`Recognition/indexing failed for ${item.file}: ${task.error_code}`);
    const evidence=(await pool.query('SELECT evidence FROM image_sources WHERE ingestion_task_id=$1',[submitted.taskId])).rows[0].evidence;
    const row=evidence.tables.flatMap(table=>table.rows).find(row=>normalize(row[0])===normalize(item.label));
    assert.ok(row,`Missing expected row for ${item.file}`);
    for(const value of item.values)assert.ok(row.some(cell=>normalize(cell)===normalize(value)),`Wrong cell in ${item.file}`);
    const questions=new QuestionAnswering({pool,embedder:(model,dimensions)=>new OpenAIEmbedder(apiKey,model,dimensions),answerer:realAnswerer});
    const answer=await questions.ask(submitted.id,'live-image-eval',item.question,sig());
    assert.equal(answer.outcome,'answered');assert.ok(answer.sources.length);
    for(const number of item.required)assert.ok(answer.answer.includes(number));assert.match(answer.answer,item.unit);
    t.diagnostic(`${item.file}: extraction, indexed retrieval, and supported answer checked in ${Math.round(performance.now()-started)} ms. Review factual claims and provider billing separately.`);
  }
});
