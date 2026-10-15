import { afterEach, expect, it, vi } from 'vitest';
import { applicationScope } from './app-scope';
import { claimAudio, releaseAudio, stopApplicationAudio } from './audio-manager';

afterEach(stopApplicationAudio);

it('separates identical user/site names across mounts, origins, installations and signed-out state', () => {
  const site = { basePath: '', siteId: 'school', instanceId: 'first-install' };
  const base = applicationScope('https://english.example', site, 'learner');
  const cases = [
    applicationScope('https://another.example', site, 'learner'),
    applicationScope('https://english.example', { ...site, basePath: '/school' }, 'learner'),
    applicationScope('https://english.example', { ...site, instanceId: 'reinstalled' }, 'learner'),
    applicationScope('https://english.example', { ...site, siteId: 'another-school' }, 'learner'),
    applicationScope('https://english.example', site, 'another-learner'),
    applicationScope('https://english.example', site, null),
  ];
  expect(new Set([base, ...cases]).size).toBe(7);
});

it('stops a word recording when a native lesson player takes over, without stale cleanup releasing the new player', () => {
  const word = {},
    lesson = {};
  const wordStop = vi.fn(() => releaseAudio(word));
  const lessonStop = vi.fn();
  claimAudio(word, wordStop);
  claimAudio(lesson, lessonStop);
  expect(wordStop).toHaveBeenCalledTimes(1);
  releaseAudio(word); // a late callback from the previous component
  stopApplicationAudio();
  expect(lessonStop).toHaveBeenCalledTimes(1);
  stopApplicationAudio();
  expect(lessonStop).toHaveBeenCalledTimes(1);
});

it('keeps a repeated native play event on its current owner and stops the owner on application deactivation', () => {
  const media = {};
  const stop = vi.fn();
  claimAudio(media, stop);
  claimAudio(media, stop);
  expect(stop).not.toHaveBeenCalled();
  stopApplicationAudio();
  expect(stop).toHaveBeenCalledTimes(1);
});
