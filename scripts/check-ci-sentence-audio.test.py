#!/usr/bin/env python3
"""Model-free acceptance regressions; actual codec acceptance runs in the pilot."""
import copy
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

FILE = Path(__file__).with_name('check-ci-sentence-audio.py')
SPEC = importlib.util.spec_from_file_location('independent_ci_audio_checker', FILE)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


def reference(reviewed=False):
    value = dict(wordId='demo-word-022', learningSenseId='learning-sense-' + 'a' * 64,
                 exampleId='sense-example-' + 'b' * 64, contentVersion='fixture-v1', bindingHash='c' * 64,
                 leafIndex=0, leafManifestSha256='d' * 64, payloadSha256='e' * 64,
                 publicContextSha256='f' * 64, sourceBindingsSha256='1' * 64)
    if reviewed:
        del value['publicContextSha256']
        value.update(semanticSha256='2' * 64, proofSourceBindingsSha256='3' * 64, packetReferenceSha256=None)
    return value


def correction():
    text = 'A reviewer examined this short sentence.'
    key = check.sha(text)
    record = dict(id='sentence-pronunciation-' + check.sha(key + '\0US'), text=text,
                  textHash=key, accent='US', learningSenseId=reference()['learningSenseId'],
                  exampleId=reference()['exampleId'], originalPhonemes=['tʃaɪ.', 'b.'],
                  replacements=[dict(sentence=0, start=0, **{'from': 'tʃ', 'to': 'b'})],
                  review=dict(reviewer='Codex', decision='publish', expertCertified=False,
                              reason='The complete regional context supports this exact literal edit.'))
    return check.review_record(record)


def fixture():
    revised = correction()
    text = revised['record']['text']
    group = dict(textHash=check.sha(text), text=text, references=[reference(True)],
                 rawTokenSegments=[['tʃ', 'aɪ', '.'], ['b', '.']], originalPhonemes=['tʃaɪ.', 'b.'],
                 accents={'US': dict(state='reviewed-correction', correction=revised, hold=None),
                          'UK': dict(state='hold', correction=None, hold={'fixture': 'exact active hold'})})
    base_text = 'This ordinary sentence uses a separate base route.'
    request = dict(kind='nightstudy-ci-sentence-audio-request-v1', mode='pilot', packId='sentence-audio-v4-9001',
                   portableControls={}, voicesManifest={}, publicRootSha256=check.PUBLIC_SHA,
                   finalPolicySha256=check.FINAL_SHA,
                   targets=[dict(textHash=check.sha(base_text), text=base_text, references=[reference()], accents=['US', 'UK']),
                            dict(textHash=group['textHash'], text=text, references=group['references'], accents=['US'])],
                   holdChecks=[dict(textHash=group['textHash'], accent='UK')])
    voices = dict(voices={a: dict(model={'sha256': '4' * 64}, config={'sha256': '5' * 64}) for a in check.ACCENTS})
    return request, {group['textHash']: group}, voices


def pcm_wav():
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(22050)
        output.writeframes(b'\x64\x00' * 2205)
    return stream.getvalue()


