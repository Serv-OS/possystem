// src/backoffice/sections/MenuNameBox.jsx
//
// 5.12.121 (Peter, 27 Nov 2026: "how do i rename a menu?"). The Menu name box at the top of a
// menu's "Edit menu settings" panel in Menu manager. Type the name, then Enter, Rename, or click
// away: it saves through the store's updateMenu(id, { name }) like the other fields of the panel.
// A blank name, and a name another menu at this site has, are refused in words under the box.
// The rules, and why a rename is safe for the POS, the pages and the Multi site menu, are in
// lib/menuRename.js.

import { useState } from 'react';
import { useStore } from '../../store';
import { renameMenu, menuNameProblem, cleanMenuName, MENU_NAME_MAX } from '../../lib/menuRename';

const box = { background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:6, padding:'5px 7px', color:'var(--t1)', fontFamily:'inherit', fontSize:12, outline:'none', minWidth:0 };

export default function MenuNameBox({ menu }) {
  const menus = useStore(s => s.menus);
  const updateMenu = useStore(s => s.updateMenu);
  const markBOChange = useStore(s => s.markBOChange);
  const showToast = useStore(s => s.showToast);
  // null = showing the saved name; a string = what the person has typed and not saved yet.
  const [typed, setTyped] = useState(null);
  const [refused, setRefused] = useState('');
  const value = typed ?? (menu.name || '');
  const dirty = typed !== null && cleanMenuName(typed) !== String(menu.name ?? '');
  // The reason shows as soon as the name is one that cannot be saved, not only after a try.
  const problem = dirty ? menuNameProblem(menus, menu.id, typed) : '';
  const words = problem || refused;

  const save = () => {
    if (typed === null) return;
    const out = renameMenu(menus, menu.id, typed, { updateMenu, markBOChange });
    if (!out.ok) { setRefused(out.words); return; }
    setRefused(''); setTyped(null);
    if (out.changed) showToast(`"${out.was}" is now "${out.name}"`, 'success');
  };
  const undo = () => { setTyped(null); setRefused(''); };

  return (
    <div style={{ marginBottom:10, paddingBottom:8, borderBottom:'1px solid var(--bdr)' }}>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Menu name</div>
      <div style={{ display:'flex', gap:5, alignItems:'center' }}>
        <input value={value} maxLength={MENU_NAME_MAX} aria-label="Menu name" aria-invalid={!!words}
          onChange={e => { setTyped(e.target.value); setRefused(''); }}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') undo(); }}
          onBlur={save}
          style={{ ...box, flex:1, borderColor: words ? 'var(--red)' : 'var(--bdr)' }} />
        {dirty && (
          <button onMouseDown={e => e.preventDefault()} onClick={save} disabled={!!problem}
            style={{ padding:'5px 8px', fontSize:10, fontWeight:700, borderRadius:5, border:'none', background:'var(--acc)', color:'#0b0c10', cursor: problem ? 'default' : 'pointer', fontFamily:'inherit', opacity: problem ? .45 : 1, flexShrink:0 }}>
            Rename
          </button>
        )}
      </div>
      {words
        ? <div role="alert" style={{ fontSize:10, color:'var(--red)', lineHeight:1.45, marginTop:5 }}>{words} The name was not changed.</div>
        : dirty && <div style={{ fontSize:10, color:'var(--t4)', lineHeight:1.45, marginTop:5 }}>Press Enter or Rename to save. Esc puts the old name back.</div>}
    </div>
  );
}
