import { useEffect, useState } from 'react';
import type { CrowdManager, CrowdSnapshot } from './CrowdManager';

const THROTTLE_MS = 250;

/** Snapshot da Multidão para o React, no máximo 4x por segundo. */
export function useCrowd(manager: CrowdManager): CrowdSnapshot {
  const [snap, setSnap] = useState<CrowdSnapshot>(() => manager.snapshot());
  useEffect(() => {
    // Começa "sujo": o que mudou entre o primeiro render e esta inscrição entra no primeiro tique.
    let dirty = true;
    const unsub = manager.subscribe(() => { dirty = true; });
    const id = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setSnap(manager.snapshot());
    }, THROTTLE_MS);
    return () => { unsub(); clearInterval(id); };
  }, [manager]);
  return snap;
}
