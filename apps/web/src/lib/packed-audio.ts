import { claimAudio, releaseAudio } from './audio-manager';
export type AudioPhase = 'idle' | 'loading' | 'playing' | 'ended' | 'error';
/** Late media events cannot restart or change a newer playback request. */
export class PackedAudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private epoch = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  onChange: (phase: AudioPhase) => void = () => {};
  private clean() {
    this.epoch++;
    clearTimeout(this.timeout);
    if (this.audio) {
      this.audio.onplaying = this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio = null;
    }
    releaseAudio(this);
  }
  stop = () => {
    this.clean();
    this.onChange('idle');
  };
  play(url: string) {
    this.clean();
    claimAudio(this, this.stop);
    const epoch = this.epoch,
      audio = new Audio(url);
    this.audio = audio;
    const current = () => this.epoch === epoch && this.audio === audio;
    const finish = (phase: AudioPhase) => {
      if (current()) {
        this.clean();
        this.onChange(phase);
      }
    };
    this.onChange('loading');
    audio.onplaying = () => {
      if (current()) {
        clearTimeout(this.timeout);
        this.onChange('playing');
      }
    };
    audio.onended = () => finish('ended');
    audio.onerror = () => finish('error');
    this.timeout = setTimeout(() => finish('error'), 12000);
    void audio.play().catch(() => finish('error'));
  }
}
