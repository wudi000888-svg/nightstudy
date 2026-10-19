#!/usr/bin/env python3
"""Synthetic metadata/quality boundaries; never actual reuse or media approval."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location('official_reuse_tests',Path(__file__).with_name('qualify-ci-legacy-sentence-reuse.py'))
q=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(q)
_,h,_,_=q.load_pure()


def metrics():
    return dict(peakAmplitude=15000,rmsDbfs=-20.0,clippedSampleFraction=0.0,decodedDurationSeconds=3.0,
        leadingSilenceSeconds=.1,trailingSilenceSeconds=.2)


def fixture():
    voices=dict(voices={a:dict(model={'sha256':'a'*64},config={'sha256':'b'*64}) for a in h.ACCENTS})
    rows=[]
    for number in range(16):
        text=f'This synthetic English sentence has fixture number {number}.';key=h.sha(text)
        word='fixture-word-'+str(number);sense='learning-sense-'+f'{number:064x}';example='sense-example-'+f'{number+32:064x}'
        body=dict(word=dict(wordId=word,normalizedLemma='fixture'),sense=dict(id=sense,wordId=word,
            contentVersion='fixture-current',bindingHash='c'*64,sourceBindings=[]),
            example=dict(id=example,wordId=word,learningSenseId=sense,exampleEn=text,exampleZh='合成边界测试例句。'))
        ref=dict(wordId=word,learningSenseId=sense,exampleId=example,contentVersion='fixture-current',
            bindingHash='c'*64,leafIndex=1,leafManifestSha256='d'*64,payloadSha256='e'*64,
            publicContextSha256=h.sha(h.canonical(body)),sourceBindingsSha256=h.sha(h.canonical([])))
        for accent in h.ACCENTS:
            base=dict(text=text,accent=accent,engine='1.8.0',generator='audio-v1',model='a'*64,config='b'*64)
            expected=dict(text=text,accent=accent,engineVersion='1.8.0',voiceModelSha256='a'*64,
                voiceConfigSha256='b'*64,cacheKey=h.sha(h.canonical(base,True)),
                pronunciationCorrectionSha256=None,pronunciationCorrectionId=None)
            entry=dict(expected,textHash=key,kind='synthesized',mimeType='audio/mpeg',sampleRate=22050,
                channels=1,sampleWidthBytes=2,fileSha256='f'*64,fileKey='files/'+'f'*64+'.mp3',sizeBytes=12000,
                decodedDurationSeconds=3.0,durationSeconds=3.0,qualityMetrics=dict(metrics(),policyVersion=1,
                    sampleRate=22050,channels=1,timeStretchApplied=False,silenceTrimApplied=False))
            rows.append(dict(text=text,textHash=key,accent=accent,currentPolicyProhibitsMedia=False,
                currentControl=dict(state='base-no-explicit-control',correctionSha256=None,correctionId=None,hold=None),
                currentReferencesAndContexts=copy.deepcopy([dict(reference=ref,publicContext=body)]),
                expectedCurrentSynthesisIdentity=expected,currentCacheIdentityRecipe=dict(baseInputs=base,
                    correctionSha256=None,correctionRenderPolicy=None,synthesisRoute='linux-original-text'),
                oldPublishedEntries=[dict(packId='sentence-audio-v1' if number<8 else 'sentence-audio-v2',entry=entry,
                    exactCurrentSynthesisIdentityMatches=True,missingIdentityFields=[],reuseApproved=False,
                    currentIdentityFieldMatches={k:True for k in expected})],plannedDecision=dict(decision='planned-fresh')))
    return rows,voices


class OfficialReuseBoundaries(unittest.TestCase):
    def test_actual_inventory_is_not_itself_reuse_approval(self):
        rows,_=fixture()
        report=dict(kind='nightstudy-ci-legacy-sentence-overlap-audit-v1',state='COMPLETE_CONFLICT_INVENTORY_ONLY',
            publicRootSha256=h.PUBLIC_SHA,finalPolicySha256=h.FINAL_SHA,
            summary=dict(currentGroups=99940,currentOverlapPairs=424,currentPairs=199880,currentReferences=99984,
                exactIdentityMatchingOldEntries=424,heldOverlapPairs=0,legacyEntries=36078,legacyNonCurrentPairs=35654,
                legacyUniquePairs=36078,oldCrossPackDuplicatePairs=0,plannedFreshOverlapPairs=32,preservedBaselineOverlapPairs=392),
            overlaps=rows+[dict(plannedDecision=dict(decision='published-baseline-exact-current-refs')) for _ in range(392)],
            modelImported=False,mediaDecoded=False,synthesisApproved=False,reuseApproved=False,
            supersessionApproved=False,publicationAuthorized=False)
        self.assertEqual(len(q.report_scope(h,report)),32)
        report['reuseApproved']=True
        with self.assertRaisesRegex(ValueError,'fixed_actual_legacy_overlap_inventory'):q.report_scope(h,report)

    def test_complete16_groups_keep_all32_current_refs(self):
        rows,voices=fixture()
        targets,selected=q.current_rows(h,rows,{},voices)
        self.assertEqual((len(targets),len(selected)),(16,32))
        self.assertTrue(all(len(t['references'])==1 and t['accents']==['US','UK'] for t in targets))

    def test_hold_or_new_control_refuses_before_any_media_lookup(self):
        rows,voices=fixture()
        with self.assertRaisesRegex(ValueError,'current_holds_and_risks_precede'):
            q.current_rows(h,rows,{rows[0]['textHash']:{'accents':{'US':{'state':'hold'}}}},voices)
        rows[0]['currentPolicyProhibitsMedia']=True
        with self.assertRaisesRegex(ValueError,'current_holds_and_risks_precede'):q.current_rows(h,rows,{},voices)

    def test_matching_text_hash_cannot_replace_full_current_engine_config_cache_identity(self):
        for field in ('voiceModelSha256','voiceConfigSha256','engineVersion','cacheKey','pronunciationCorrectionSha256'):
            rows,voices=fixture();rows[0]['oldPublishedEntries'][0]['entry'][field]='different'
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'exact_current_identity_not_text_hash_only'):
                q.current_rows(h,rows,{},voices)

    def test_changed_bilingual_body_or_missing_accent_is_not_current_full_scope(self):
        rows,voices=fixture();rows[0]['currentReferencesAndContexts'][0]['publicContext']['example']['exampleZh']='已被替换。'
        with self.assertRaisesRegex(ValueError,'complete_current_bilingual_body_digest'):q.current_rows(h,rows,{},voices)
        rows,voices=fixture()
        with self.assertRaisesRegex(ValueError,'complete16_dual_accent_current_targets'):q.current_rows(h,rows[:-1],{},voices)

    def test_quality_policy1_and_whole_duration_are_mandatory(self):
        rows,_=fixture();entry=rows[0]['oldPublishedEntries'][0]['entry']
        q.quality(h,entry,metrics())
        for field,value in (('policyVersion',2),('timeStretchApplied',True),('silenceTrimApplied',True)):
            changed=copy.deepcopy(entry);changed['qualityMetrics'][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'original_quality_policy1'):
                q.quality(h,changed,metrics())
        for change in (dict(decodedDurationSeconds=3.1),dict(clippedSampleFraction=.0101),dict(rmsDbfs=float('nan'))):
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'whole_official_decoded_duration|independent_complete_policy1_quality'):
                q.quality(h,entry,dict(metrics(),**change))

    def test_old_numeric_metrics_are_preserved_without_false_cross_decoder_reproduction_claim(self):
        rows,_=fixture();entry=rows[0]['oldPublishedEntries'][0]['entry'];before=copy.deepcopy(entry)
        result=q.quality(h,entry,dict(metrics(),peakAmplitude=15001))
        self.assertEqual(result['peakAmplitude'],dict(original=15000,current=15001,matches=False))
        self.assertEqual(entry,before)

    def test_only_all32_actual_eof_results_can_enable_reuse_and_never_claim_original_wavs(self):
        rows,_=fixture()
        results=[dict(textHash=r['textHash'],accent=r['accent'],fullMp3EofDecoded=True,
            originalWavRevalidated=False,originalWavAvailableInPublishedArchive=False) for r in rows]
        q.complete_qualification(h,results)
        for changed in (results[:-1],results[:-1]+[results[0]],
                [dict(results[0],fullMp3EofDecoded=False)]+results[1:],
                [dict(results[0],originalWavRevalidated=True)]+results[1:]):
            with self.assertRaisesRegex(ValueError,'all32_complete_eof_results_required_for_reuse'):
                q.complete_qualification(h,changed)


if __name__=='__main__':unittest.main()
