import { useState } from 'react';
import { useStableCallback } from './workspace-state';

/** The current inline message is state; each failure is a separate event.
 * Reporting from the setter also retains identical failures batched by React. */
export function useReportedError(report: (message: string) => void): readonly [string, (message: string) => void] {
  const [error, setValue] = useState('');
  const setError = useStableCallback((message: string) => {
    setValue(message);
    if (message) report(message);
  });
  return [error, setError];
}
