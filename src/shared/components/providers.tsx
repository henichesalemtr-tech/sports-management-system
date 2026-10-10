'use client';

import { ToastProvider } from '@/shared/ui-kit/toast';
import { useEffect, type ReactNode } from 'react';
import { startOfflineSync } from '@/shared/offline/athlete-sync';

/** مزودات عامة على مستوى العميل (تنبيهات + سياق الجلسة يُحقن من الخادم). */
export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => startOfflineSync(), []);
  return <ToastProvider>{children}</ToastProvider>;
}
