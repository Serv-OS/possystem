// src/lib/msm/msmApi.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the data layer wired to the real Ops client and the
// saveHealth banner. Screens import THIS; tests drive createMsmData (msmData.js) with a stand in.

import { supabase } from '../supabase';
import { reportSave } from '../saveHealth';
import { createMsmData } from './msmData.js';

export const msmApi = createMsmData({ client: supabase, report: reportSave });
export default msmApi;
