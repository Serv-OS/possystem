/**
 * PrinterErrorHelp: a print failure in plain words.
 *
 * Takes the object from printerErrorGuidance() in lib/printerErrorWords.js. The main line
 * says what is wrong, the numbered lines say what to check, and the raw text from the till
 * sits underneath in smaller type so support can still read it.
 */
export default function PrinterErrorHelp({ guidance, size = 11, prefix = '✗ ', showTitle = true, showSteps = true }) {
  if (!guidance) return null;
  const { title, steps = [], raw } = guidance;
  const stepsShown = showSteps && steps.length > 0;
  if (!showTitle && !stepsShown && !raw) return null;
  return (
    <div style={{ fontSize:size, lineHeight:1.45 }}>
      {showTitle && <div style={{ color:'var(--red)', fontWeight:700 }}>{prefix}{title}</div>}
      {stepsShown && (
        <ol style={{ margin: showTitle ? '5px 0 0' : 0, paddingLeft:18, color:'var(--t2)', fontWeight:500 }}>
          {steps.map((step, i) => <li key={i} style={{ marginBottom:3 }}>{step}</li>)}
        </ol>
      )}
      {raw && (
        <div style={{ fontSize:Math.max(9, size - 2), marginTop:(showTitle || stepsShown) ? 5 : 0, color:'var(--t3)', fontWeight:400, wordBreak:'break-word' }}>
          For support: {raw}
        </div>
      )}
    </div>
  );
}
