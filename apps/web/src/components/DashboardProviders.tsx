'use client';

import { ToastProvider } from './toast';
import { ConfirmModalProvider } from './confirm-modal';
import type { ReactNode } from 'react';

export default function DashboardProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmModalProvider>
        {children}
      </ConfirmModalProvider>
    </ToastProvider>
  );
}
