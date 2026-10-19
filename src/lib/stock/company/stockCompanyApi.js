// src/lib/stock/company/stockCompanyApi.js
//
// MULTI SITE STOCK, Phase 1 (v5.11.80): the Shared stock data layer wired to the real Ops client and
// the saveHealth banner. Screens import THIS; tests drive createStockCompanyData with a stand in.

import { supabase } from '../../supabase';
import { reportSave } from '../../saveHealth';
import { createStockCompanyData } from './stockCompanyData.js';

export const stockCompanyApi = createStockCompanyData({ client: supabase, report: reportSave });
export default stockCompanyApi;
