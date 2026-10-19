#!/usr/bin/env python3
"""Synthetic explicit-map boundaries, without runtime media or publication."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location('stage_maps',Path(__file__).with_name('prepare-ci-sentence-audio-publication.py'))
s=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(s)


def pin(name):return dict(fileName='stage/'+name,bytes=123,sha256='a'*64)


def fixture():
    return dict(sliceNumber=4,packId='sentence-audio-v4-0104',request=pin('request.json'),check=pin('check.json'),
        generation=dict(build=pin('build.json'),manifest=dict(fileName='manifest.json',bytes=5,sha256='b'*64),
            sources=dict(fileName='sources.manifest.json',bytes=6,sha256='c'*64)),
        candidate={k:pin(k+'.json') for k in ('descriptor','archive','manifest','sources','assembly','installerCheck')})


def converted(batch):
    selected={k:pin(k+'.json') for k in ('descriptor','archive','manifest','sources','choice','installerCheck')}
    receipt=dict(kind='nightstudy-ci-sentence-publication-conversion-v1',packId=batch['packId'],mode='legacy-reuse-conversion',
        state='CONVERTED_REQUIRES_SELECTED_INSTALLER_CHECK',generationProofUnchanged=True,publicationAuthorized=False,
        converterSourceSha256=s.CONVERTER_SHA,originalCandidate=s.converter_candidate(batch),
        selectedPublication={k:{**selected[k],'fileName':Path(selected[k]['fileName']).name} for k in ('descriptor','archive','manifest','sources')},
        choiceProof={**selected['choice'],'fileName':'choice.json'},originalArchivesModified=False,modelUsed=False,mediaDecodedHere=False)
    return receipt,selected


class StageMappingTests(unittest.TestCase):
    def test_prepare_renames_only_installer_and_keeps_declared_generation_unmodified(self):
        batch=fixture();before=copy.deepcopy(batch)
        result=s.prepare_converter_inputs(batch,pin('qualification.json'),pin('selection.json'))
        self.assertEqual(result['candidate']['freshInstallerCheck'],batch['candidate']['installerCheck'])
        self.assertNotIn('assembly',result['candidate']);self.assertEqual(batch,before)
        self.assertEqual(batch['generation']['manifest']['fileName'],'manifest.json')

    def test_no_overlap_uses_original_assembly_installer_and_no_candidate_or_choice(self):
        batch=fixture();receipt=dict(kind='nightstudy-ci-sentence-publication-conversion-v1',packId=batch['packId'],
            mode='original-generation',state='UNCHANGED_ORIGINAL_GENERATION',selectedPublication=s.converter_candidate(batch),
            generationProofUnchanged=True,publicationAuthorized=False)
        frame=s.global_batch_frame(batch,receipt,pin('conversion-receipt.json'))
        self.assertEqual(frame['publication']['assembly'],batch['candidate']['assembly'])
        self.assertEqual(frame['publication']['installerCheck'],batch['candidate']['installerCheck'])
        self.assertIsNone(frame['publication']['selectionProof']);self.assertNotIn('candidate',frame['publication'])
        self.assertEqual(frame['generation'],batch['generation'])

    def test_conversion_preserves_original_candidate_and_uses_new_assembly_choice_installer(self):
        batch=fixture();receipt,selected=converted(batch);before=copy.deepcopy((batch,receipt,selected));assembly=pin('conversion-receipt.json')
        frame=s.global_batch_frame(batch,receipt,assembly,selected)
        self.assertEqual(frame['publication']['assembly'],assembly)
        self.assertEqual(frame['publication']['candidate'],batch['candidate'])
        self.assertEqual(frame['publication']['selectionProof'],selected['choice'])
        self.assertEqual(frame['publication']['installerCheck'],selected['installerCheck'])
        self.assertEqual((batch,receipt,selected),before)

    def test_missing_output_sha_basename_or_actual_converter_source_cannot_form_frame(self):
        for mutate in (
            lambda r,o:o['manifest'].__setitem__('sha256','f'*64),
            lambda r,o:o['sources'].__setitem__('fileName','stage/wrong.json'),
            lambda r,o:r.__setitem__('converterSourceSha256','f'*64),
            lambda r,o:r['originalCandidate']['archive'].__setitem__('bytes',456),
        ):
            batch=fixture();receipt,selected=converted(batch);mutate(receipt,selected)
            with self.assertRaises(ValueError):s.global_batch_frame(batch,receipt,pin('receipt.json'),selected)

    def test_paths_bool_sizes_and_wrong_slice_are_rejected(self):
        for bad in ({**pin('a'),'fileName':'../a'}, {**pin('a'),'fileName':'/tmp/a'},
            {**pin('a'),'bytes':True}, {**pin('a'),'fileName':'stage//a'}):
            with self.assertRaises(ValueError):s.pin(bad)
        batch=fixture();batch['sliceNumber']=5
        with self.assertRaises(ValueError):s.batch_copy(batch)


if __name__=='__main__':unittest.main()
