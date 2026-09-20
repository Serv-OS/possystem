import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { supabase, getLocationId } from '../lib/supabase';
import { printService } from '../lib/printer';
import { mustChangeRow } from '../lib/rowWrites';
import { VERSION } from '../lib/version';
import { printEnvironment, printFailureWords, printPathIndicator } from '../lib/printPathWords';
import { printerErrorGuidance, printerViewingDevice } from '../lib/printerErrorWords';
import { resolvePrinterSpec } from '../lib/printerDialects';
import StatusDrawerCardReaders from './StatusDrawerCardReaders';
import PrinterErrorHelp from './PrinterErrorHelp';

const ONLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min last_seen threshold

export default function StatusDrawer({ onClose }) {
  const { deviceConfig, clearDeviceConfig, syncStatus, setAppMode } = useStore();

  // Printers from config snapshot
  const [printers, setPrinters] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; }
  });

  // KDS devices from Supabase
  const [kdsDevices, setKdsDevices] = useState([]);

  // Per-device status: id → 'online'|'offline'|'unknown'|'checking'
  const [statuses, setStatuses] = useState({});

  // Print queue: pending/failed only
  const [printJobs, setPrintJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  // Test state: id → 'idle'|'testing'|'ok'|'timeout'|'failed'
  const [testState, setTestState] = useState({});
  const [testMsg, setTestMsg] = useState({});
  // Last failed printer test: id → { raw, device }. The raw text from the till is kept as it
  // is and turned into plain steps when it is drawn (lib/printerErrorWords.js).
  const [testErr, setTestErr] = useState({});

  // Reload printers when config syncs
  useEffect(() => {
    const update = () => {
      try { setPrinters(JSON.parse(localStorage.getItem('rpos-printers') || '[]')); } catch {}
    };
    window.addEventListener('rpos-printers-updated', update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener('rpos-printers-updated', update); window.removeEventListener('storage', update); };
  }, []);

  // Load KDS devices from Supabase — also checks recent ticket activity as online signal
  const loadKDS = useCallback(async () => {
    if (!supabase) return;
    try {
      const locId = await getLocationId();
      if (!locId) return;
      const [devicesRes, ticketsRes] = await Promise.all([
        supabase.from('devices').select('id,name,type,last_seen,status,centre_id').eq('location_id', locId).eq('type', 'kds'),
        // Recent bumped tickets = KDS was actively used
        supabase.from('kds_tickets').select('bumped_at').eq('location_id', locId).not('bumped_at', 'is', null).order('bumped_at', { ascending: false }).limit(1),
      ]);
      setKdsDevices(devicesRes.data || []);
      const latestBump = ticketsRes.data?.[0]?.bumped_at ? new Date(ticketsRes.data[0].bumped_at).getTime() : 0;
      const s = {};
      (devicesRes.data || []).forEach(d => {
        const lastSeenAge = d.last_seen ? Date.now() - new Date(d.last_seen).getTime() : Infinity;
        const bumpAge = latestBump ? Date.now() - latestBump : Infinity;
        // Online if seen within 15min OR if tickets were bumped within 10min
        s[d.id] = (lastSeenAge < ONLINE_THRESHOLD_MS || bumpAge < 10 * 60 * 1000) ? 'online' : 'offline';
      });
      setStatuses(prev => ({ ...prev, ...s }));
    } catch {}
  }, []);

  // Load printer health from printer_health table — persistent, realtime
  const checkPrinterStatuses = useCallback(async () => {
    if (!supabase || !printers.length) return;
    try {
      const locId = await getLocationId();
      if (!locId) return;

      // First try printer_health table (persistent, updated by agent)
      const { data: health } = await supabase
        .from('printer_health')
        .select('printer_id, status, last_success_at, last_error_at, last_error, consecutive_failures')
        .eq('location_id', locId);

      if (health?.length) {
        const s = {};
        printers.forEach(printer => {
          const h = health.find(r => r.printer_id === printer.id);
          if (!h) { s[printer.id] = 'unknown'; return; }
          // If last success was within 10min and no failures since, show online
          const successAge = h.last_success_at ? Date.now() - new Date(h.last_success_at).getTime() : Infinity;
          if (h.status === 'online' && successAge < 10 * 60000) s[printer.id] = 'online';
          else if (h.consecutive_failures >= 2) s[printer.id] = 'offline';
          else if (h.status === 'error') s[printer.id] = 'offline';
          else s[printer.id] = h.status || 'unknown';
        });
        setStatuses(prev => ({ ...prev, ...s }));
        return;
      }

      // Fallback: infer from recent print_jobs
      const { data } = await supabase
        .from('print_jobs')
        .select('printer_id, status, created_at')
        .in('printer_id', printers.map(p => p.id))
        .order('created_at', { ascending: false })
        .limit(50);
      const s = {};
      printers.forEach(printer => {
        const jobs = (data || []).filter(j => j.printer_id === printer.id);
        if (!jobs.length) { s[printer.id] = 'unknown'; return; }
        const latest = jobs[0];
        const age = Date.now() - new Date(latest.created_at).getTime();
        if (latest.status === 'done' && age < 10 * 60000) s[printer.id] = 'online';
        else if (latest.status === 'failed') s[printer.id] = 'offline';
        else if (latest.status === 'pending' && age > 60000) s[printer.id] = 'unknown';
        else s[printer.id] = 'unknown';
      });
      setStatuses(prev => ({ ...prev, ...s }));
    } catch {}
  }, [printers]);

  useEffect(() => { loadKDS(); checkPrinterStatuses(); }, [loadKDS, checkPrinterStatuses]);
  useEffect(() => {
    const id = setInterval(() => { loadKDS(); checkPrinterStatuses(); }, 15000);
    return () => clearInterval(id);
  }, [loadKDS, checkPrinterStatuses]);

  // Load print queue (pending/failed/failed_permanent — skip done & dismissed)
  const loadJobs = useCallback(async () => {
    if (!supabase) { setJobsLoading(false); return; }
    setJobsLoading(true);
    try {
      const locId = await getLocationId();
      if (!locId) { setJobsLoading(false); return; }
      const { data } = await supabase
        .from('print_jobs')
        .select('id,printer_id,printer_ip,job_type,status,error,error_message,created_at,attempts,max_attempts,next_retry_at')
        .eq('location_id', locId)
        .in('status', ['pending','claimed','sending','failed','failed_permanent'])
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(30);
      setPrintJobs(data || []);
    } catch {}
    setJobsLoading(false);
  }, []);

  useEffect(() => {
    loadJobs();
    if (!supabase) return;
    const ch = supabase.channel('status-drawer-jobs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs' }, loadJobs)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [loadJobs]);

  // Which print path this device has: the native bridge, an iPad build without one, or a
  // browser. Every failure message below says what that means in plain words.
  const printEnv = printEnvironment();

  // Test printer
  const testPrinter = async (printer) => {
    setTestState(s => ({ ...s, [printer.id]: 'testing' }));
    setTestMsg(m => ({ ...m, [printer.id]: 'Sending test page…' }));
    setTestErr(e => ({ ...e, [printer.id]: null }));
    try {
      const result = await printService.printTestPage(printer);
      const jobId = result?.jobId;
      if (result?.ok === false) {
        // v5.8.84: a direct print that failed used to show "Job queued". Say what happened.
        setTestState(s => ({ ...s, [printer.id]: 'failed' }));
        // This device tried the printer itself, so the words can name this device.
        setTestMsg(m => ({ ...m, [printer.id]: null }));
        setTestErr(e => ({ ...e, [printer.id]: { raw: result.error || '', device: printerViewingDevice() } }));
        setStatuses(prev => ({ ...prev, [printer.id]: 'offline' }));
      } else if (result?.transport === 'native' || result?.transport === 'idempotent') {
        setTestState(s => ({ ...s, [printer.id]: 'ok' }));
        setTestMsg(m => ({ ...m, [printer.id]: '✓ Sent to the printer. Check the page came out.' }));
        setStatuses(prev => ({ ...prev, [printer.id]: 'online' }));
      } else if (jobId) {
        setTestMsg(m => ({ ...m, [printer.id]: 'Waiting for the printer (20s)…' }));
        await new Promise(resolve => {
          // The 20 second timer is cleared once the job answers. It used to fire anyway and
          // turn a printed test into "did not answer" 20 seconds later.
          let timer = null;
          const unsub = printService.watchJob(jobId, (updated) => {
            if (updated.status === 'done') {
              clearTimeout(timer);
              setTestState(s => ({ ...s, [printer.id]: 'ok' }));
              setTestMsg(m => ({ ...m, [printer.id]: '✓ Printed successfully' }));
              setStatuses(prev => ({ ...prev, [printer.id]: 'online' }));
              unsub(); resolve();
            } else if (updated.status === 'failed') {
              clearTimeout(timer);
              setTestState(s => ({ ...s, [printer.id]: 'failed' }));
              // Another till printed this job, so only the text itself says which device tried.
              setTestMsg(m => ({ ...m, [printer.id]: null }));
              setTestErr(e => ({ ...e, [printer.id]: { raw: updated.error_message || updated.error || 'Printer error. Check paper and power.', device: null } }));
              setStatuses(prev => ({ ...prev, [printer.id]: 'offline' }));
              unsub(); resolve();
            }
          });
          timer = setTimeout(() => { unsub(); setTestState(s => ({ ...s, [printer.id]: 'timeout' })); setTestMsg(m => ({ ...m, [printer.id]: `✗ ${printFailureWords(printEnv)}` })); setStatuses(prev => ({ ...prev, [printer.id]: 'offline' })); resolve(); }, 20000);
        });
      } else {
        setTestState(s => ({ ...s, [printer.id]: 'ok' }));
        setTestMsg(m => ({ ...m, [printer.id]: '✓ Job queued' }));
      }
    } catch (err) {
      setTestState(s => ({ ...s, [printer.id]: 'failed' }));
      setTestMsg(m => ({ ...m, [printer.id]: null }));
      setTestErr(e => ({ ...e, [printer.id]: { raw: err?.message || '', device: printerViewingDevice() } }));
      setStatuses(prev => ({ ...prev, [printer.id]: 'offline' }));
    }
  };

  // Test KDS — send a test ticket to the device's specific centre
  const testKDS = async (device) => {
    setTestState(s => ({ ...s, [device.id]: 'testing' }));
    setTestMsg(m => ({ ...m, [device.id]: 'Sending test ticket…' }));
    try {
      const { insertKDSTicket } = await import('../lib/db.js');
      const locId = await getLocationId();
      // Get the device's centre_id so the KDS actually receives it
      let centreId = device.centre_id || null;
      if (!centreId && supabase) {
        const { data } = await supabase.from('devices').select('centre_id').eq('id', device.id).single();
        centreId = data?.centre_id || null;
      }
      const testTicket = {
        id: `kds-test-${Date.now()}`,
        tableLabel: 'TEST',
        tableId: null,
        server: 'System test',
        covers: 1,
        centreId,         // camelCase — insertKDSTicket maps this to centre_id
        items: [{ name: 'KDS Test Ticket', qty: 1, mods: [], notes: 'Test — dismiss when done', course: 1 }],
        sentAt: Date.now(),
        status: 'pending',
      };
      const { error } = await insertKDSTicket(testTicket, locId);
      if (error) throw new Error(error.message);
      setTestState(s => ({ ...s, [device.id]: 'ok' }));
      setTestMsg(m => ({ ...m, [device.id]: `✓ Test ticket sent to ${device.name}` }));
    } catch (err) {
      setTestState(s => ({ ...s, [device.id]: 'failed' }));
      setTestMsg(m => ({ ...m, [device.id]: `✗ ${err.message}` }));
    }
  };

  const retryJob = async (job) => {
    if (!supabase) return;
    // Use orchestrator helper — resets attempts, next_retry_at, dismissed_at, claim fields
    try {
      const { operatorRetryJob } = await import('../sync/PrintOrchestrator.js');
      await operatorRetryJob(job.id);
    } catch {
      // Fallback to legacy path if orchestrator module unavailable for any reason
      // (fence stage 1, fix round 2: counted, and kept while this till is not linked)
      await mustChangeRow({ table: 'print_jobs', type: 'update', payload: { status: 'pending', error: null, error_message: null }, match: { id: job.id }, kind: 'print_job', label: 'Print job retry' });
    }
    loadJobs();
  };

  const dismissJob = async (job) => {
    if (!supabase) return;
    try {
      const { operatorDismissJob } = await import('../sync/PrintOrchestrator.js');
      await operatorDismissJob(job.id);
    } catch {
      await mustChangeRow({ table: 'print_jobs', type: 'update', payload: { status: 'dismissed', dismissed_at: new Date().toISOString() }, match: { id: job.id }, kind: 'print_job', label: 'Print job dismissed' });
    }
    loadJobs();
  };

  const timeSince = (ts) => {
    if (!ts) return 'never';
    const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins/60)}h ${mins%60}m ago`;
    return `${Math.floor(mins/1440)}d ago`;
  };

  const sc = (s) => ({ online:'var(--grn)', offline:'var(--red)', checking:'var(--acc)', unknown:'var(--t4)' }[s]||'var(--t4)');
  const sbg = (s) => ({ online:'var(--grn-d)', offline:'var(--red-d)', checking:'var(--acc-d)', unknown:'var(--bg3)' }[s]||'var(--bg3)');
  const sbdr = (s) => ({ online:'var(--grn-b)', offline:'var(--red-b)', checking:'var(--acc-b)', unknown:'var(--bdr)' }[s]||'var(--bdr)');
  const tc = (s) => ({ ok:'var(--grn)', failed:'var(--red)', timeout:'var(--red)' }[s]||'var(--acc)');

  const printerForId = (id) => printers.find(p => p.id === id);
  const hasIssues = [...printers, ...kdsDevices].some(d => statuses[d.id] === 'offline') || printJobs.some(j => j.status === 'failed');

  // Plain words for each print queue row. The steps are listed once per printer and fault,
  // on the newest row, so five failed tickets do not repeat the same list five times.
  const jobHelp = {};
  const helpListed = new Set();
  printJobs.forEach(job => {
    const raw = job.error_message || job.error || '';
    const isStale = job.status === 'pending' && Date.now() - new Date(job.created_at).getTime() > 30000;
    if (!raw && !isStale) return;
    const printer = printerForId(job.printer_id);
    const help = printerErrorGuidance(raw, { ip: job.printer_ip || printer?.address, port: printer?.port || 9100, env: printEnv });
    const key = `${job.printer_id || job.printer_ip}:${help.kind}`;
    jobHelp[job.id] = { ...help, listSteps: help.steps.length > 0 && !helpListed.has(key) };
    helpListed.add(key);
  });

  const TestBtn = ({ id, onTest, icon }) => {
    const ts = testState[id];
    return (
      <button
        onClick={onTest}
        disabled={ts === 'testing'}
        style={{ padding:'3px 10px', borderRadius:8, cursor:ts==='testing'?'default':'pointer', fontFamily:'inherit', fontSize:10, fontWeight:700, border:'1px solid var(--bdr)', background:'var(--bg2)', color:'var(--t2)', transition:'all .1s', flexShrink:0 }}>
        {ts === 'testing' ? '⏳' : `${icon} Test`}
      </button>
    );
  };

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:200, backdropFilter:'blur(2px)' }}/>
      <div style={{ position:'fixed', left:58, top:0, bottom:0, width:340, background:'var(--bg1)', borderRight:'1px solid var(--bdr)', zIndex:201, display:'flex', flexDirection:'column', boxShadow:'4px 0 24px rgba(0,0,0,.25)', animation:'slideRight .2s cubic-bezier(.2,.8,.3,1)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'16px 18px 14px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Terminal status</div>
            <div style={{ fontSize:11, color:hasIssues?'var(--red)':'var(--t3)', marginTop:2 }}>
              {hasIssues ? '⚠ Hardware issues detected' : '✓ Systems operational'}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22 }}>×</button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'14px 18px' }}>

          {/* Device profile */}
          <Section label="Device profile">
            {deviceConfig ? (
              <div style={{ padding:'12px 14px', background:'var(--bg3)', borderRadius:12, border:'1px solid var(--bdr)' }}>
                <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:5 }}>{deviceConfig.profileName || 'Custom config'}</div>
                <Row label="Screen" value={deviceConfig.defaultSurface}/>
                <Row label="Order types" value={(deviceConfig.enabledOrderTypes||[]).join(', ')}/>
                <Row label="Table service" value={deviceConfig.tableServiceEnabled ? '✓ On' : '✕ Off'}/>
              </div>
            ) : (
              <div style={{ padding:'12px 14px', background:'var(--red-d)', borderRadius:12, border:'1px solid var(--red-b)', fontSize:12, color:'var(--red)', fontWeight:600 }}>
                No profile assigned — configure in Back Office → Device Profiles
              </div>
            )}
          </Section>

          {/* Printers */}
          <Section label="Printers">
            <div style={{ fontSize:11, fontWeight:600, color: printEnv === 'native' ? 'var(--grn)' : 'var(--red)', marginBottom:8 }}>
              {printPathIndicator(printEnv)}
            </div>
            {printers.length === 0 ? (
              <div style={{ fontSize:11, color:'var(--t4)', padding:'4px 0' }}>No printers configured. Add one in Back Office, Printers.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {printers.map(printer => {
                  const st = statuses[printer.id] || 'unknown';
                  const ts = testState[printer.id];
                  const msg = testMsg[printer.id];
                  const err = testErr[printer.id];
                  const spec = resolvePrinterSpec(printer);
                  return (
                    <div key={printer.id} style={{ padding:'11px 14px', borderRadius:12, border:`1px solid ${sbdr(st)}`, background:sbg(st) }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ fontSize:18, flexShrink:0 }}>🖨</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
                            {printer.name}
                            {(printer.roles||[]).map(r => <span key={r} style={{ fontSize:8, padding:'1px 5px', borderRadius:4, background:'var(--bg4)', color:'var(--t4)', border:'1px solid var(--bdr)', fontWeight:700 }}>{r}</span>)}
                          </div>
                          <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{spec.modelLabel} · {spec.dialectLabel} · {printer.address}</div>
                        </div>
                        <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                            <div style={{ width:7, height:7, borderRadius:'50%', background:sc(st), boxShadow:st==='online'?`0 0 5px ${sc(st)}`:undefined }}/>
                            <span style={{ fontSize:10, fontWeight:700, color:sc(st), textTransform:'uppercase' }}>{st}</span>
                          </div>
                          <TestBtn id={printer.id} onTest={() => testPrinter(printer)} icon="🖨"/>
                        </div>
                      </div>
                      {err ? (
                        <div style={{ marginTop:6, paddingTop:6, borderTop:'1px solid var(--bdr)' }}>
                          <PrinterErrorHelp guidance={printerErrorGuidance(err.raw, { ip: printer.address, port: printer.port || 9100, device: err.device, env: printEnv })}/>
                        </div>
                      ) : msg && (
                        <div style={{ fontSize:10, marginTop:6, color:tc(ts), fontWeight:600, paddingTop:6, borderTop:'1px solid var(--bdr)' }}>{msg}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* KDS Screens */}
          <Section label="Kitchen displays (KDS)">
            {kdsDevices.length === 0 ? (
              <div style={{ fontSize:11, color:'var(--t4)', padding:'4px 0' }}>No KDS devices registered — pair a KDS terminal in Back Office → Devices</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {kdsDevices.map(device => {
                  const st = statuses[device.id] || 'unknown';
                  const ts = testState[device.id];
                  const msg = testMsg[device.id];
                  return (
                    <div key={device.id} style={{ padding:'11px 14px', borderRadius:12, border:`1px solid ${sbdr(st)}`, background:sbg(st) }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ fontSize:18, flexShrink:0 }}>📺</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{device.name}</div>
                          <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>
                            Last seen: {timeSince(device.last_seen)}
                          </div>
                        </div>
                        <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                            <div style={{ width:7, height:7, borderRadius:'50%', background:sc(st), boxShadow:st==='online'?`0 0 5px ${sc(st)}`:undefined }}/>
                            <span style={{ fontSize:10, fontWeight:700, color:sc(st), textTransform:'uppercase' }}>{st}</span>
                          </div>
                          <TestBtn id={device.id} onTest={() => testKDS(device)} icon="📺"/>
                        </div>
                      </div>
                      {msg && (
                        <div style={{ fontSize:10, marginTop:6, color:tc(ts), fontWeight:600, paddingTop:6, borderTop:'1px solid var(--bdr)' }}>{msg}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Card readers — bluetooth (this POS) + network (location) */}
          <Section label="Card readers">
            <StatusDrawerCardReaders/>
          </Section>

          {/* Print queue — pending/failed only */}
          <Section label={`Print queue${printJobs.length > 0 ? ` · ${printJobs.length} issue${printJobs.length!==1?'s':''}` : ''}`}>
            {jobsLoading ? (
              <div style={{ fontSize:11, color:'var(--t4)', padding:'4px 0' }}>Loading…</div>
            ) : printJobs.length === 0 ? (
              <div style={{ fontSize:11, color:'var(--t4)', padding:'4px 0' }}>No pending or failed jobs</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {printJobs.map(job => {
                  const printer = printerForId(job.printer_id);
                  const isStale = job.status === 'pending' && Date.now() - new Date(job.created_at).getTime() > 30000;
                  const effectiveStatus = isStale ? 'failed' : job.status;
                  const permanent = effectiveStatus === 'failed_permanent';
                  const jsc = permanent ? 'var(--red)' : { done:'var(--grn)', failed:'var(--red)', pending:'var(--acc)', claimed:'var(--acc)', sending:'var(--acc)', printing:'var(--acc)' }[effectiveStatus] || 'var(--t4)';
                  const borderColor = permanent ? 'var(--red)' : effectiveStatus === 'failed' ? 'var(--red-b)' : 'var(--bdr)';
                  const help = jobHelp[job.id];
                  const attemptsText = job.attempts ? `attempt ${job.attempts}${job.max_attempts ? `/${job.max_attempts}` : ''}` : null;
                  return (
                    <div key={job.id} style={{ padding:'9px 12px', borderRadius:10, background: permanent ? 'rgba(239,68,68,0.08)' : 'var(--bg3)', border:`1px solid ${borderColor}` }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:7, height:7, borderRadius:'50%', background:jsc, flexShrink:0 }}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:11, fontWeight:700, color:'var(--t1)' }}>
                            {permanent && <span style={{ color:'var(--red)', marginRight:6 }}>⚠ Action required:</span>}
                            {job.job_type?.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())} — {printer?.name || job.printer_ip}
                          </div>
                          <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>
                            {timeSince(job.created_at)}
                            {attemptsText && <span style={{ marginLeft:6, color:'var(--t3)' }}>· {attemptsText}</span>}
                            {help && <span style={{ color:'var(--red)', marginLeft:6 }}>· {help.title}</span>}
                          </div>
                        </div>
                        <span style={{ fontSize:10, fontWeight:700, color:jsc, textTransform:'uppercase', flexShrink:0 }}>{permanent ? 'FAILED' : effectiveStatus}</span>
                        {(effectiveStatus === 'failed' || permanent) && (
                          <>
                            <button onClick={() => retryJob(job)} style={{ padding:'2px 8px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', fontSize:10, fontWeight:700, background:'var(--acc)', border:'none', color:'#0b0c10', flexShrink:0 }}>Retry</button>
                            {permanent && (
                              <button onClick={() => dismissJob(job)} style={{ padding:'2px 8px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', fontSize:10, fontWeight:700, background:'var(--bg4)', border:'1px solid var(--bdr)', color:'var(--t2)', flexShrink:0 }}>Dismiss</button>
                            )}
                          </>
                        )}
                      </div>
                      {help && (help.listSteps || help.raw) && (
                        <div style={{ marginTop:6, paddingTop:6, borderTop:'1px solid var(--bdr)' }}>
                          <PrinterErrorHelp guidance={help} showTitle={false} showSteps={help.listSteps} size={10}/>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button onClick={loadJobs} style={{ fontSize:10, color:'var(--t4)', background:'none', border:'none', cursor:'pointer', padding:'4px 0', fontFamily:'inherit', textAlign:'left' }}>↻ Refresh</button>
              </div>
            )}
          </Section>

          {/* Terminal info */}
          <Section label="Terminal">
            <div style={{ padding:'10px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
              <Row label="Device" value={deviceConfig?.terminalName || 'POS'}/>
              <Row label="Version" value={`v${VERSION}`}/>
            </div>
          </Section>

        </div>

        <div style={{ padding:'12px 18px', borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
          <button onClick={() => { setAppMode('backoffice'); onClose(); }} style={{ width:'100%', padding:'10px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            ⚙ Open Back Office
          </button>
        </div>
      </div>
    </>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>{label}</div>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3 }}>
      <span style={{ color:'var(--t4)' }}>{label}</span>
      <span style={{ color:'var(--t2)', fontWeight:500 }}>{value}</span>
    </div>
  );
}
