// src/backoffice/sections/stock/UnitOptions.jsx
//
// 5.12.57 (US basics batch 7): the options of a unit picker, for the site the screen shows. A UK
// site gets exactly the optgroups the pickers drew before (Count, Weight, Volume, the 13 units). A
// US site gets the US volume units first and the UK imperial ones labelled (UK), once the database
// holds the US units (20261120c); until then the UK set and one greyed line 'US units need a
// database update'. Rules: lib/stock/stockRegion.js unitPickList.
//
//   <UnitOptions siteId={id} show="full" />   'gallon (US) (gal_us)', as the item pickers read
//   <UnitOptions siteId={id} show="code" />   'gal_us', as the pack pickers read
//   dim: only one dimension, with no optgroup (a picker of the units an amount can be in)

import { useUnitPicks } from './useSiteRegion';
import { US_UNITS_PENDING } from '../../../lib/stock/stockRegion';

const DIM_ORDER = ['COUNT', 'WEIGHT', 'VOLUME'];
const words = (u, show) => (show === 'code' ? u.code : show === 'label' ? u.label : `${u.label} (${u.code})`);

export default function UnitOptions({ siteId = null, show = 'full', dim = null }) {
  const { list, usPending } = useUnitPicks(siteId);
  const pending = usPending && (!dim || dim === 'VOLUME')
    ? <option key="us-pending" value="" disabled>{US_UNITS_PENDING}</option>
    : null;
  if (dim) {
    return <>{list.filter((u) => u.dimension === dim).map((u) => <option key={u.code} value={u.code}>{words(u, show)}</option>)}{pending}</>;
  }
  return (
    <>
      {DIM_ORDER.map((d) => (
        <optgroup key={d} label={d[0] + d.slice(1).toLowerCase()}>
          {list.filter((u) => u.dimension === d).map((u) => <option key={u.code} value={u.code}>{words(u, show)}</option>)}
        </optgroup>
      ))}
      {pending}
    </>
  );
}
