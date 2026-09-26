/* Role checkboxes. A role that grants permissions the actor does not hold is shown but locked: the server enforces
   the same rule (no escalation), this only explains it in advance. */
import type { RoleRow } from '@kitsyuu/core';

export default function RoleChecks({ roles, actorPermissions, selected, legend = 'Roles' }: {
  roles: RoleRow[]; actorPermissions: ReadonlySet<string>; selected: string[]; legend?: string;
}) {
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      {roles.map(r => {
        const locked = r.permissions.some(p => !actorPermissions.has(p));
        return (
          <label className="check" key={r.id} data-locked={locked} data-role={r.code}>
            <input type="checkbox" name="roleIds" value={r.id} defaultChecked={selected.includes(r.id)} disabled={locked && !selected.includes(r.id)} />
            <span>{r.name} <span className="mono note">{r.code}</span>
              <small>{r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}{locked ? ' · includes permissions you do not hold' : ''}</small></span>
          </label>
        );
      })}
    </fieldset>
  );
}
