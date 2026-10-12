import React from 'react';

export function FlowFooter({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) {
  const ref = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    if (inline) return;
    const footer = ref.current!, section = footer.closest<HTMLElement>('.supabase-config')!;
    const measure = () => {
      const rect = section.querySelector('.config-modes')!.getBoundingClientRect();
      section.style.setProperty('--config-bar-left', `${rect.left}px`);
      section.style.setProperty('--config-bar-width', `${rect.width}px`);
      section.style.setProperty('--config-bar-height', `${footer.getBoundingClientRect().height}px`);
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    [section, footer, document.documentElement].forEach((element) => observer.observe(element));
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [inline]);
  return <footer ref={ref} className={`config-footer${inline ? '' : ' flow-footer'}`} aria-label="当前步骤操作">{children}</footer>;
}
