import { useEffect, useRef, useState } from 'react';
import { PackedAudioPlayer, type AudioPhase } from '../lib/packed-audio';
import { useScreenActive } from '../lib/screen-lifecycle';
export function usePackedAudio(identity: string) {
  const active = useScreenActive();
  const [phase, setPhase] = useState<AudioPhase>('idle');
  const player = useRef<PackedAudioPlayer | null>(null);
  if (!player.current) player.current = new PackedAudioPlayer();
  useEffect(() => {
    const current = player.current!;
    current.onChange = setPhase;
    setPhase('idle');
    return () => {
      current.onChange = () => {};
      current.stop();
    };
  }, [identity]);
  useEffect(() => {
    if (!active) player.current!.stop();
  }, [active]);
  return {
    phase,
    playing: phase === 'loading' || phase === 'playing',
    stop: () => player.current!.stop(),
    play: (url: string) => {
      if (active && document.visibilityState !== 'hidden') player.current!.play(url);
    },
  };
}
