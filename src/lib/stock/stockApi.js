import { supabase } from '../supabase';
import { createStockApi } from './companyData.js';
export const stockApi = createStockApi(supabase);
