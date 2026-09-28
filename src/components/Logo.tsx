export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="WindowStash">
      <img className="brand-mark" src="/icon-128.png" alt="" />
      {!compact && <span>WindowStash</span>}
    </div>
  );
}
