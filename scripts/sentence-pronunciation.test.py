import copy,hashlib,importlib.util,io,json,struct,wave
from pathlib import Path
from types import SimpleNamespace
import tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('pronunciation',Path(__file__).with_name('sentence-pronunciation.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class ReviewedPronunciation(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.voices=self.root/'voices.json';self.voices.write_text('{"cached":true}')
  self.text='The lecturer discussed agape as selfless love.'
  self.old='ðə lˈɛktʃəɹə dɪskˈʌst ɐɡˈeɪp az sɛlfləs lʌv.'
  self.row={'id':'sentence-pronunciation-'+p.sha(p.sha(self.text)+'\0US'),'text':self.text,'textHash':p.sha(self.text),'accent':'US','learningSenseId':'learning-sense-'+'a'*64,'exampleId':'sense-example-'+'b'*64,'originalPhonemes':[self.old],'replacements':[{'sentence':0,'start':self.old.index('ɐɡˈeɪp'),'from':'ɐɡˈeɪp','to':'ˈaɡəpi'}],'review':{'reviewer':'Codex','decision':'publish','expertCertified':False,'reason':'Explicit synthetic test of a reviewed noun pronunciation; no expert claim.'}}
  self.rows=[{'textHash':p.sha(self.text),'text':self.text,'references':[{'learningSenseId':self.row['learningSenseId'],'exampleId':self.row['exampleId']}]}]
 def tearDown(self):self.tmp.cleanup()
 def multiple(self):
  row=copy.deepcopy(self.row);row['text']=self.text+' She paused.';row['textHash']=p.sha(row['text']);row['id']='sentence-pronunciation-'+p.sha(row['textHash']+'\0US');row['originalPhonemes'].append('ʃiː pɔːzd.')
  return row,p.validate_review(row)
 def file(self,row=None):
  value={'formatVersion':1,'id':'sentence-pronunciation-v1','engineVersion':'1.8.0','voicesManifestSha256':p.sha(self.voices.read_bytes()),'entries':[row or self.row]}
  f=self.root/'reviews.json';f.write_text(json.dumps(value,ensure_ascii=False));return f,p.sha(f.read_bytes())
 def test_exact_review_retains_display_text_reference_and_changes_only_declared_span(self):
  f,sha=self.file();reviews,pin=p.load_reviews(f,sha,self.rows,self.voices);attached=p.attach_reviews(self.rows,reviews)
  self.assertEqual(attached[0]['text'],self.text);self.assertNotIn('pronunciationCorrections',self.rows[0]);self.assertEqual(pin['appliedClipCount'],1)
  c=attached[0]['pronunciationCorrections']['US'];self.assertEqual(c['correctedPhonemes'],[self.old.replace('ɐɡˈeɪp','ˈaɡəpi')]);self.assertNotIn('UK',attached[0]['pronunciationCorrections'])
 def test_pin_and_meaning_reference_drift_rejected(self):
  f,sha=self.file()
  with self.assertRaisesRegex(ValueError,'checksum'):p.load_reviews(f,'0'*64,self.rows,self.voices)
  wrong=copy.deepcopy(self.rows);wrong[0]['references'][0]['learningSenseId']='other'
  with self.assertRaisesRegex(ValueError,'meaning_mismatch'):p.load_reviews(f,sha,wrong,self.voices)
  self.voices.write_text('changed')
  with self.assertRaisesRegex(ValueError,'manifest'):p.load_reviews(f,sha,self.rows,self.voices)
 def test_wrong_span_overlap_injected_phoneme_block_or_claim_rejected(self):
  for mutate in [lambda r:r['replacements'][0].update(start=0),lambda r:r['replacements'].append(copy.deepcopy(r['replacements'][0])),lambda r:r['replacements'][0].update(to='[[another text]]'),lambda r:r['review'].update(expertCertified=True),lambda r:r['replacements'][0].update(start=True)]:
   row=copy.deepcopy(self.row);mutate(row)
   with self.assertRaises(ValueError):p.validate_review(row)
 def test_cache_identity_invalidates_earlier_uncorrected_audio_without_changing_normal_identity(self):
  c=p.validate_review(self.row);self.assertEqual(p.corrected_cache_identity('old',None),'old');self.assertNotEqual(p.corrected_cache_identity('old',c),'old');self.assertEqual(p.corrected_cache_identity('old',c),p.corrected_cache_identity('old',c))
  c['correctedPhonemes']=['unreviewed']
  with self.assertRaisesRegex(ValueError,'correction_drift'):p.corrected_cache_identity('old',c)
 def test_single_identity_keeps_published_formula_and_multiple_versions_render_policy(self):
  single=p.validate_review(self.row);old=lambda c:p.sha(p.canonical({'baseSynthesisIdentity':'base','pronunciationCorrectionSha256':c['sha256']}))
  self.assertEqual(p.corrected_cache_identity('base',single),old(single))
  row,multiple=self.multiple();new=p.corrected_cache_identity('base',multiple)
  self.assertNotEqual(new,old(multiple))
  self.assertEqual(new,p.sha(p.canonical({'baseSynthesisIdentity':'base','pronunciationCorrectionSha256':multiple['sha256'],'renderPolicy':p.MULTI_SENTENCE_RENDER_POLICY})))
 def test_voice_checks_actual_phonemes_and_inventory_before_using_raw_phonemes(self):
  seen=[];voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=set(self.old+'ˈaɡəpi')),phonemize=lambda text:[list(self.old)],synthesize_wav=lambda text,wav:seen.append((text,wav)))
  c=p.validate_review(self.row);adapted=p.corrected_voice(voice,self.text,c);adapted.synthesize_wav(self.text,'file');self.assertEqual(seen,[('[['+self.old.replace('ɐɡˈeɪp','ˈaɡəpi')+']]','file')]);self.assertIs(p.corrected_voice(voice,self.text,None),voice)
  voice.phonemize=lambda text:[list('different')]
  with self.assertRaisesRegex(ValueError,'actual_phonemes_changed'):p.corrected_voice(voice,self.text,c)
  voice.phonemize=lambda text:[list(self.old)];voice.config.phoneme_id_map=set()
  with self.assertRaisesRegex(ValueError,'unsupported_phoneme'):p.corrected_voice(voice,self.text,c)
 def test_multiple_sentences_use_separate_public_wavs_and_concatenate_pcm_in_order(self):
  row,c=self.multiple();seen=[];pcms=[struct.pack('<hh',11,22),struct.pack('<hh',33,44)]
  def synthesize(raw,wav):
   seen.append(raw);wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(22050);wav.writeframes(pcms[len(seen)-1])
  voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=set(''.join(c['correctedPhonemes']))),phonemize=lambda text:[list(x) for x in row['originalPhonemes']],synthesize_wav=synthesize)
  adapted=p.corrected_voice(voice,row['text'],c);output=io.BytesIO()
  with wave.open(output,'wb') as wav:self.assertIsNone(adapted.synthesize_wav(row['text'],wav))
  self.assertEqual(seen,['[['+s+']]' for s in c['correctedPhonemes']]);output.seek(0)
  with wave.open(output,'rb') as wav:
   self.assertEqual((wav.getnchannels(),wav.getsampwidth(),wav.getframerate(),wav.getnframes()),(1,2,22050,4));self.assertEqual(wav.readframes(4),b''.join(pcms))
  with self.assertRaisesRegex(ValueError,'voice_text_mismatch'):adapted.synthesize_wav(row['text']+' altered',None)
  self.assertEqual(len(seen),2)
 def test_multiple_sentence_channel_rate_and_width_drift_reject_before_target_write(self):
  row,c=self.multiple()
  for second in [(2,2,22050),(1,1,22050),(1,2,16000)]:
   with self.subTest(second=second):
    calls=[];target_calls=[]
    def synthesize(raw,wav):
     fmt=(1,2,22050) if not calls else second;calls.append(raw)
     wav.setnchannels(fmt[0]);wav.setsampwidth(fmt[1]);wav.setframerate(fmt[2]);wav.writeframes(b'\0'*(2*fmt[0]*fmt[1]))
    voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=set(''.join(c['correctedPhonemes']))),phonemize=lambda text:[list(x) for x in row['originalPhonemes']],synthesize_wav=synthesize)
    target=SimpleNamespace(setnchannels=lambda n:target_calls.append(n),setsampwidth=lambda n:target_calls.append(n),setframerate=lambda n:target_calls.append(n),writeframes=lambda b:target_calls.append(b))
    with self.assertRaisesRegex(ValueError,'sentence_wav_format_mismatch'):p.corrected_voice(voice,row['text'],c).synthesize_wav(row['text'],target)
    self.assertEqual(target_calls,[])
 def test_oov_in_unchanged_second_sentence_rejects_before_synthesis(self):
  row,c=self.multiple();inventory=set(''.join(c['correctedPhonemes']));inventory.remove('ɔ');seen=[]
  voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=inventory),phonemize=lambda text:[list(x) for x in row['originalPhonemes']],synthesize_wav=lambda *args:seen.append(args))
  with self.assertRaisesRegex(ValueError,'unsupported_phoneme'):p.corrected_voice(voice,row['text'],c)
  self.assertEqual(seen,[])
 def test_zero_frame_sentence_rejected_before_target_write(self):
  row,c=self.multiple();target_calls=[]
  def synthesize(raw,wav):wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(22050)
  voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=set(''.join(c['correctedPhonemes']))),phonemize=lambda text:[list(x) for x in row['originalPhonemes']],synthesize_wav=synthesize)
  target=SimpleNamespace(writeframes=lambda b:target_calls.append(b))
  with self.assertRaisesRegex(ValueError,'invalid_wav_frames'):p.corrected_voice(voice,row['text'],c).synthesize_wav(row['text'],target)
  self.assertEqual(target_calls,[])
 def test_actual_public_piper_raw_parser_merges_adjacent_blocks(self):
  try:
   from piper.config import PiperConfig
   from piper.voice import PiperVoice
  except ImportError:self.skipTest('Installed Piper required for the real public raw-parser regression.')
  config=PiperConfig.from_dict({'num_symbols':256,'num_speakers':1,'audio':{'sample_rate':22050},'espeak':{'voice':'en'},'phoneme_type':'espeak','phoneme_id_map':{x:[i] for i,x in enumerate('ab.^$_ ')}})
  voice=PiperVoice(session=None,config=config)
  self.assertEqual(len(voice.phonemize('[[a.]] [[b.]]')),1)
  self.assertEqual([voice.phonemize('[[a.]]'),voice.phonemize('[[b.]]')],[[list('a.')],[list('b.')]])
 def test_unrequested_review_not_applied_and_symlink_or_missing_pin_rejected(self):
  f,sha=self.file();reviews,pin=p.load_reviews(f,sha,[],self.voices);self.assertEqual(reviews,{});self.assertEqual(pin['appliedClipCount'],0)
  link=self.root/'link.json';link.symlink_to(f)
  with self.assertRaisesRegex(ValueError,'reviews_file'):p.load_reviews(link,sha,self.rows,self.voices)
  with self.assertRaisesRegex(ValueError,'pin_required'):p.load_reviews(f,None,self.rows,self.voices)
 def test_worker_cannot_reuse_an_old_or_later_listed_uncorrected_journal_entry(self):
  spec=importlib.util.spec_from_file_location('corrected_sentence_worker',Path(__file__).with_name('sentence-audio-pack.py'));worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
  output=self.root/'worker';(output/'progress').mkdir(parents=True);(output/'files').mkdir()
  source=worker.pack.load_sources(worker.pack.DEFAULT_VOICES_MANIFEST)['voices']['US'];base=worker.pack.synthesis_identity(self.text,'US',source)
  previous={'textHash':p.sha(self.text),'text':self.text,'cacheKey':base,'accent':'US','kind':'synthesized','mimeType':'audio/mpeg','fileSha256':'c'*64,'fileKey':'files/'+'c'*64+'.mp3',**{k:source[k] for k in ['sourceName','sourceUrl','license','attribution']}}
  (output/'progress/US-0.jsonl').write_text(json.dumps(previous)+'\n');seen=[]
  voice=SimpleNamespace(config=SimpleNamespace(phoneme_id_map=set(self.old+'ˈaɡəpi')),phonemize=lambda text:[list(self.old)],synthesize_wav=lambda text,wav:seen.append(text))
  correction=p.validate_review(self.row);row={**self.rows[0],'pronunciationCorrections':{'US':correction}}
  def synthesize(text,accent,source,adapted,output):
   adapted.synthesize_wav(text,'wave');return {**previous,'mimeType':'audio/wav'}
  with patch.object(worker.pack,'make_voice',return_value=voice),patch.object(worker.pack,'validate_entry',return_value=True),patch.object(worker.pack,'synthesize_entry',side_effect=synthesize) as synth,patch.object(worker.codec,'encode_mp3',side_effect=lambda entry,output:{**entry,'mimeType':'audio/mpeg'}):
   first=worker.worker('US',[row],str(output),str(self.root/'models'),0)[0]
   self.assertNotEqual(first['cacheKey'],base);self.assertEqual(first['pronunciationCorrectionSha256'],correction['sha256'])
   (output/'progress/US-1.jsonl').write_text(json.dumps(previous)+'\n')
   second=worker.worker('US',[row],str(output),str(self.root/'models'),0)[0]
   self.assertEqual(second['cacheKey'],first['cacheKey']);self.assertEqual(synth.call_count,1)
  self.assertEqual(seen,['[['+self.old.replace('ɐɡˈeɪp','ˈaɡəpi')+']]'])
if __name__=='__main__':unittest.main()
