#!/usr/bin/env python3
"""Model-free publication partition regressions; synthetic inputs never publish."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location('publication_partition_tests',Path(__file__).with_name('select-ci-sentence-audio-publication.py'))
s=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(s)
_,h,_=s.load_contract()


def fixture():
    voices=dict(voices={a:dict(model={'sha256':'a'*64},config={'sha256':'b'*64}) for a in h.ACCENTS})
    targets=[];entries=[];approved={}
    for number in range(2):
        text=f'This is a synthetic publication example number {number}.';key=h.sha(text)
        refs=[dict(learningSenseId='sense-'+str(number),exampleId='example-'+str(number))]
        targets.append(dict(textHash=key,text=text,references=refs,accents=['US','UK']))
        for accent in h.ACCENTS:
            entry=dict(text=text,textHash=key,accent=accent,cacheKey=h.sha(text+accent),
                fileSha256=h.sha(text+accent+'fresh'),originalFileSha256=h.sha(text+accent+'WAV'),
                engineVersion='1.8.0',voiceModelSha256='a'*64,voiceConfigSha256='b'*64,kind='synthesized',
                mimeType='audio/mpeg',sizeBytes=12345)
            entry['fileKey']='files/'+entry['fileSha256']+'.mp3';entries.append(entry)
            if number==0:
                old=dict(entry,fileSha256=h.sha(text+accent+'official'))
                old['fileKey']='files/'+old['fileSha256']+'.mp3'
                baseline=dict(id='sentence-audio-v1',manifestSha256='c'*64,sourceManifestSha256='d'*64)
                approved[key,accent]=dict(text=text,entry=old,baseline=baseline,
                    officialDescriptor=dict(descriptor=dict(manifestSha256='c'*64,sourceManifestSha256='d'*64)),
                    expectedCurrentSynthesisIdentity=dict(cacheKey=old['cacheKey']),
                    currentReferencesAndContexts=[dict(reference=ref) for ref in refs])
    request=dict(targets=targets)
    accepted=dict(generatedPairs=4,media=[dict(textHash=e['textHash'],accent=e['accent'],cacheKey=e['cacheKey'],
        fileSha256=e['fileSha256'],originalWavSha256=e['originalFileSha256']) for e in entries])
    return request,accepted,dict(entries=entries),approved,voices


class PublicationChoiceTests(unittest.TestCase):
    def test_original_generation_stays_four_pairs_while_publication_partitions_two_and_two(self):
        request,check,manifest,approved,voices=fixture();before=copy.deepcopy((check,manifest,approved))
        selected,reused,fresh,old,omitted=s.partition(h,request,check,manifest,approved,voices)
        self.assertEqual((len(selected),len(reused),len(fresh),len(old),len(omitted)),(2,2,2,2,2))
        self.assertEqual({(r['textHash'],r['accent']) for r in old},{(r['textHash'],r['accent']) for r in omitted})
        self.assertEqual((check,manifest,approved),before)

    def test_no_overlap_returns_original_entries_unchanged_and_no_reuse_or_omission(self):
        request,check,manifest,_,voices=fixture()
        selected,reused,_,old,omitted=s.partition(h,request,check,manifest,{},voices)
        self.assertEqual(selected,sorted(manifest['entries'],key=lambda e:(e['textHash'],e['accent'])))
        self.assertEqual((reused,old,omitted),([],[],[]))

    def test_same_text_cannot_reuse_different_cache_model_config_or_current_refs(self):
        for field in ('cacheKey','voiceModelSha256','voiceConfigSha256'):
            request,check,manifest,approved,voices=fixture();item=next(iter(approved.values()))
            item['entry'][field]='different'
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'qualified_current_full_reference_and_identity_match'):
                s.partition(h,request,check,manifest,approved,voices)
        request,check,manifest,approved,voices=fixture()
        next(iter(approved.values()))['currentReferencesAndContexts'][0]['reference']={'exampleId':'different'}
        with self.assertRaisesRegex(ValueError,'qualified_current_full_reference_and_identity_match'):
            s.partition(h,request,check,manifest,approved,voices)

    def test_missing_or_duplicate_original_generated_entry_is_not_a_publication_choice(self):
        for mutate in (lambda m:m['entries'].pop(),lambda m:m['entries'].__setitem__(1,copy.deepcopy(m['entries'][0]))):
            request,check,manifest,approved,voices=fixture();mutate(manifest)
            with self.assertRaisesRegex(ValueError,'complete_original_generation_pair_set'):
                s.partition(h,request,check,manifest,approved,voices)

    def test_both_entry_hashes_are_full_records_and_do_not_drop_metadata(self):
        request,check,manifest,approved,voices=fixture()
        selected,reused,fresh,old,omitted=s.partition(h,request,check,manifest,approved,voices)
        generated={(e['textHash'],e['accent']):e for e in manifest['entries']}
        for row in fresh+omitted:
            self.assertEqual(row['originalGeneratedEntrySha256'],s.full_entry_sha(h,generated[row['textHash'],row['accent']]))
        for row in old:
            self.assertEqual(row['officialEntrySha256'],s.full_entry_sha(h,approved[row['textHash'],row['accent']]['entry']))
        self.assertTrue(all(set(r)=={'textHash','accent','fileKey','fileSha256','mimeType','sizeBytes','kind','cacheKey','baseline'} for r in reused))

    def test_reused_plus_selected_plus_held_covers_every_requested_accent_exactly_once(self):
        request,check,manifest,approved,voices=fixture()
        selected,reused,_,_,_=s.partition(h,request,check,manifest,approved,voices)
        self.assertEqual(s.coverage(h,request,selected,reused,{}),dict(requestedSentenceCount=2,requestedClipCount=4,
            generatedClipCount=2,reusedClipCount=2,fullyReusedSentenceCount=1,partiallyReusedSentenceCount=0,
            heldClipCount=0,heldSentenceCount=0,fullyHeldSentenceCount=0,eligibleClipCount=4))
        held_key=next(iter(approved))
        with self.assertRaisesRegex(ValueError,'selected_fresh_official_reused_held_exact_coverage'):
            s.coverage(h,request,selected,reused,{held_key:{}})
        with self.assertRaisesRegex(ValueError,'selected_fresh_official_reused_held_exact_coverage'):
            s.coverage(h,request,selected,reused[:-1],{})

    def test_different_official_manifest_binding_does_not_masquerade_as_approved_baseline(self):
        request,check,manifest,approved,voices=fixture()
        next(iter(approved.values()))['baseline']['manifestSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'qualified_current_full_reference_and_identity_match'):
            s.partition(h,request,check,manifest,approved,voices)

    def test_incomplete_or_unapproved_qualification_refuses_before_package_work(self):
        for value in ({},dict(kind='nightstudy-ci-official-legacy-reuse-qualification-v1',state='COMPLETE_CONFLICT_INVENTORY_ONLY')):
            with self.assertRaises((ValueError,KeyError)):
                s.qualification(h,value,{},dict(bytes=123,sha256='a'*64))

    def test_full_entry_cross_language_number_and_unicode_vectors(self):
        value=dict(count=1,label='例句',qualityMetrics=dict(clippedSampleFraction=0.0,rmsDbfs=-20.0))
        self.assertEqual(s.full_entry_sha(h,value),'60035ee702c725f90e7ca517a119f3d08f73dd9403296cc20c7c35ef5a5c1815')
        self.assertEqual(s.full_entry_sha(h,0.0),'af61886518b0ec1da50e0b7e877a7e02cc7173f0becd9a994e1e5e661a16e3ee')
        self.assertEqual(s.full_entry_sha(h,0),s.full_entry_sha(h,0.0))
        self.assertEqual(s.full_entry_sha(h,-0.0),'a0f0e77097840a798730ef59e0a808403d9af8c8e52af53e42eb5de98f301701')
        self.assertEqual(s.full_entry_sha(h,{'😀':1,'\ue000':2}),
            'c13787df458c8c1cd4afa4224befbb30329708bd4d3e34ac84693f0e2d854547')
        for invalid in (float('nan'),float('inf'),2**53):
            with self.subTest(invalid=invalid),self.assertRaisesRegex(ValueError,'entry_hash_finite_safe_number'):
                s.full_entry_sha(h,invalid)
        deep=None
        for _ in range(129):deep=[deep]
        with self.assertRaisesRegex(ValueError,'entry_hash_depth'):
            s.full_entry_sha(h,deep)


if __name__=='__main__':unittest.main()
