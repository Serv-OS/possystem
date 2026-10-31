// src/lib/website/publishTerms.js
//
// The Website Builder publishing terms (5.12.1). Shown in full before a site is published for
// the first time, and again whenever PUBLISH_TERMS_VERSION changes. Acceptance is recorded on
// the site (settings.publish_terms) by the website-admin publish action, never by the browser.
// Plain English, no abbreviations the reader has not been given, no em dashes.

import { PUBLISH_TERMS_VERSION, publishTermsAccepted } from '../../../supabase/functions/_shared/websiteRules.js';

export { PUBLISH_TERMS_VERSION, publishTermsAccepted };

export const PUBLISH_TERMS = Object.freeze({
  version: PUBLISH_TERMS_VERSION,
  title: 'Website Builder publishing terms',
  intro: 'Please read these terms before you publish. By ticking the box and pressing Accept and publish you confirm, on behalf of the business you are signed in for, that you have read, understood and agree to them.',
  sections: Object.freeze([
    {
      heading: '1. Accessibility and disability standards',
      body: 'The Website Builder and its AI designer generate layouts, text, images choices and code automatically. ServOS makes no representation and gives no warranty that any website created, generated or edited with the Website Builder meets any accessibility standard, guideline or law. This includes, without limitation, the Web Content Accessibility Guidelines (WCAG) at any level, the Equality Act 2010, the Americans with Disabilities Act (ADA), Section 508 of the Rehabilitation Act, the European Accessibility Act, the Accessibility for Ontarians with Disabilities Act (AODA) and any other national, state, provincial or local accessibility requirement. You are solely responsible for reviewing the published website, for testing it with the assistive technologies your customers use, and for bringing it to the standard that applies to your business.',
    },
    {
      heading: '2. Your content',
      body: 'You are responsible for everything the website shows and says, including menu items, prices, allergen and dietary information, opening hours, addresses, offers, images, blog posts and any custom code you enable. Text produced by the AI designer may be incomplete or wrong. You must check it before you publish and keep it accurate afterwards. ServOS is not responsible for any loss, claim or penalty that results from inaccurate, misleading or unlawful content on your website.',
    },
    {
      heading: '3. Compliance with law',
      body: 'You are responsible for the website complying with every law and regulation that applies to you and to your customers, including consumer protection and pricing rules, food information and allergen disclosure, data protection and privacy (such as the UK GDPR, the EU GDPR and the California Consumer Privacy Act), cookie and tracking rules, advertising and marketing standards, licensing, and the terms of any third party service that the website embeds, links to or relies on. ServOS does not provide legal advice and the Website Builder is not a substitute for it.',
    },
    {
      heading: '4. Intellectual property',
      body: 'You confirm that you own, or hold a valid licence for, every logo, photograph, font, trade mark, piece of text and other material that you upload, enter or ask the AI designer to use, and that publishing that material on the website does not infringe the rights of any person. You are responsible for any claim that it does.',
    },
    {
      heading: '5. Domains, hosting and third parties',
      body: 'A custom domain is bought, owned and renewed by you, and you remain responsible for it at all times. ServOS attaches the domain to your website on your instruction but is not responsible for registrar, nameserver or certificate problems outside its own systems, for the availability of the registrar or of any other third party service, or for any interruption to the website caused by them.',
    },
    {
      heading: '6. No guarantee of results',
      body: 'ServOS does not promise that the website will achieve any search engine ranking, visibility, traffic, enquiries, bookings, orders, revenue or other result. Search engines decide what they index and how they rank it, and their rules change.',
    },
    {
      heading: '7. Limitation of liability and indemnity',
      body: 'To the fullest extent permitted by law, ServOS, its directors, officers, employees, agents and suppliers accept no liability for any claim, demand, loss, damage, fine, penalty, cost or expense (including legal fees) that arises from or in connection with the website, its content, its accessibility, or its compliance or non compliance with any law, regulation or standard. You agree to indemnify and hold harmless ServOS against any claim brought by a third party, including any claim under accessibility or disability discrimination law, that arises from your website. Nothing in these terms excludes or limits any liability that cannot be excluded or limited by law, including liability for death or personal injury caused by negligence, or for fraud.',
    },
    {
      heading: '8. Taking the website down',
      body: 'ServOS may take a website offline, or refuse to publish it, where it reasonably believes the website breaks the law, infringes the rights of any person, exposes ServOS to a claim, or breaches your ServOS service agreement. Where it is reasonable to do so ServOS will tell you first and give you the chance to fix the problem.',
    },
    {
      heading: '9. Changes and record of acceptance',
      body: 'ServOS may update these terms. You will be asked to accept the new version before your next publish, and the website stays live in the meantime. Your acceptance is recorded with the date, the time, the version of the terms and the signed in user who accepted them.',
    },
  ]),
  closing: 'These terms are additional to, and form part of, your ServOS service agreement. If these terms and the service agreement conflict, the service agreement prevails.',
});

/** The whole statement as plain text, for an email, a PDF or a record. */
export function publishTermsText(terms = PUBLISH_TERMS) {
  const parts = [terms.title, `Version ${terms.version}`, '', terms.intro, ''];
  for (const s of terms.sections) parts.push(s.heading, s.body, '');
  parts.push(terms.closing);
  return parts.join('\n');
}
