import { supabase } from '../supabase';
import { createStockReportsApi } from './reportsData.js';
export const stockReportsApi = createStockReportsApi(supabase);
