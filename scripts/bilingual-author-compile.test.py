import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('author_compile', Path(__file__).with_name('bilingual-author-compile.py'))
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)


class AuthoringBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.source = [dict(id='word-window', normalizedLemma='window', sourceRef='pack:synthetic',
            contentVersion='synthetic',primarySenseId='sense-window',examples=[],senses=[dict(
                id='sense-window',wordId='word-window',pos='',definitionZh='窗户；窗口',definitionEn='',
                exampleEn='',exampleZh='',ordinal=0,contentMetadata={})])]
        self.inputs = {'window':dict(needD=True,needE=True)}
        self.drafts = {'window':dict(w='window',d='An opening in a wall; an interface area on a screen.',p='n.',
            e=dict(en='The kitchen window faces the garden.',z='厨房的窗户朝向花园。'))}
        self.reviews = dict(withdrawals={},overrides={},surfaces=[])

    def compile(self, **changes):
        args=dict(source=self.source,drafts=self.drafts,inputs=self.inputs,ledger={},reviews=self.reviews,
                  overlays=[],extra_definitions=[])
        args.update(changes)
        return compiler.compile_rows(**args)

    def test_missing_text_is_pending_and_never_generated_from_a_template(self):
        rows,audio,stats=self.compile(drafts={})
        self.assertEqual(rows[0]['senses'],[])
        self.assertEqual(rows[0]['examples'],[])
        self.assertEqual(audio,[])
        self.assertEqual(stats['pending'],[dict(w='window',reason='not_authored')])

    def test_preserves_complete_authored_text_and_binds_each_source(self):
        rows,audio,stats=self.compile()
        patch=rows[0]['senses'][0]
        self.assertEqual(patch['definitionEn'],self.drafts['window']['d'])
        self.assertEqual(patch['contentMetadata']['definitionEn']['sourceTextSha256'],compiler.sha('窗户；窗口'))
        self.assertEqual(patch['sourceDefinitionZhSha256'],compiler.sha('窗户；窗口'))
        self.assertEqual(audio[0]['exampleEn'],self.drafts['window']['e']['en'])
        self.assertEqual(stats['pending'],[])

    def test_corpus_english_and_attribution_are_unchanged_when_codex_translates(self):
        text='Please close the window.'
        provenance=dict(kind='corpus',author='Synthetic owner',license='CC-BY-2.0-FR',
                        sourceTextSha256=compiler.sha(text),sourceSentenceId='synthetic-1')
        candidate=dict(exampleEn=text,exampleZh='',contentMetadata=dict(exampleEn=provenance))
        draft=copy.deepcopy(self.drafts)
        draft['window']['e']=dict(j=0,z='请关上窗户。')
        inputs=copy.deepcopy(self.inputs);inputs['window']['c']=[dict(j=0,en=text)]
        rows,audio,_=self.compile(drafts=draft,inputs=inputs,ledger={'window':[candidate]})
        result=rows[0]['examples'][0]
        self.assertEqual(result['exampleEn'],text)
        self.assertEqual(result['contentMetadata']['exampleEn'],provenance)
        zh=result['contentMetadata']['exampleZh']
        self.assertEqual(zh['sourceTextSha256'],compiler.sha(text))
        self.assertEqual(zh['translatedFrom'],provenance)
        self.assertEqual(audio[0]['source']['author'],'Synthetic owner')

    def test_rejects_a_corpus_text_whose_hash_no_longer_matches(self):
        draft=copy.deepcopy(self.drafts);draft['window']['e']=dict(j=0,z='请关上窗户。')
        inputs=copy.deepcopy(self.inputs);inputs['window']['c']=[dict(j=0,en='Please close the window.')]
        with self.assertRaisesRegex(ValueError,'corpus_english_hash'):
            self.compile(drafts=draft,inputs=inputs,ledger={'window':[dict(exampleEn='Please close the window.',
                exampleZh='',contentMetadata=dict(exampleEn=dict(sourceTextSha256='0'*64)))]})

    def test_rejects_self_consistent_ledger_drift_from_the_reviewed_sentence(self):
        draft=copy.deepcopy(self.drafts);draft['window']['e']=dict(j=0,z='窗户关着。')
        inputs=copy.deepcopy(self.inputs);inputs['window']['c']=[dict(j=0,en='The window is closed.')]
        changed='The window is open.'
        candidate=dict(exampleEn=changed,contentMetadata=dict(exampleEn=dict(sourceTextSha256=compiler.sha(changed))))
        with self.assertRaisesRegex(ValueError,'reviewed_candidate_changed'):
            self.compile(drafts=draft,inputs=inputs,ledger={'window':[candidate]})

    def test_rejects_changed_public_translation_even_when_its_hash_matches(self):
        draft=copy.deepcopy(self.drafts);draft['window']['e']=dict(j=0)
        en='The window is closed.';changed='窗户开着。'
        inputs=copy.deepcopy(self.inputs);inputs['window']['c']=[dict(j=0,en=en,zh='窗户关着。')]
        candidate=dict(exampleEn=en,exampleZh=changed,contentMetadata=dict(
            exampleEn=dict(sourceTextSha256=compiler.sha(en)),exampleZh=dict(sourceTextSha256=compiler.sha(changed))))
        with self.assertRaisesRegex(ValueError,'reviewed_candidate_translation_changed'):
            self.compile(drafts=draft,inputs=inputs,ledger={'window':[candidate]})

    def test_will_not_adopt_a_surface_without_independent_review(self):
        draft=copy.deepcopy(self.drafts)
        draft['window']['e']=dict(en='The windows face the garden.',z='这些窗户朝向花园。',surface='windows')
        rows,audio,stats=self.compile(drafts=draft)
        self.assertEqual(rows[0]['examples'],[])
        self.assertEqual(audio,[])
        self.assertEqual(len(stats['unreviewedSurfaces']),1)
        reviews=copy.deepcopy(self.reviews)
        reviews['surfaces']=[dict(lemma='window',surface='windows',kind='inflected-form')]
        rows,_,stats=self.compile(drafts=draft,reviews=reviews)
        self.assertEqual(rows[0]['examples'][0]['targetSurface']['form'],'windows')
        self.assertEqual(stats['unreviewedSurfaces'],[])

    def test_usage_overlay_becomes_a_separate_corrected_sense_not_an_unmarked_source_translation(self):
        view=dict(normalizedLemma='window',senseId='sense-window',sourceTextSha256=compiler.sha('窗户；窗口'),
            definitionZh='经校对的独立合成释义',definitionEn='An independently corrected synthetic definition.',
            reason='Synthetic source register defect.',usageEvidenceUrl='https://example.invalid/synthetic')
        rows,_,_=self.compile(overlays=[view])
        self.assertEqual(rows[0]['senses'],[])
        correction=rows[0]['corrections'][0]
        self.assertEqual(correction['replacesSenseId'],'sense-window')
        self.assertEqual(correction['definitionEn'],view['definitionEn'])
        self.assertEqual(correction['sourceDefinitionZhSha256'],view['sourceTextSha256'])
        self.assertEqual(self.source[0]['senses'][0]['definitionZh'],'窗户；窗口')

    def test_withdrawal_does_not_forge_examples_or_rewrite_the_source(self):
        reviews=copy.deepcopy(self.reviews)
        reviews['withdrawals']['window']=dict(reason='Synthetic malformed entry.',evidenceUrls=[])
        rows,audio,stats=self.compile(reviews=reviews,drafts={})
        self.assertEqual(rows[0]['senses'],[])
        self.assertEqual(rows[0]['examples'],[])
        self.assertEqual(rows[0]['defaultBookWithdrawal']['sourceSenseId'],'sense-window')
        self.assertEqual(stats['pending'],[])
        self.assertEqual(audio,[])

    def test_source_bound_exclusions_never_supply_audio_or_example_coverage(self):
        source=copy.deepcopy(self.source)
        sense=source[0]['senses'][0]
        sense.update(exampleEn='This poisoned window sentence is held.',exampleZh='被隔离的测试例句。')
        sense['contentMetadata']={'lexicalQuality':dict(excludeFromLearning=True,
            field='definitionZh',sourceTextSha256=compiler.sha(sense['definitionZh']))}
        rows,audio,_=self.compile(source=source)
        self.assertEqual(len(audio),1)
        self.assertEqual(audio[0]['exampleEn'],self.drafts['window']['e']['en'])
        # An obsolete hash cannot hide independently changed source content.
        sense['definitionZh']='已变化的源文'
        sense['contentMetadata']['exampleEn']={'license':'MIT','author':'Synthetic fixture'}
        _,audio,_=self.compile(source=source)
        self.assertEqual(len(audio),2)

    def test_correction_requires_a_new_example_if_it_retires_the_only_valid_one(self):
        source=copy.deepcopy(self.source)
        source[0]['senses'][0].update(exampleEn='The window faces north.',exampleZh='窗户朝北。')
        draft={'window':dict(w='window',x=dict(z='新测试义',d='An independently corrected fixture.',
            p='n.',why='Synthetic source error.'))}
        rows,audio,stats=self.compile(source=source,drafts=draft,inputs={'window':dict(needD=True,needE=False)})
        self.assertEqual(audio,[])
        self.assertEqual(stats['pending'],[dict(w='window',reason='correction_retires_only_bilingual_example')])
        draft['window']['e']=self.drafts['window']['e']
        _,audio,stats=self.compile(source=source,drafts=draft,inputs={'window':dict(needD=True,needE=False)})
        self.assertEqual(stats['pending'],[])
        self.assertEqual(len(audio),1)

    def test_catalog_proof_restricts_only_explicit_withdrawals_and_keeps_ordinals(self):
        source=dict(books=[dict(id='book',slug='book',goal='daily',kind='words',version='fixture',
            items=[[0,'alpha'],[1,'bad-token'],[2,'beta']])])
        proof=compiler.catalog_proof(source,dict(withdrawals={'bad-token':{}}))
        book=proof['books'][0]
        self.assertEqual(proof['sourceBookItems'],3)
        self.assertEqual(proof['activeBookItems'],2)
        self.assertEqual(book['withdrawnLemmas'],['bad-token'])
        self.assertEqual(book['itemsSha256'],compiler.sha('[[0,"alpha"],[2,"beta"]]'))

    def test_fills_original_seed_example_translation_without_replacing_english(self):
        source=copy.deepcopy(self.source)
        source[0]['senses'][0]['exampleEn']='The window faces north.'
        extra=dict(w='window',id='sense-window',en='The window faces north.',z='窗户朝北。',
            englishSource=dict(kind='original-authoring',license='MIT',author='NightStudy contributors',
                               sourceTextSha256=compiler.sha('The window faces north.')))
        rows,audio,stats=self.compile(source=source,extra_examples=[extra])
        patch=rows[0]['senses'][0]
        self.assertEqual(patch['exampleZh'],'窗户朝北。')
        self.assertNotIn('exampleEn',patch)
        self.assertEqual(patch['contentMetadata']['exampleZh']['sourceTextSha256'],compiler.sha(extra['en']))
        self.assertEqual(stats['exampleFields'],1)
        self.assertEqual(audio[0]['source'],dict(extra['englishSource']))

    def test_corrects_a_known_public_translation_without_changing_its_english_audio_identity(self):
        source=copy.deepcopy(self.source);en='The window is closed.'
        provenance=dict(kind='corpus',author='Synthetic owner',license='MIT',sourceTextSha256=compiler.sha(en))
        source[0]['examples']=[dict(id='existing-example',wordId='word-window',exampleEn=en,exampleZh='窗户开着。',
            ordinal=0,contentMetadata=dict(exampleEn=provenance,exampleZh=dict(kind='corpus')))]
        reviews=copy.deepcopy(self.reviews);reviews['exampleCorrections']={'window':[dict(id='existing-example',z='窗户关着。',why='Synthetic polarity error.')]}
        rows,audio,stats=self.compile(source=source,reviews=reviews)
        patch=rows[0]['exampleCorrections'][0]
        self.assertNotIn('exampleEn',patch)
        self.assertEqual(patch['sourceExampleZhSha256'],compiler.sha('窗户开着。'))
        self.assertEqual(audio[0]['exampleZh'],'窗户关着。')
        self.assertEqual(audio[0]['source'],provenance)
        self.assertEqual(source[0]['examples'][0]['exampleZh'],'窗户开着。')
        self.assertEqual(stats['exampleTranslations'],1)

    def test_replacement_english_is_authored_and_cannot_target_a_different_word(self):
        source=copy.deepcopy(self.source);source[0]['examples']=[dict(id='existing-example',wordId='word-window',
            exampleEn='The window is closed.',exampleZh='窗户关着。',ordinal=0,
            contentMetadata=dict(exampleEn=dict(kind='corpus',author='Fixture',license='MIT')))]
        reviews=copy.deepcopy(self.reviews);reviews['exampleCorrections']={'window':[dict(id='existing-example',
            en='The window overlooks a lake.',z='窗户面朝湖泊。',why='Independent replacement fixture.')]}
        rows,audio,_=self.compile(source=source,reviews=reviews)
        self.assertEqual(rows[0]['exampleCorrections'][0]['exampleEn'],'The window overlooks a lake.')
        self.assertEqual(audio[0]['source']['kind'],'original-authoring')
        reviews['exampleCorrections']['window'][0]['en']='A different object overlooks a lake.'
        with self.assertRaisesRegex(ValueError,'corrected_example_missing_word'):
            self.compile(source=source,reviews=reviews)

    def test_nonprimary_bilingual_focus_can_receive_only_pos_without_changing_audio(self):
        source=copy.deepcopy(self.source)
        extra=dict(id='other-sense',wordId='word-window',pos='',definitionZh='窗口',
            definitionEn='An interface area on a screen.',exampleEn='',exampleZh='',ordinal=1,contentMetadata={})
        source[0]['senses'].append(extra)
        reviews=copy.deepcopy(self.reviews);reviews['sensePositions']={'window':[dict(id='other-sense',p='n.')]}
        rows,audio,stats=self.compile(source=source,reviews=reviews)
        baseline_audio=self.compile(source=source)[1]
        patch=next(p for p in rows[0]['senses'] if p['id']=='other-sense')
        self.assertEqual(set(patch),{'id','pos','sourceDefinitionZhSha256','contentMetadata'})
        self.assertEqual(patch['sourceDefinitionZhSha256'],compiler.sha('窗口'))
        self.assertEqual(patch['contentMetadata']['pos']['sourceTextSha256'],compiler.sha('窗口'))
        self.assertEqual(stats['posFields'],2)
        self.assertEqual(audio,baseline_audio)
        self.assertEqual(extra['pos'],'')

    def test_pos_merges_into_existing_extra_definition_without_duplicate_sense_patch(self):
        source=copy.deepcopy(self.source);extra=copy.deepcopy(source[0]['senses'][0])
        extra.update(id='other-sense',ordinal=1,definitionZh='屏幕窗口');source[0]['senses'].append(extra)
        reviews=copy.deepcopy(self.reviews);reviews['sensePositions']={'window':[dict(id='other-sense',p='n.')]}
        rows,_,stats=self.compile(source=source,reviews=reviews,extra_definitions=[dict(w='window',id='other-sense',d='An interface area on a screen.')])
        patches=[p for p in rows[0]['senses'] if p['id']=='other-sense']
        self.assertEqual(len(patches),1);self.assertEqual(patches[0]['pos'],'n.')
        self.assertIn('definitionEn',patches[0]);self.assertEqual(stats['posFields'],2)

    def test_source_pos_is_bound_to_an_empty_public_sense_and_explicit_authoring(self):
        reviews=copy.deepcopy(self.reviews);reviews['sensePositions']={'window':[dict(id='missing',p='n.')]}
        with self.assertRaisesRegex(ValueError,'position_source_not_empty_or_unknown'):
            self.compile(reviews=reviews)
        reviews['sensePositions']['window'][0]['id']='sense-window'
        with self.assertRaisesRegex(ValueError,'position_already_authored'):
            self.compile(reviews=reviews)
        drafts=copy.deepcopy(self.drafts);drafts['window'].pop('p')
        reviews['sensePositions']['window']*=2
        with self.assertRaisesRegex(ValueError,'duplicate_sense_position'):
            self.compile(drafts=drafts,reviews=reviews)
        reviews['sensePositions']['window']=reviews['sensePositions']['window'][:1]
        source=copy.deepcopy(self.source);source[0]['senses'][0]['contentMetadata']['pos']={'kind':'site-authored'}
        with self.assertRaisesRegex(ValueError,'position_source_site_authored'):
            self.compile(source=source,drafts=drafts,reviews=reviews)



if __name__=='__main__':
    unittest.main()
