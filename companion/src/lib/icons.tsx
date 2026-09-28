import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function SearchIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
}

export function ChevronIcon(props: IconProps) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" {...props}><path d="m6 3 5 5-5 5" /></svg>;
}

export function WorkspaceIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M3.5 9h17M7 7h.01M10 7h.01" /></svg>;
}

export function LogoMark() {
  return <span className="logo-mark" aria-hidden="true"><span /><span /></span>;
}
