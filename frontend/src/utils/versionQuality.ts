/**
 * The version row's 「要件・指摘」 cell.
 *
 * Two numbers the score does not carry: how many of the request's checkable
 * requirements the version meets, and how many findings it shipped with. Both
 * were in the chat reply and nowhere a list of versions could show them.
 *
 * Absent is a dash, not a zero. A row from before these were recorded, or a
 * run whose request had nothing a check could settle, did not score zero — it
 * was not measured, and a column of zeros would say the opposite.
 */
type Row = { requirementsMet?: number; requirementsChecked?: number; openFindings?: number };

export function versionQualityLabel(v: Row): string {
  // Compact on purpose: the column heading names both numbers, the tooltip spells
  // them out, and every pixel here comes out of the prompt column — which at a
  // 1100px window was already down to four characters a line.
  const req = v.requirementsChecked ? `${v.requirementsMet ?? 0}/${v.requirementsChecked}` : '—';
  const open = typeof v.openFindings === 'number' ? String(v.openFindings) : '—';
  return `${req}・${open}`;
}

export function versionQualityTitle(v: Row): string {
  const req = v.requirementsChecked
    ? `依頼の要件のうち、自動で確認できる${v.requirementsChecked}件中${v.requirementsMet ?? 0}件を満たしています`
    : '自動で確認できる要件の記録はありません';
  const open = typeof v.openFindings === 'number'
    ? `未解決の指摘が${v.openFindings}件あります`
    : '未解決の指摘の記録はありません（編集、または記録前のバージョン）';
  return `${req}\n${open}`;
}
