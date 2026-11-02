const LINKS: [string, string][] = [
  ["/admin", "Health"],
  ["/admin/scoring", "Scoring"],
  ["/admin/weeks", "Weeks"],
  ["/admin/players", "Players & prices"],
  ["/admin/corrections", "Corrections"],
  ["/admin/people", "People & leagues"],
];

export function AdminNav({ active }: { active: string }) {
  return (
    <>
      <h1>Admin</h1>
      <div className="seg" style={{ marginBottom: 8 }}>
        {LINKS.map(([href, label]) => <a key={href} href={href} className={`chip${active === href ? " on" : ""}`}>{label}</a>)}
      </div>
    </>
  );
}