class IndependentAcceptanceTests(unittest.TestCase):
    def test_unicode_correction_replays_full_original_array(self):
        checked = correction()
        self.assertEqual(checked['correctedPhonemes'], ['baɪ.', 'b.'])
        changed = copy.deepcopy(checked['record'])
        changed['replacements'][0]['start'] = 1
        with self.assertRaisesRegex(ValueError, 'review_unicode_literal_span'):
            check.review_record(changed)

    def test_no_extra_or_missing_reference_digest_can_be_hidden(self):
        check.references([reference()], False)
        changed = reference()
        del changed['sourceBindingsSha256']
        with self.assertRaisesRegex(ValueError, 'complete_current_reference_identity'):
            check.references([changed], False)
        changed = reference()
        changed['proofSourceBindingsSha256'] = '6' * 64
        with self.assertRaisesRegex(ValueError, 'complete_current_reference_identity'):
            check.references([changed], False)

    def test_held_pair_cannot_become_generated_or_base(self):
        request, groups, voices = fixture()
        expected, _, denials = check.expected_targets(request, groups, voices)
        held = request['holdChecks'][0]
        self.assertNotIn((held['textHash'], held['accent']), expected)
        self.assertEqual(len(denials), 1)
        request['targets'][1]['accents'] = ['UK']
        with self.assertRaisesRegex(ValueError, 'held_target_has_no_media_authorization'):
            check.expected_targets(request, groups, voices)

    def test_reviewed_route_requires_every_whole_segment_once(self):
        request, groups, voices = fixture()
        expected, _, _ = check.expected_targets(request, groups, voices)
        key = request['targets'][1]['textHash'], 'US'
        selected = {key: expected[key]}
        task = check.execution_metadata(selected)['tasks'][0]
        group = groups[key[0]]
        revised = group['accents']['US']['correction']
        events = [dict(textHash=key[0], accent='US', displayedTextUnchanged=group['text'],
                       taskId=task['id'], workerPid=42, workerPgid=100,
                       referencesSha256=expected[key]['identity']['referencesSha256'],
                       route='frozen-reviewed-raw-per-sentence', frontendPrecheckOnly=False,
                       rawRouteObserved=True, completedPublicCall=True, sentenceIndex=i,
                       rawPayload='[[' + text + ']]', originalTokenSegments=group['rawTokenSegments'],
                       originalPhonemes=group['originalPhonemes'], renderedPhonemes=revised['correctedPhonemes'],
                       correctionSha256=revised['sha256'], correctionId=revised['record']['id'],
                       linuxDisplayedTextPhonemizeCalled=False)
                  for i, text in enumerate(revised['correctedPhonemes'])]
        self.assertEqual(check.validate_routes(events, selected, task, 100), 42)
        with self.assertRaisesRegex(ValueError, 'all_raw_segments_once'):
            check.validate_routes(events[:1], selected, task, 100)
        changed = copy.deepcopy(events)
        changed[0]['originalTokenSegments'][0] = list('tʃaɪ.')
        with self.assertRaisesRegex(ValueError, 'actual_entire_frozen_unicode_raw_route'):
            check.validate_routes(changed, selected, task, 100)

    def test_original_wav_header_does_not_prove_full_pcm(self):
        self.assertEqual(len(check.complete_wav(io.BytesIO(pcm_wav()))), 4410)
        with self.assertRaisesRegex(ValueError, 'complete_wav_pcm_eof'):
            check.complete_wav(io.BytesIO(pcm_wav()[:-2]))

    def test_checksum_tamper_fails_before_any_decoder(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'fixture.mp3'
            file.write_bytes(b'changed encoded bytes')
            with self.assertRaisesRegex(ValueError, 'whole_input_hash_and_fd_identity'):
                check.Inputs().checked_fd(file, 1024, '0' * 64)

    def test_prefix_only_decoder_cannot_claim_complete_eof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'fixture.mp3'
            file.write_bytes(b'pinned full encoded fixture')
            class PrefixDecoder:
                returncode = 0
                def __init__(self, command, **kwargs):
                    Path(command[-1]).write_bytes(pcm_wav())
                    # Deliberately claims success without consuming the pinned input FD.
                def poll(self):
                    return 0
            with patch.object(check.subprocess, 'Popen', PrefixDecoder):
                with self.assertRaisesRegex(ValueError, 'decoder_must_consume_original_file_to_eof'):
                    check.decode_mp3(check.Inputs(), file, check.sha(file.read_bytes()), file.stat().st_size,
                                     root / 'unused-ffmpeg', root)

    def test_invalid_json_and_symlinks_are_rejected(self):
        for raw in ('{"same":1,"same":2}', '{"nan":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                check.decode(raw)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'source'
            file.write_bytes(b'fixture')
            link = root / 'link'
            link.symlink_to(file)
            with self.assertRaisesRegex(ValueError, 'no_symlink_input_components'):
                check.Inputs().checked_fd(link, 1024)


if __name__ == '__main__':
    unittest.main()
