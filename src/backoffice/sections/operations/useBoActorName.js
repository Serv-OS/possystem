// useBoActorName: the name Back Office puts on what it records in Operations (28 Sep 2026).
// The signed in staff member's name when the store has one, else the login's email.
import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase, isMock } from '../../../lib/supabase';

export function useBoActorName() {
  const staff = useStore((s) => s.staff);
  const [email, setEmail] = useState('');
  useEffect(() => {
    let live = true;
    if (!isMock && supabase?.auth?.getUser) {
      supabase.auth.getUser()
        .then(({ data }) => { if (live) setEmail(data?.user?.email || ''); })
        .catch(() => { /* no name is fine: the row just shows no uploader */ });
    }
    return () => { live = false; };
  }, []);
  return staff?.name || email || null;
}
