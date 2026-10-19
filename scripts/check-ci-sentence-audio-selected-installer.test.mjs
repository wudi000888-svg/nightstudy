/** Synthetic metadata boundaries only: no release, decoder, model or media fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  publicationEntrySha256,
  partitionPublication,
  checkSelectedPublicationMetadata,
} from './check-ci-sentence-audio-selected-installer.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const key=e=>e.textHash+'\0'+e.accent;
const sort=rows=>[...rows].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
const row=e=>({textHash:e.textHash,accent:e.accent,originalGeneratedEntrySha256:publicationEntrySha256(e)});

function fixture() {
  const targets=['Keep the newly generated media.','Reuse the explicitly qualified official media.'].map(text=>({
    text,textHash:sha(text),accents:['US','UK'],references:[{wordId:'word-'+sha(text),learningSenseId:'sense-'+sha(text),exampleId:'example-'+sha(text)}],
  })).sort((a,b)=>a.textHash<b.textHash?-1:1);
  const freshHash=targets[0].textHash,reuseHash=targets[1].textHash;
  const entries=sort(targets.flatMap(t=>['US','UK'].map(accent=>({
    text:t.text,textHash:t.textHash,accent,kind:'synthesized',cacheKey:sha(t.text+accent+'cache'),
    fileSha256:sha(t.text+accent+'generated MP3'),originalFileSha256:sha(t.text+accent+'original WAV'),
    fileKey:'files/'+sha(t.text+accent+'generated MP3')+'.mp3',mimeType:'audio/mpeg',sizeBytes:123,
    qualityMetrics:{clippedSampleFraction:0.0,rmsDbfs:-20.0},
  }))));
  const qualified=entries.filter(e=>e.textHash===reuseHash).map(e=>({
    textHash:e.textHash,accent:e.accent,text:e.text,
    entry:{...e,fileSha256:sha(e.text+e.accent+'official'),fileKey:'files/'+sha(e.text+e.accent+'official')+'.mp3'},
    baseline:{id:'sentence-audio-v1',manifestSha256:'1'.repeat(64),sourceManifestSha256:'2'.repeat(64)},
  }));
  const accepted={generatedPairs:4,media:entries.map(e=>({textHash:e.textHash,accent:e.accent,cacheKey:e.cacheKey,
    fileSha256:e.fileSha256,originalWavSha256:e.originalFileSha256}))};
  const choice={kind:'nightstudy-ci-sentence-audio-publication-choice-v1',packId:'sentence-audio-v4-0123',
    entryHashRecipe:'typed-json-ieee754be-v1',
    legacySelection:{sha256:'3'.repeat(64)},legacyQualification:{sha256:'4'.repeat(64)},
    selectedFreshPairs:entries.filter(e=>e.textHash===freshHash).map(row),
    generatedNotSelectedPairs:entries.filter(e=>e.textHash===reuseHash).map(row),
    reusedOfficialPairs:qualified.map(q=>({textHash:q.textHash,accent:q.accent,officialEntrySha256:publicationEntrySha256(q.entry)})),
  };
  const stats={lemmaCount:2,entryCount:4,recordedCount:0,synthesizedCount:4,failedCount:0};
  const originalManifest={version:choice.packId,status:'ready',schemaVersion:2,sourceManifestSha256:'5'.repeat(64),statistics:stats,entries};
  const originalSource={version:choice.packId,requestedSentences:targets,sentences:targets,
    reusedSentences:[],reusedMediaReferences:[],baselinePacks:[],coverage:{requestedClipCount:4,generatedClipCount:4},
    cloudBuildEvidence:{requestSha256:'6'.repeat(64),generatedManifestSha256:'7'.repeat(64),buildReceiptSha256:'8'.repeat(64)},
    pronunciationReviews:{sha256:'9'.repeat(64),appliedClipCount:1,bytes:1200},
    engineSource:{voices:'Synthetic only'},meaningPackSha256:'a'.repeat(64),
  };
  const choicePin={fileName:'publication-choice.json',bytes:5000,sha256:'b'.repeat(64)};
  const fresh=entries.filter(e=>e.textHash===freshHash);
  const reusedRefs=qualified.map(q=>({textHash:q.textHash,accent:q.accent,fileKey:q.entry.fileKey,
    fileSha256:q.entry.fileSha256,mimeType:q.entry.mimeType,sizeBytes:q.entry.sizeBytes,kind:q.entry.kind,cacheKey:q.entry.cacheKey,baseline:q.baseline}));
  const source={...originalSource,sentences:targets.filter(t=>t.textHash===freshHash),
    reusedMediaReferences:reusedRefs,baselinePacks:[qualified[0].baseline],
    reusedSentences:targets.filter(t=>t.textHash===reuseHash).map(t=>({textHash:t.textHash,text:t.text,references:t.references,pairs:reusedRefs})),
    coverage:{requestedClipCount:4,generatedClipCount:2,reusedClipCount:2},
    publicationSelection:{kind:choice.kind,choiceProof:choicePin,legacySelectionSha256:choice.legacySelection.sha256,
      qualificationSha256:choice.legacyQualification.sha256},
  };
  const freshStats={lemmaCount:1,entryCount:2,recordedCount:0,synthesizedCount:2,failedCount:0};
  const manifest={...originalManifest,entries:fresh,sourceManifestSha256:'c'.repeat(64),statistics:freshStats};
  const descriptor={...freshStats,sourceManifestSha256:manifest.sourceManifestSha256};
  const request={packId:choice.packId,targets};
  return {choice,request,accepted,qualified,originalManifest,originalSource,source,manifest,descriptor,choicePin};
}
const partition=f=>partitionPublication(f.choice,f.originalManifest,f.accepted,f.qualified);
const metadata=f=>checkSelectedPublicationMetadata({...f,split:partition(f)});

test('whole-entry recipe agrees with independent Python numeric and Unicode vectors',()=>{
  assert.equal(publicationEntrySha256({count:1,label:'例句',qualityMetrics:{clippedSampleFraction:0.0,rmsDbfs:-20.0}}),
    '60035ee702c725f90e7ca517a119f3d08f73dd9403296cc20c7c35ef5a5c1815');
  assert.equal(publicationEntrySha256(0),'af61886518b0ec1da50e0b7e877a7e02cc7173f0becd9a994e1e5e661a16e3ee');
  assert.equal(publicationEntrySha256(-0),'a0f0e77097840a798730ef59e0a808403d9af8c8e52af53e42eb5de98f301701');
  assert.equal(publicationEntrySha256({'😀':1,'\uE000':2}),
    'c13787df458c8c1cd4afa4224befbb30329708bd4d3e34ac84693f0e2d854547');
});
test('typed records distinguish booleans, tags, array order and signed zero',()=>{
  assert.notEqual(publicationEntrySha256(false),publicationEntrySha256(0));
  assert.notEqual(publicationEntrySha256(['null']),publicationEntrySha256(null));
  assert.notEqual(publicationEntrySha256([1,2]),publicationEntrySha256([2,1]));
  assert.notEqual(publicationEntrySha256(0),publicationEntrySha256(-0));
  assert.equal(publicationEntrySha256({b:2,a:1}),publicationEntrySha256({a:1,b:2}));
});
test('nonfinite, unsafe, non-JSON and isolated surrogate values cannot obtain record hashes',()=>{
  for(const v of [NaN,Infinity,2**53,undefined,new Date(), '\ud800', {'\udfff':'bad key'}])
    assert.throws(()=>publicationEntrySha256(v),/selected_entry_/);
});
test('explicit partition preserves every original C record and generation count',()=>{
  const f=fixture(),before=structuredClone({accepted:f.accepted,manifest:f.originalManifest});
  const result=partition(f);
  assert.equal(result.fresh.size,2);assert.equal(result.removed.size,2);assert.equal(result.reused.size,2);
  assert.deepEqual({accepted:f.accepted,manifest:f.originalManifest},before);
  assert.equal(f.accepted.generatedPairs,4);assert.equal(f.accepted.media.length,4);
});
test('a projected or duplicated C media array cannot support a converted publication',()=>{
  for(const mutate of [
    f=>{f.accepted.media.pop();},f=>{f.accepted.generatedPairs=2;},
    f=>{f.accepted.media[1]={...f.accepted.media[0]};},
    f=>{f.originalManifest.entries[1]={...f.originalManifest.entries[0]};},
  ]) {const f=fixture();mutate(f);assert.throws(()=>partition(f),/selected_original_C_count_unchanged/);}
});
test('all original C cache, MP3 and original WAV identities remain bound even when not selected',()=>{
  for(const name of ['cacheKey','fileSha256','originalWavSha256']) {
    const f=fixture();f.accepted.media[3][name]='d'.repeat(64);
    assert.throws(()=>partition(f),/selected_original_C_entire_media_identity/);
  }
});
test('partial, overlapping or unsorted publication choices cannot silently drop a generated pair',()=>{
  for(const mutate of [
    f=>{f.choice.generatedNotSelectedPairs.pop();},
    f=>{f.choice.selectedFreshPairs.push(f.choice.generatedNotSelectedPairs[0]);f.choice.selectedFreshPairs=sort(f.choice.selectedFreshPairs);},
    f=>{f.choice.selectedFreshPairs.reverse();},
    f=>{delete f.choice.entryHashRecipe;},
  ]) {const f=fixture();mutate(f);assert.throws(()=>partition(f),/selected_/);}
});
test('a different old record, missing applicable qualified reuse or duplicate official authority is rejected',()=>{
  for(const mutate of [
    f=>{f.qualified[0].entry.qualityMetrics={clippedSampleFraction:0,rmsDbfs:-21};},
    f=>{f.choice.reusedOfficialPairs.pop();},
    f=>{f.qualified.push(structuredClone(f.qualified[0]));},
    f=>{f.choice.reusedOfficialPairs[0].officialEntrySha256='e'.repeat(64);},
  ]) {const f=fixture();mutate(f);assert.throws(()=>partition(f),/selected_/);}
});
test('converted metadata retains all original request references and generation provenance',()=>{
  const f=fixture(),before=structuredClone({source:f.originalSource,manifest:f.originalManifest});
  const result=metadata(f);assert.equal(result.fresh.length,2);assert.equal(result.reused.length,2);
  assert.deepEqual({source:f.originalSource,manifest:f.originalManifest},before);
  assert.deepEqual(f.source.requestedSentences,f.request.targets);
  assert.equal(f.descriptor.lemmaCount,1);assert.equal(f.request.targets.length,2);
});
test('original complete correction sidecar and C provenance cannot be rewritten by selection',()=>{
  for(const mutate of [
    f=>{f.source={...f.source,pronunciationReviews:{...f.source.pronunciationReviews,sha256:'f'.repeat(64)}};},
    f=>{f.source={...f.source,cloudBuildEvidence:{...f.source.cloudBuildEvidence,buildReceiptSha256:'f'.repeat(64)}};},
    f=>{f.manifest={...f.manifest,newUnverifiedMetadata:true};},
  ]) {const f=fixture();mutate(f);assert.throws(()=>metadata(f),/selected_original_/);}
});
test('reused complete current references, old file identity and baseline pins must remain exact',()=>{
  for(const mutate of [
    f=>{f.source.reusedMediaReferences=structuredClone(f.source.reusedMediaReferences);f.source.reusedMediaReferences[0].fileSha256='f'.repeat(64);},
    f=>{f.source.reusedSentences=structuredClone(f.source.reusedSentences);f.source.reusedSentences[0].references=[];},
    f=>{f.source.baselinePacks=[{...f.source.baselinePacks[0],sourceManifestSha256:'f'.repeat(64)}];},
    f=>{f.source.requestedSentences=f.source.sentences;},
  ]) {const f=fixture();mutate(f);assert.throws(()=>metadata(f),/selected_/);}
});
test('fresh media records, new descriptor counts and explicit choice pointer cannot be substituted',()=>{
  for(const mutate of [
    f=>{f.manifest.entries=structuredClone(f.manifest.entries);f.manifest.entries[0].qualityMetrics.rmsDbfs=-22;},
    f=>{f.descriptor.lemmaCount=2;},
    f=>{f.source.publicationSelection={...f.source.publicationSelection,choiceProof:{...f.choicePin,sha256:'f'.repeat(64)}};},
  ]) {const f=fixture();mutate(f);assert.throws(()=>metadata(f),/selected_/);}
});
