import copy
import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('learning_senses_compile', Path(__file__).with_name('learning-senses-compile.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class AtomicMeaningBoundaries(unittest.TestCase):
    def setUp(self):
        self.source = [dict(id='word-bank', normalizedLemma='bank', contentVersion='synthetic', sourceRef='pack:synthetic',
            senses=[dict(id='source-bank', wordId='word-bank', pos='n.', definitionZh='银行；河岸', definitionEn='',
                         contentMetadata={}, exampleEn='', exampleZh='')], examples=[])]
        self.draft = dict(lemma='bank', key='finance', pos='n.', definitionZh='银行',
            definitionEn='A financial institution.', ordinal=0,
            sources=[dict(pos='n.', definitionZh='银行；河岸', definitionEn='', relation='narrower',
                          reason='Synthetic split explicitly separates the financial meaning from the river edge.')],
            review=dict(decision='publish', reviewer='Codex', expertCertified=False,
                        semanticRationale='Synthetic review selects the financial meaning only.'),
            examples=[dict(context='存款', en='I opened an account at the bank.', zh='我在银行开了账户。',
                           semanticRationale='The account makes this a financial institution.'),
                      dict(context='贷款', en='The bank approved the loan.', zh='银行批准了贷款。',
                           semanticRationale='Approving a loan clearly concerns a financial institution.')])

    def compile(self, drafts=None):
        return c.compile_rows(self.source, drafts if drafts is not None else [self.draft], 'synthetic-v1')

    def test_explicit_narrower_binding_never_changes_source_or_reuses_word_examples(self):
        before = copy.deepcopy(self.source)
        row = self.compile()[0]
        self.assertEqual(self.source, before)
        self.assertEqual(row['senses'][0]['sourceBindings'][0]['sourceDefinitionEnSha256'], c.sha(''))
        self.assertEqual(len(row['senses'][0]['examples']), 2)
        self.assertEqual(row['senses'][0]['bindingHash'], c.binding_hash(row['senses'][0]))

    def test_only_explicit_reviewed_spelling_can_select_case_for_a_meaning(self):
        self.assertNotIn('orthography', self.compile()[0]['senses'][0]['contentMetadata'])
        for original, normalized, display in [('AM', 'am', 'am'), ('AM', 'am', 'AM'),
                ('Polish', 'polish', 'polish'), ('Polish', 'polish', 'Polish'),
                ('william', 'william', 'William')]:
            source=copy.deepcopy(self.source)
            source[0].update(lemma=original,normalizedLemma=normalized)
            draft=copy.deepcopy(self.draft)
            draft.update(lemma=normalized,displayLemma=display,
                displayLemmaReason='The author explicitly reviewed this spelling for the selected atomic meaning.')
            for example in draft['examples']:
                example['en']=example['en'].replace('bank',normalized)
            before=copy.deepcopy(source)
            sense=c.compile_rows(source,[draft],'case-fixture')[0]['senses'][0]
            meta=sense['contentMetadata']['orthography']
            self.assertEqual(source,before)
            self.assertEqual(meta,dict(displayLemma=display,normalizedLemma=normalized,
                displayLemmaSha256=c.sha(display),reviewer='Codex',decision='publish',
                expertCertified=False,reason=draft['displayLemmaReason']))

    def test_display_spelling_rejects_aliases_normalization_changes_and_unreviewed_values(self):
        for display in ['banks','BANK ','B ANK','ＢＡＮＫ','<bank>','Bank\n',None,7,[]]:
            draft=copy.deepcopy(self.draft);draft['displayLemma']=display
            with self.assertRaisesRegex(ValueError,'display_lemma_must_differ_only_in_case'):
                self.compile([draft])
        draft=copy.deepcopy(self.draft);draft.update(displayLemma='Bank',displayLemmaReason='short')
        with self.assertRaisesRegex(ValueError,'missing_display_lemma_review'):
            self.compile([draft])
        draft.pop('displayLemma')
        with self.assertRaisesRegex(ValueError,'orphan_display_lemma_reason'):
            self.compile([draft])

    def test_missing_drafts_create_gaps_instead_of_fabricated_meanings(self):
        rows = self.compile([])
        gaps, candidates = c.inventory(self.source, rows)
        self.assertEqual(rows, [])
        self.assertEqual(candidates, [])
        self.assertEqual(gaps[0]['status'], 'atomic-review-required')
        self.assertIsNone(gaps[0]['remainingAtomicMeaningCount'])

    def test_a_comma_pos_or_near_match_cannot_align_sources(self):
        self.draft['sources'][0]['definitionZh'] = '银行'
        with self.assertRaisesRegex(ValueError, 'ambiguous_or_changed_source'):
            self.compile()

    def test_empty_source_pos_is_hashed_and_drift_is_rejected(self):
        self.source[0]['senses'][0]['pos'] = ''
        with self.assertRaisesRegex(ValueError, 'ambiguous_or_changed_source'):
            self.compile()

    def test_matching_text_from_another_word_never_counts_as_source_evidence(self):
        self.source[0]['senses'][0]['wordId'] = 'another-word'
        with self.assertRaisesRegex(ValueError, 'cross_word_source_identity'):
            self.compile()

    def test_two_different_labels_do_not_allow_the_same_sentence(self):
        self.draft['examples'][1]['en'] = self.draft['examples'][0]['en']
        with self.assertRaisesRegex(ValueError, 'duplicate_sentence'):
            self.compile()

    def test_single_context_and_missing_surface_never_publish(self):
        self.draft['examples'][1]['context'] = '存款'
        with self.assertRaisesRegex(ValueError, 'two_distinct_contexts'):
            self.compile()
        self.draft['examples'][1]['context'] = '贷款'
        self.draft['examples'][1]['en'] = 'The company approved the loan.'
        with self.assertRaisesRegex(ValueError, 'target_surface_absent'):
            self.compile()

    def test_reviewed_abbreviation_punctuation_preserves_letters_and_is_not_an_inflection(self):
        self.source[0]['normalizedLemma'] = 'eg'
        self.draft['lemma'] = 'eg'
        for example in self.draft['examples']:
            example.update(en=example['en'].replace('bank', 'e.g.'),
                           surface='e.g.', surfaceKind='punctuation-variant')
        row = self.compile()[0]
        self.assertEqual(row['senses'][0]['examples'][0]['contentMetadata']['targetSurface']['kind'],
                         'punctuation-variant')
        for invalid in ['e..g.', 'eg', 'etc.', 'e-g', 'e g', 'ｅ.g.']:
            draft = copy.deepcopy(self.draft)
            for example in draft['examples']:
                example.update(en=example['en'].replace('e.g.', invalid), surface=invalid)
            with self.assertRaisesRegex(ValueError, 'invalid_punctuation_variant'):
                self.compile([draft])

    def test_old_sentence_stays_an_unbound_candidate(self):
        self.source[0]['examples'].append(dict(id='old', exampleEn='I sat on the bank.', exampleZh='我坐在河岸上。'))
        gaps, candidates = c.inventory(self.source, self.compile())
        self.assertEqual(gaps[0]['curatedLearningSenses'], 1)
        self.assertEqual(candidates[0]['status'], 'unbound-candidate')
        self.assertNotIn('learningSenseId', candidates[0])

    def test_editorial_queue_keeps_all_source_bytes_but_does_not_mark_a_word_complete(self):
        self.source[0]['focus'] = [dict(focusSenseId='source-bank', memberships=2)]
        self.source[0]['primarySenseId'] = 'source-bank'
        rows = self.compile()
        gaps, candidates = c.inventory(self.source, rows)
        queue = list(c.authoring_queue(self.source, rows, candidates))
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['sourceSenses'][0]['definitionZh'], '银行；河岸')
        self.assertEqual(queue[0]['sourceSenses'][0]['sourceDefinitionEnSha256'], c.sha(''))
        self.assertFalse(queue[0]['exhaustiveMeaningInventoryReviewed'])
        self.assertEqual(queue[0]['status'], 'partially-curated')
        self.assertEqual(queue[0]['focus'], self.source[0]['focus'])
        self.assertEqual(queue[0]['primarySenseId'], 'source-bank')

    def test_standard_single_parts_of_speech_are_supported_without_accepting_combined_labels(self):
        for pos in c.PARTS_OF_SPEECH:
            self.draft['pos'] = pos
            self.assertEqual(self.compile()[0]['senses'][0]['pos'], pos)
        self.draft['pos'] = 'adj./adv.'
        with self.assertRaisesRegex(ValueError, 'invalid_pos'):
            self.compile()

    def test_public_fields_keep_actual_source_license_and_translation_attribution(self):
        en = self.draft['definitionEn']
        self.draft['fieldSources'] = dict(definitionEn=dict(kind='corpus', license='WordNet-3.0',
            author='Synthetic source author', attribution='Synthetic source attribution for testing.',
            sourceName='Synthetic WordNet fixture', sourceUrl='https://example.org/fixture',
            sourceText=en, sourceTextSha256=c.sha(en), sourceSnapshotSha256='a'*64,
            licenseNoticeSha256='b'*64), definitionZh=dict(kind='original-authoring', license='MIT',
            author='NightStudy contributors'))
        meta = self.compile()[0]['senses'][0]['contentMetadata']
        self.assertEqual(meta['kind'], 'reviewed-public-content')
        self.assertEqual(meta['license'], 'mixed')
        self.assertEqual(meta['fieldSources']['definitionEn']['license'], 'WordNet-3.0')
        self.draft['fieldSources']['definitionEn']['sourceText'] += ' Unmatched.'
        with self.assertRaisesRegex(ValueError, 'public_source_text_mismatch'):
            self.compile()

    def test_public_provenance_needs_each_field_and_a_real_source_notice_pin(self):
        with self.assertRaisesRegex(ValueError, 'missing_field_provenance'):
            c.provenance_metadata(dict(exampleEn='An example.', exampleZh='一个例子。'), {})
        with self.assertRaisesRegex(ValueError, 'invalid_original_provenance'):
            c.provenance_metadata(dict(definitionEn='Original.'), dict(definitionEn=dict(
                kind='original-authoring', license='CC-BY-4.0', author='Synthetic author')))

    def test_independent_union_rejects_missing_words_and_cross_shard_repetition(self):
        rows = self.compile()
        required = [dict(wordId='word-bank', normalizedLemma='bank')]
        self.assertEqual(c.validate_collection_union(required, [(dict(id='learning-senses-one'), rows)]),
            c.word_union_hash(required))
        with self.assertRaisesRegex(ValueError, 'required_union_mismatch'):
            c.validate_collection_union(required + [dict(wordId='word-extra', normalizedLemma='extra')],
                [(dict(id='learning-senses-one'), rows)])
        with self.assertRaisesRegex(ValueError, 'word_crosses_shards'):
            c.validate_collection_union(required, [(dict(id='learning-senses-one'), rows),
                (dict(id='learning-senses-two'), rows)])

    def test_collection_preserves_immutable_baseline_and_requires_the_entire_pinned_target(self):
        first = self.compile()
        source = copy.deepcopy(self.source)
        bridge = copy.deepcopy(self.source[0]); bridge.update(id='word-bridge', normalizedLemma='bridge')
        bridge['senses'][0].update(id='source-bridge', wordId='word-bridge', definitionZh='桥梁', definitionEn='')
        source.append(bridge)
        draft = copy.deepcopy(self.draft); draft.update(lemma='bridge', key='structure', definitionZh='桥梁',
            definitionEn='A structure crossing water.', examples=[
                dict(context='通行', en='We crossed the bridge this morning.', zh='我们今天早上走过了那座桥。',
                     semanticRationale='Crossing it identifies the physical river structure.'),
                dict(context='维修', en='Workers repaired the bridge last week.', zh='工人们上周修好了那座桥。',
                     semanticRationale='Repair work concerns the physical crossing structure.')])
        draft['sources'][0]['definitionZh'] = '桥梁'
        second = c.compile_rows(source, [draft], 'new-content')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); old = root/'old'; old.mkdir(); out=root/'out'; out.mkdir()
            drafts=root/'drafts.json'; drafts.write_text('{}')
            source_bytes=b'synthetic pinned lexical source'; overlay_bytes=b'synthetic pinned overlay'
            manifest=c.leaf_report(source,first,source_bytes,overlay_bytes,[drafts],
                'learning-senses-baseline','synthetic-v1',old,[])
            baseline=old/'learning-senses-baseline.manifest.json'; before=baseline.read_bytes()
            target=root/'required.json'; target.write_text(json.dumps([
                dict(wordId=w['id'],normalizedLemma=w['normalizedLemma']) for w in source]))
            args=SimpleNamespace(required_words=str(target),required_words_sha256=c.sha(target.read_bytes()),
                collection_id='learning-senses-collection-test',version=None,baseline_manifest=[str(baseline)],
                shard_words=1,drafts=[drafts])
            collection,combined=c.emit_collection(source,second,source_bytes,overlay_bytes,args,out,[])
            self.assertEqual(collection['wordCount'],2)
            self.assertEqual(len(collection['shards']),2)
            self.assertEqual((out/baseline.name).read_bytes(),before)
            self.assertEqual((out/manifest['fileName']).read_bytes(),(old/manifest['fileName']).read_bytes())
            self.assertEqual(combined[1]['senses'][0]['bindingHash'],c.binding_hash(combined[1]['senses'][0]))
            empty=root/'incomplete';empty.mkdir()
            with self.assertRaisesRegex(ValueError, 'required_union_mismatch'):
                c.emit_collection(source,[],source_bytes,overlay_bytes,args,empty,[])
            self.assertFalse((empty/(args.collection_id+'.manifest.json')).exists())

    def test_new_original_source_is_deterministic_explicit_and_does_not_rewrite_old_rows(self):
        word=self.source[0]
        addition=c.original_source_addition(word,'river-edge','n.','河岸',
            'The land along the side of a river.','Original Codex source review separates the river edge from banking services.')
        self.assertEqual(addition['id'],'learning-source-'+c.sha(word['id']+'\0river-edge'))
        self.assertEqual(addition['contentMetadata']['evidenceKind'],'codex-original-source-addition')
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'sources.jsonl';path.write_text(c.canonical(addition)+'\n')
            before=copy.deepcopy(self.source)
            source,added=c.append_source_additions(self.source,path,c.sha(path.read_bytes()))
            self.assertEqual(self.source,before)
            self.assertEqual(source[0]['senses'][0],before[0]['senses'][0])
            draft=copy.deepcopy(self.draft);draft.update(key='river-edge',definitionZh=addition['definitionZh'],
                definitionEn=addition['definitionEn'],sources=[dict(pos='n.',definitionZh=addition['definitionZh'],
                    definitionEn=addition['definitionEn'],relation='exact',reason='Explicitly bind the separately authored river-edge source, not a dictionary claim.')],
                examples=[dict(context='钓鱼',en='We sat on the bank while waiting for the fish.',zh='我们坐在河岸上等鱼上钩。',
                    semanticRationale='Waiting beside the river clearly identifies the land at the water edge.'),
                  dict(context='河岸修复',en='Volunteers planted trees along the bank of the river.',zh='志愿者沿河岸种树。',
                    semanticRationale='Planting beside the river concerns its land edge rather than finance.')])
            rows=c.compile_rows(source,[draft],'source-addition-fixture')
            binding=rows[0]['senses'][0]['sourceBindings'][0]
            self.assertEqual(binding['sourceSenseId'],addition['id'])
            self.assertEqual(binding['contentMetadata']['sourceVersion'],'codex-original-source-v1')
            drafts=Path(temp)/'drafts.json';drafts.write_text('{}')
            report=c.leaf_report(source,rows,b'source',b'overlay',[drafts],'learning-senses-test-additions',
                'source-addition-fixture',Path(temp),[],added)
            pin=report['sourceAdditions'];packed=(Path(temp)/pin['fileName']).read_bytes()
            self.assertEqual(c.sha(packed),pin['sha256'])
            decoded=c.gzip.decompress(packed)
            self.assertEqual(c.sha(decoded),pin['jsonlSha256'])
            self.assertEqual(json.loads(decoded),addition)
            with patch.object(c,'MAX_BYTES',len(c.canonical(rows[0]).encode('utf-8'))+len(decoded)):
                with self.assertRaisesRegex(ValueError,'source_additions_decoded_limit'):
                    c.leaf_report(source,rows,b'source',b'overlay',[drafts],'learning-senses-small-limit',
                        'source-addition-fixture',Path(temp),[],added)


    def test_source_additions_reject_checksum_drift_false_license_and_inactive_words(self):
        addition=c.original_source_addition(self.source[0],'explicit-source','n.','明确来源义',
            'An explicitly authored synthetic meaning.','Specific Codex source review confirms this original synthetic definition.')
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'sources.jsonl';path.write_text(c.canonical(addition)+'\n')
            with self.assertRaisesRegex(ValueError,'input_checksum'):
                c.append_source_additions(self.source,path,'0'*64)
            addition['contentMetadata']['license']='CC-BY-4.0'
            path.write_text(c.canonical(addition)+'\n')
            with self.assertRaisesRegex(ValueError,'identity_or_metadata'):
                c.append_source_additions(self.source,path,c.sha(path.read_bytes()))
            addition['contentMetadata']['license']='MIT';addition['definitionEn']+=' Changed.'
            path.write_text(c.canonical(addition)+'\n')
            with self.assertRaisesRegex(ValueError,'identity_or_metadata'):
                c.append_source_additions(self.source,path,c.sha(path.read_bytes()))
            addition['normalizedLemma']='missing';path.write_text(c.canonical(addition)+'\n')
            with self.assertRaisesRegex(ValueError,'word_not_active'):
                c.append_source_additions(self.source,path,c.sha(path.read_bytes()))

    def test_compressed_pack_has_a_fixed_portable_header_and_no_time(self):
        raw = 'Original bilingual fixture 原创。\n'.encode()
        packed = c.pack_bytes(raw)
        self.assertEqual(packed, c.pack_bytes(raw))
        self.assertEqual(packed[4:8], b'\0\0\0\0')
        self.assertEqual(packed[9], 255)
        self.assertEqual(c.gzip.decompress(packed), raw)

    def test_authored_pack_has_unique_meaning_and_semantic_review_for_every_sentence(self):
        drafts = c.load_drafts(Path(__file__).parents[1] / 'data/learning-senses-authored.json')
        self.assertGreaterEqual(len(drafts), 44)
        self.assertTrue(all(len(d['examples']) >= 2 for d in drafts))
        self.assertTrue(all(d['review']['expertCertified'] is False for d in drafts))

    def test_heteronym_policy_never_claims_unverified_word_audio_is_compatible(self):
        path = Path(__file__).parents[1] / 'data/learning-senses-authored-batch2.json'
        drafts = c.load_drafts(path)
        marked = [d for d in drafts if d['lemma'] in ('record', 'present')]
        self.assertEqual(len(marked), 6)
        self.assertTrue(all(d['pronunciation']['wordAudioCompatible'] is False for d in marked))
        drafts.extend(c.load_drafts(Path(__file__).parents[1] / 'data/learning-senses-authored-batch3.json'))
        all_heteronyms = [d for d in drafts if d['lemma'] in ('record', 'present', 'address', 'subject')]
        self.assertEqual(len(all_heteronyms), 12)
        self.assertTrue(all(d['pronunciation']['wordAudioCompatible'] is False for d in all_heteronyms))
        self.draft['pronunciation'] = dict(wordAudioCompatible=True,
            reason='Synthetic unsupported claim must never enable an unverified recording.')
        with self.assertRaisesRegex(ValueError, 'unsupported_pronunciation_policy'):
            self.compile()


if __name__ == '__main__':
    unittest.main()
