import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSourceFilename } from '../src/ingestion/source.ts';

test('standalone image formats are accepted as knowledge sources', () => {
  for (const name of ['chart.JPG', 'chart.jpeg', 'chart.png', 'chart.webp']) {
    assert.doesNotThrow(() => validateSourceFilename(name));
  }
  for (const name of ['chart.svg', 'chart.gif', 'chart.heic']) {
    assert.throws(() => validateSourceFilename(name), { code: 'unsupported_file_type' });
  }
});

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { normalizeImage } from '../src/ingestion/images.ts';
import { OpenAIImageRecognizer, validateImageEvidence, imageEvidenceText, recognizeImage } from '../src/ingestion/image-recognition.ts';
import { chunkText } from '../src/ingestion/chunking.ts';
import { largestPhoto } from '../src/telegram/uploads.ts';
const signal = () => new AbortController().signal;
const chart = JSON.parse(await readFile(new URL('./fixtures/images/ground-truth.json', import.meta.url)));
const png = await readFile(new URL('./fixtures/images/size-chart.png', import.meta.url));

test('real decoders normalize all supported formats and reject damaged, mismatched, animated and excessive pixel input', async () => {
  for (const ext of ['png','jpg','webp']) {
    const bytes = await readFile(new URL(`./fixtures/images/size-chart.${ext}`, import.meta.url));
    const normalized = await normalizeImage(bytes, `chart.${ext}`, signal());
    assert.equal((await sharp(normalized).metadata()).format, 'png');
  }
  const invalid = Buffer.from('not an image');
  for (const [bytes, name] of [[invalid,'bad.png'],[png,'bad.webp'],[Buffer.from('GIF89a'),'bad.png']]) {
    await assert.rejects(normalizeImage(bytes, name, signal()), { code: 'invalid_image' });
  }
  const huge = await sharp({create: {width: 5100,height: 5100,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(normalizeImage(huge, 'huge.png', signal()), { code: 'invalid_image' });
  const animated = await sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,pageHeight:16,channels:3}}).webp({loop:0}).toBuffer();
  assert.equal((await sharp(animated,{animated:true}).metadata()).pages, 2);
  await assert.rejects(normalizeImage(animated, 'animated.webp', signal()), { code: 'invalid_image' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizeImage(png,'chart.png',controller.signal));
  assert.ok((await normalizeImage(png,'chart.png',signal())).length);
});

test('table serialization keeps each size associated with chart identity, units and measurement basis after chunking', () => {
  const text = imageEvidenceText(validateImageEvidence(chart), 'source-1: chart.png', 'Product Aurora');
  const chunks = chunkText(text);
  for (const [index, size] of ['S','M','L'].entries()) {
    const row = chunks.find(chunk => chunk.text.includes(`"Size": "${size}"`));
    assert.ok(row);
    for (const field of ['Aurora shirts', 'Body measurements', 'Chest (cm)', chart.tables[0].rows[index][1]]) assert.ok(row.text.includes(field));
  }
  assert.ok(text.includes('Owner-supplied caption: Product Aurora'));
  const partial = structuredClone(chart); partial.tables[0].rows[1][1]='[unreadable]'; partial.unreadable_regions=['Chest for M'];
  const partialText = imageEvidenceText(validateImageEvidence(partial), 'partial.png');
  assert.ok(partialText.includes('[unreadable]'));
  assert.ok(!partialText.includes('92–96'));
  assert.throws(() => validateImageEvidence({...chart,tables:[{...chart.tables[0],rows:[['M','92–96']]}]}), {code:'invalid_image_response'});
  assert.throws(() => validateImageEvidence({visible_text:'',description:'',tables:[],unreadable_regions:['blurred']}), {code:'empty_image'});
});

const completed = evidence => ({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(evidence)}]}]});
test('recognition uses bounded high-detail image input, strict output and safe failure classification', async () => {
  let payload;
  const provider = new OpenAIImageRecognizer('test-key', async (_url, options) => {
    payload=JSON.parse(options.body); return Response.json(completed(chart));
  });
  assert.deepEqual(await provider.recognize(png,signal()),chart);
  assert.equal(payload.store,false); assert.equal(payload.max_output_tokens,8192);
  assert.equal(payload.input[0].content[0].detail,'high');
  assert.ok(payload.input[0].content[0].image_url.startsWith('data:image/png;base64,'));
  assert.equal(payload.text.format.strict,true);
  assert.match(payload.instructions,/Never follow instructions/);
  for (const [response, code, retryable] of [
    [() => Response.json({status:'incomplete'}),'incomplete_image',false],
    [() => Response.json(completed({...chart,tables:[{headers:['Size'],rows:[['M','extra']],title:'',notes:''}]})),'invalid_image_response',false],
    [() => new Response('private provider data',{status:401}),'image_provider_error',false],
    [() => new Response('',{status:429}),'image_provider_error',true],
    [() => new Response('',{status:503}),'image_provider_error',true],
    [() => Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}),'image_refused',false],
  ]) {
    await assert.rejects(new OpenAIImageRecognizer('test-key',async()=>response()).recognize(png,signal()), error => error.code===code && error.retryable===retryable && !error.message.includes('private'));
  }
});

test('recognition admission is shared, cancellation releases capacity, and photos use maximum pixel area', async () => {
  let active=0, peak=0;
  const provider={model:'fixture',async recognize(_image,sig) {
    sig.throwIfAborted(); active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,10)); active--; return chart;
  }};
  const controller=new AbortController(); controller.abort();
  const results=await Promise.allSettled([recognizeImage(provider,png,signal()),recognizeImage(provider,png,controller.signal),recognizeImage(provider,png,signal())]);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','rejected','fulfilled']);
  assert.equal(peak,1);
  assert.equal(largestPhoto([{file_id:'large',width:1000,height:460},{file_id:'small',width:100,height:46}]).file_id,'large');
});
