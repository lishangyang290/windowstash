import React from 'react';

export function SuccessToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const dismiss = React.useRef(onDismiss);
  dismiss.current = onDismiss;

  React.useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), 2000);
    return () => window.clearTimeout(timer);
  }, [message]);

  return <div className="success-toast" role="status" aria-live="polite"><span aria-hidden="true">✓</span>{message}</div>;
}
