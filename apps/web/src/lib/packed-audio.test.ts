import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PackedAudioPlayer } from './packed-audio';
import { claimAudio, stopApplicationAudio } from './audio-manager';
const audios: FakeAudio[] = [];
class FakeAudio {
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  removeAttribute = vi.fn();
  play = vi.fn(() => Promise.resolve());
  constructor(public src: string) {
    audios.push(this);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Audio', FakeAudio);
  audios.length = 0;
});
afterEach(() => {
  stopApplicationAudio();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('stops the preceding accent and ignores its late completion/error', () => {
  const player = new PackedAudioPlayer(),
    changed = vi.fn();
  player.onChange = changed;
  player.play('/us.mp3');
  const us = audios[0]!,
    oldEnd = us.onended!,
    oldError = us.onerror!;
  us.onplaying!();
  player.play('/uk.mp3');
  expect(us.pause).toHaveBeenCalled();
  const count = changed.mock.calls.length;
  oldEnd();
  oldError();
  expect(changed).toHaveBeenCalledTimes(count);
  audios[1]!.onplaying!();
  expect(changed).toHaveBeenLastCalledWith('playing');
});
it('releases ownership after completion so old components cannot stop current playback', () => {
  const first = new PackedAudioPlayer(),
    second = new PackedAudioPlayer();
  first.play('/a');
  audios[0]!.onended!();
  second.play('/b');
  first.stop();
  expect(audios[1]!.pause).not.toHaveBeenCalled();
  stopApplicationAudio();
  expect(audios[1]!.pause).toHaveBeenCalledOnce();
});
it('word, sentence and recorder owners interrupt each other', () => {
  const word = new PackedAudioPlayer(),
    sentence = new PackedAudioPlayer();
  word.play('/word');
  sentence.play('/sentence');
  expect(audios[0]!.pause).toHaveBeenCalledOnce();
  const recorderStop = vi.fn();
  claimAudio({}, recorderStop);
  expect(audios[1]!.pause).toHaveBeenCalledOnce();
  word.play('/word-2');
  expect(recorderStop).toHaveBeenCalledOnce();
});
it('times out a stalled load and ignores a late playing callback', () => {
  const player = new PackedAudioPlayer(),
    changed = vi.fn();
  player.onChange = changed;
  player.play('/stalled');
  const late = audios[0]!.onplaying!;
  vi.advanceTimersByTime(12001);
  expect(changed).toHaveBeenLastCalledWith('error');
  late();
  expect(changed).toHaveBeenLastCalledWith('error');
});
it('does not time out media after actual playback begins', () => {
  const player = new PackedAudioPlayer(),
    changed = vi.fn();
  player.onChange = changed;
  player.play('/long-sentence');
  audios[0]!.onplaying!();
  vi.advanceTimersByTime(30000);
  expect(changed).toHaveBeenLastCalledWith('playing');
  audios[0]!.onended!();
  expect(changed).toHaveBeenLastCalledWith('ended');
});
