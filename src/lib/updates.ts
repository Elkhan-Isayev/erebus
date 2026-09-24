import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/types';
import { api, bridge } from '@/lib/api';

/** The main process owns update state; every view just mirrors it. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void api.updateState().then(setState);
    return bridge.on('update:state', (payload) => setState(payload as UpdateState));
  }, []);
  return state;
}
