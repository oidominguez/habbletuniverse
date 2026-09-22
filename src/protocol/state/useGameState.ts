import { useEffect, useState } from 'react';
import type { GameState, GameSnapshot } from './GameState';

const THROTTLE_MS = 200;

/** Snapshot do GameState para o React, atualizado no máximo a cada 200 ms. */
export function useGameState(state: GameState): GameSnapshot {
  const [snap, setSnap] = useState<GameSnapshot>(() => state.snapshot());

  useEffect(() => {
    // Começa "sujo": o que mudou entre o primeiro render e esta inscrição entra no primeiro tique.
    let dirty = true;
    const unsub = state.subscribe(() => {
      dirty = true;
    });
    const id = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setSnap(state.snapshot());
    }, THROTTLE_MS);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, [state]);

  return snap;
}
