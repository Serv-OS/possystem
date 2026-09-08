// ManagerOps — the FULL Operations experience, folded in from the standalone ?mode=ops surface so
// there is ONE surface to maintain. Renders the shared <OpsContent>: compliance Home (ring + area
// tiles) → temperature rounds (FSA-guided, breach → blocked corrective that auto-raises maintenance
// + alerts) → opening/closing/cleaning checklists with photo sign-off → goods-in delivery checks →
// maintenance → alerts. WRITES enabled (the ops data layer is location-fenced server-side).
//
// chrome={false}: the Manager app's own Shell already provides the header + bottom tab bar, so
// OpsContent renders its views bare and surfaces alerts via a bell on the Ops Home card.
import { OpsContent } from '../OperationsSurface';

export default function ManagerOps({ ctx }) {
  const { loc, venueName, operator, opsJump } = ctx;
  return <OpsContent loc={loc} venueName={venueName} operator={operator} chrome={false} jump={opsJump} />;
}
