#!/usr/bin/env python3
"""Model-free boundary tests. Synthetic contracts never claim an actual CI pass."""
import copy
import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('_ci_batch_test_subject',Path(__file__).with_name('ci-sentence-audio-batch.py'))
b=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


def fixture():
    leaves=[]
    for number in range(1,102):
        count=256 if number==1 else 448 if number==101 else 1000
        pairs=895 if number==101 else count*2
        leaves.append(dict(sliceNumber=number,fileName=f'.ci-inputs/targets-{number:04d}.json',bytes=100,
            sha256=f'{number:064x}',groups=count,pairs=pairs,
            firstTextHash=f'{number*1000:064x}',lastTextHash=f'{number*1000+count-1:064x}'))
    selected=leaves[0]
    targets=[dict(textHash=f'{1000+i:064x}',accents=['US','UK']) for i in range(256)]
    controls=dict(fileName='.ci-inputs/controls.json',bytes=8216309,sha256=b.BASE_CONTROLS_SHA)
    approval=dict(approvedPilot=dict(fileName='.ci-inputs/pilot.check.json',bytes=12250,sha256=b.APPROVED_PILOT_SHA),
        selectionManifest=dict(fileName='.ci-inputs/selection.json',bytes=100,sha256='a'*64),
        selectionLeaf={k:selected[k] for k in ('fileName','bytes','sha256')},sliceNumber=1,workers=4,supplementalControls=None)
    blocked=[dict(textHash=b.SUPPLEMENT_HASH,accent=a,reason='Explicitly pending independent current regional reading review.') for a in ('US','UK')]
    selection=dict(kind='nightstudy-ci-audio-fresh-selection-v1',state='COMPLETE_EXPLICIT_FRESH_SELECTION',
        approvedPilot=approval['approvedPilot'],publicRootSha256=b.w.PUBLIC_ROOT_SHA,finalPolicySha256=b.w.FINAL_POLICY_SHA,
        portableControls=controls,supplementalControls=None,oldUnapprovedCandidateSelection='NOT_SELECTED',
        oldUnapprovedCandidates=89880,taskSentenceCap=128,batchWorkerSha256=b.w.digest(Path(b.__file__)),maxWorkers=4,
        currentCounts=dict(groups=99940,references=99984,pairs=199880),heldExcludedPairs=79,
        baselineExcludedPairs=392,supplementalHeldExcludedPairs=0,blockedExcludedPairs=2,blockedKeys=blocked,
        firstJobGroups=256,groupsPerJob=1000,generatedGroups=99704,generatedPairs=199407,leaves=leaves)
    request=dict(portableControls=controls,targets=targets)
    return approval,selection,request


class BatchBoundaryTests(unittest.TestCase):
    def check_selection(self,approval,selection,request):
        def read(pin,maximum):
            if pin==approval['selectionManifest']:return selection
            if pin==approval['selectionLeaf']:return request['targets']
            raise AssertionError('unexpected input')
        with patch.object(b,'approved_pilot',return_value={'synthetic':True}),patch.object(b.w,'pin_value',side_effect=read):
            return b.selection_inputs(approval,request)

    def test_fixed_first256_rest1000_union_has_no_regeneration(self):
        approval,selection,request=fixture()
        self.assertIs(self.check_selection(approval,selection,request),selection)

    def test_overlapping_leaf_cannot_hide_a_duplicate_first_batch(self):
        approval,selection,request=fixture()
        selection['leaves'][1]['firstTextHash']=selection['leaves'][0]['lastTextHash']
        with self.assertRaisesRegex(ValueError,'ordered_disjoint_fixed_batch_leaves'):
            self.check_selection(approval,selection,request)

    def test_unapproved_candidates_are_not_relabelled_cache_hits(self):
        approval,selection,request=fixture()
        selection['oldUnapprovedCandidateSelection']='REUSED'
        with self.assertRaisesRegex(ValueError,'complete_current_fresh_union_selection_required'):
            self.check_selection(approval,selection,request)

    def test_inflated_baseline_cannot_hide_most_of_the_requested_scope(self):
        approval,selection,request=fixture()
        selection['baselineExcludedPairs']=199407
        with self.assertRaisesRegex(ValueError,'bounded_exact_exclusion_counts'):
            self.check_selection(approval,selection,request)

    def test_changed_target_leaf_cannot_borrow_another_slice_approval(self):
        approval,selection,request=fixture()
        request['targets'][0]['textHash']='0'*64
        with self.assertRaisesRegex(ValueError,'whole_selected_leaf_targets'):
            self.check_selection(approval,selection,request)

    def test_unknown_pilot_pin_refuses_before_parsing_or_loading_any_model(self):
        with patch.object(b.w,'pin_value',side_effect=AssertionError('must not read unknown approval')):
            with self.assertRaisesRegex(ValueError,'actual_accepted_pilot3_pin_required'):
                b.approved_pilot(dict(fileName='fake.json',bytes=12250,sha256='0'*64))

    def test_known_pending_reading_is_never_implicitly_base(self):
        request=dict(kind='nightstudy-ci-sentence-audio-request-v1',mode='batch',packId='sentence-audio-v4-0101',
            portableControls={},voicesManifest={},publicRootSha256=b.w.PUBLIC_ROOT_SHA,finalPolicySha256=b.w.FINAL_POLICY_SHA,
            targets=[{}],holdChecks=[{}],batchApproval=dict(supplementalControls=None))
        with patch.object(b,'selection_inputs',return_value=dict(blockedKeys=[])):
            with self.assertRaisesRegex(ValueError,'unreviewed_known_reading_stays_blocked'):
                b.prepare_request(request,{},types.SimpleNamespace())

    def test_four_workers_need_real_cpu_and_memory_without_fallback(self):
        self.assertEqual(b.cloud_resource_admission(4,4,8*1024**3)['workers'],4)
        with self.assertRaisesRegex(ValueError,'actual_cloud_cpu'):
            b.cloud_resource_admission(4,2,16*1024**3)
        with self.assertRaisesRegex(ValueError,'eight_gib_available'):
            b.cloud_resource_admission(4,4,7*1024**3)

    def test_129_sentence_task_refuses_before_importing_the_model_pipeline(self):
        with patch.object(b.platform,'system',return_value='Linux'),patch.object(b.w,'load_builder',side_effect=AssertionError('no model import')):
            with self.assertRaisesRegex(ValueError,'bounded_cloud_task'):
                b.worker('US',[{}]*129,'unused','unused','unused')

    def test_fresh_generation_never_iterates_or_reads_sibling_journals(self):
        class ExplodingPaths:
            def __iter__(self):
                raise AssertionError('fresh generation must not inspect journals')
        wanted={('a'*64,'b'*64)}
        self.assertEqual(b.fresh_generation_entries(ExplodingPaths(),wanted,'US',wanted,'US'),{})
        with self.assertRaisesRegex(ValueError,'fresh_only_exact_task_identities'):
            b.fresh_generation_entries(ExplodingPaths(),wanted,'UK',wanted,'US')


if __name__=='__main__':unittest.main()
