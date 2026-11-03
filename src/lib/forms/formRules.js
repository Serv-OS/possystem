// src/lib/forms/formRules.js
// Marketing forms (5.12.40): the app's door to the shared rules. The rules live in
// supabase/functions/_shared/formRules.js so the form-submit and marketing-forms functions,
// the public site (api/site.js, api/form.js), the Back Office and the tests read one file.
export * from '../../../supabase/functions/_shared/formRules.js';
