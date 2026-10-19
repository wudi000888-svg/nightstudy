#!/usr/bin/env python3
"""Model-free packaging boundaries; synthetic receipts are never publication proof."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('_ci_audio_assembly_test',Path(__file__).with_name('assemble-ci-sentence-audio.py'))
a=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)


def acceptance():
    request=dict(batchApproval=dict(workers=4))
    check=dict(kind='nightstudy-ci-sentence-audio-batch-independent-check-v1',state='VERIFIED_SELECTED_BATCH_ONLY',
        requestSha256='a'*64,publicRootSha256=a.w.PUBLIC_ROOT_SHA,finalPolicySha256=a.w.FINAL_POLICY_SHA,
        batchApproval=copy.deepcopy(request['batchApproval']),publicationAuthorized=False,
        allCurrentReferencesBound=True,selectionPairUnionVerified=True,reviewedFrozenRawCallsVerified=True,
        decoderInputProtocol='fd',seekablePinnedInput=True,batchWorkerSha256=a.BATCH_SHA,
        checkerSourceSha256=a.CHECKER_SHA,purePilotHelperSha256=a.PURE_CHECKER_SHA,
        journalReusePolicy=a.b.JOURNAL_POLICY,oldUnapprovedCandidateSelection='NOT_SELECTED',
        oldUnapprovedCandidates=89880,taskSentenceCap=128,workers=4,threadsPerVoice=1,decoderThreads=1)
    return request,check


def scope():
    text='The drawing shows a bifurcate stem.'
    text_hash=a.w.sha(text)
    request=dict(targets=[dict(textHash=text_hash,text=text,
        references=[dict(learningSenseId='sense-a',exampleId='example-a')],accents=['US'])])
    hold=dict(id='hold-a',textHash=text_hash,text=text,accent='UK',learningSenseId='sense-a',
        exampleId='example-a',riskCategory='insufficient-regional-evidence')
    return request,hold,dict(textHash=text_hash,accent='US')


class AssemblyBoundaries(unittest.TestCase):
    def test_actual_selected_batch_receipt_required_not_generation_receipt(self):
        request,check=acceptance()
        a.check_acceptance(check,request,'a'*64)
        for change in (dict(state='GENERATED_REQUIRES_INDEPENDENT_CHECK'),dict(publicationAuthorized=True),
                dict(checkerSourceSha256='0'*64),dict(journalReusePolicy='reuse-latest'),dict(workers=2)):
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'actual_selected_batch'):
                a.check_acceptance(dict(check,**change),request,'a'*64)

    def test_all_three_artifacts_must_be_identical_to_independent_acceptance(self):
        for field,name in (('generatedManifest','manifest.json'),('generatedSources','sources.manifest.json'),
                ('generationReceipt','build-receipt.json')):
            with self.subTest(field=field):
                raw=b'{"synthetic":true}\n'
                check={field:dict(fileName=name,bytes=len(raw),sha256=a.w.sha(raw))}
                a.accepted_output_pin(check,field,name,raw)
                with self.assertRaisesRegex(ValueError,'independently_accepted_output_pin'):
                    a.accepted_output_pin(check,field,name,raw+b' ')
                check[field]['fileName']='another.json'
                with self.assertRaisesRegex(ValueError,'independently_accepted_output_pin'):
                    a.accepted_output_pin(check,field,name,raw)

    def test_one_held_accent_is_declared_and_not_filled_or_hidden(self):
        request,hold,entry=scope()
        stats,held=a.coverage(request,[entry],{(hold['textHash'],'UK'):hold})
        self.assertEqual((stats['requestedClipCount'],stats['generatedClipCount'],stats['heldClipCount'],
            stats['eligibleClipCount'],stats['heldSentenceCount'],stats['fullyHeldSentenceCount']),(2,1,1,1,1,0))
        self.assertEqual(held,[dict(holdId='hold-a',**{k:hold[k] for k in (
            'textHash','accent','learningSenseId','exampleId','riskCategory')})])
        with self.assertRaisesRegex(ValueError,'installer_requires_every_nonheld'):
            a.coverage(request,[entry,dict(entry,accent='UK')],{(hold['textHash'],'UK'):hold})

    def test_missing_nonheld_or_duplicate_media_cannot_be_packaged(self):
        request,hold,entry=scope()
        for entries in ([entry],[entry,entry]):
            with self.subTest(entries=entries),self.assertRaisesRegex(ValueError,'installer_requires_every_nonheld'):
                a.coverage(request,entries,{})

    def test_hold_anchor_must_be_a_current_requested_reference(self):
        request,hold,entry=scope();hold['exampleId']='different-example'
        with self.assertRaisesRegex(ValueError,'package_hold_current_reference'):
            a.coverage(request,[entry],{(hold['textHash'],'UK'):hold})

    def test_explicit_staged_policy_payload_is_a_sibling_not_data_installation(self):
        manifest=dict(formatVersion=1,id='sentence-audio-holds-v1',fileName='sentence-audio-holds-v1.json',
            bytes=80987,sha256=a.HOLDS_SHA,holdCount=79,
            learningSensesManifestFileName='learning-senses-collection-v2.manifest.json',
            learningSensesManifestSha256=a.w.PUBLIC_ROOT_SHA)
        policy=dict(formatVersion=1,id='sentence-audio-holds-v1',entries=[{}]*79)
        file=Path('/synthetic-staging/sentence-audio-holds-v1.manifest.json')
        with patch.object(a.w,'relative_file',return_value=file),patch.object(a.w,'read_bounded',
                side_effect=[a.w.canonical(manifest).encode(),a.w.canonical(policy).encode()]) as reader:
            actual,_,_=a.policy_files('.ci-audio-inputs/sentence-audio-holds-v1.manifest.json')
            self.assertEqual(actual,manifest)
            self.assertEqual(reader.call_args_list[0].args,(file,65536,a.HOLD_MANIFEST_SHA,375))
            self.assertEqual(reader.call_args_list[1].args,
                (file.parent/'sentence-audio-holds-v1.json',4*a.w.MIB,a.HOLDS_SHA,80987))

    def test_wav_models_or_route_evidence_never_enter_installer_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'files').mkdir();(root/'licenses').mkdir()
            metadata=root/'manifest.json';metadata.write_bytes(b'{}')
            mp3=root/'files'/('a'*64+'.mp3');mp3.write_bytes(b'synthetic-not-real-audio')
            a.verify_archive_members(root,[metadata,mp3])
            for name in ('files/'+('b'*64)+'.wav','model.onnx','routes.jsonl'):
                file=root/name;file.write_bytes(b'synthetic')
                with self.subTest(name=name),self.assertRaisesRegex(ValueError,'exact_installer_members'):
                    a.verify_archive_members(root,[metadata,mp3,file])
                file.unlink()

    def test_extra_unlisted_asset_or_symlink_fails_before_archiving(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=root/'manifest.json';manifest.write_bytes(b'{}')
            extra=root/'sources.manifest.json';extra.write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError,'exact_installer_members'):
                a.verify_archive_members(root,[manifest])
            extra.unlink();extra.symlink_to(manifest)
            with self.assertRaisesRegex(ValueError,'exact_installer_members'):
                a.verify_archive_members(root,[manifest,extra])


if __name__=='__main__':unittest.main()
