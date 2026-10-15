import { screenDeactivateEvent } from './screen-lifecycle';

let active: { owner: object; stop: () => void } | null = null;

export function releaseAudio(owner: object) {
  if (active?.owner === owner) active = null;
}
export function stopApplicationAudio() {
  const previous = active;
  active = null;
  previous?.stop();
}
export function claimAudio(owner: object, stop: () => void) {
  if (active?.owner === owner) return;
  stopApplicationAudio();
  active = { owner, stop };
}

/** Native media controls, detached word audio, and speech share one playback owner. */
export function installAudioLifecycle() {
  const play = (event: Event) => {
    if (!(event.target instanceof HTMLMediaElement)) return;
    const media = event.target;
    if (document.visibilityState === 'hidden' || media.closest('[hidden],[inert]')) {
      media.pause();
      return;
    }
    claimAudio(media, () => media.pause());
  };
  const leave = () => {
    stopApplicationAudio();
    document.querySelectorAll('audio,video').forEach((element) => {
      if (element instanceof HTMLMediaElement) element.pause();
    });
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') leave();
  };
  document.addEventListener('play', play, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener(screenDeactivateEvent, leave);
  window.addEventListener('pagehide', leave);
  return () => {
    leave();
    document.removeEventListener('play', play, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener(screenDeactivateEvent, leave);
    window.removeEventListener('pagehide', leave);
  };
}
